import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { repairClosings } from './closing.js';
import { applyPaymentEvidence, pence, tipRefundedReason, transaction } from './checkouts.js';

interface Resource {
  id?: string; custom_id?: string; status?: string; create_time?: string;
  amount?: { value?: string; currency_code?: string };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
  purchase_units?: Array<{ custom_id?: string }>;
  links?: Array<{ rel?: string; href?: string }>;
}
interface Event { id: string; event_type: string; resource: Resource }

export function webhookProcessor(app: FastifyInstance, db: Pool, now: () => Date, notify: (stallId: string) => void) {
  // Receipt and timer can overlap; one worker per event keeps retries from racing each other.
  const processing = new Map<string, Promise<void>>();
  async function apply(event: Event) {
    if (!['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REFUNDED'].includes(event.event_type)) return;
    const r = event.resource;
    const orderId = r.supplementary_data?.related_ids?.order_id ?? (event.event_type === 'CHECKOUT.ORDER.APPROVED' ? r.id : undefined);
    const customId = r.custom_id ?? r.purchase_units?.[0]?.custom_id;
    const captureLink = r.links?.find(link => link.rel === 'up')?.href;
    const captureId = r.supplementary_data?.related_ids?.capture_id ?? captureLink?.match(/\/v2\/payments\/captures\/([^/?#]+)$/)?.[1];
    let c = orderId ? (await db.query<{ id: string; paypal_order_id: string | null; stall_id: string; kind: string }>('select id,paypal_order_id,stall_id,kind from checkouts where paypal_order_id=$1', [orderId])).rows[0] : undefined;
    if (!c && customId) c = (await db.query('select id,paypal_order_id,stall_id,kind from checkouts where id::text=$1', [customId])).rows[0];
    if (!c && !orderId && !customId && captureId && event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      c = (await db.query('select c.id,c.paypal_order_id,c.stall_id,c.kind from checkouts c join captures cap on cap.checkout_id=c.id where cap.paypal_capture_id=$1', [captureId])).rows[0];
    }
    if (!c || !c.paypal_order_id) throw new Error('Unmatched PayPal event');
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
      await db.query('update checkouts set approved_at=coalesce(approved_at,$2) where id=$1', [c.id, now()]);
      return;
    }
    if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED') {
      const amount = pence(r.amount?.value);
      if (!r.id || !captureId || !amount || r.amount?.currency_code !== 'GBP' || r.status !== 'COMPLETED') throw new Error('Refund evidence is incomplete');
      await transaction(db, async tx => {
        await tx.query('select id from checkouts where id=$1 for update', [c.id]);
        const capture = (await tx.query<{ amount_pence: number }>('select amount_pence from captures where paypal_capture_id=$1 and checkout_id=$2', [captureId, c.id])).rows[0];
        if (!capture) throw new Error('Refund capture not recorded yet');
        const existing = (await tx.query('select * from refunds where paypal_refund_id=$1', [r.id])).rows[0];
        if (existing) {
          if (existing.paypal_capture_id !== captureId || existing.amount_pence !== amount) throw new Error('Conflicting refund evidence');
          return;
        }
        const refunded = Number((await tx.query("select coalesce(sum(amount_pence),0) as total from refunds where paypal_capture_id=$1 and status='COMPLETED'", [captureId])).rows[0].total);
        if (refunded + amount > capture.amount_pence) throw new Error('Refund exceeds captured amount');
        await tx.query("insert into refunds(paypal_refund_id,paypal_capture_id,amount_pence,status) values ($1,$2,$3,'COMPLETED')", [r.id, captureId, amount]);
        // A tip never held the item, so a refunded tip withdraws nothing.
        await tx.query('update checkouts set review_required=true,review_reason=$2 where id=$1', [c.id, c.kind === 'tip' ? tipRefundedReason : 'Payment refunded. Collection withdrawn.']);
      });
      notify(c.stall_id);
      return;
    }
    await applyPaymentEvidence(db, c.id, {
      id: orderId ?? c.paypal_order_id,
      purchase_units: [{ custom_id: customId ?? c.id, payments: { captures: [{ id: r.id, status: r.status, amount: r.amount, create_time: r.create_time }] } }],
    }, { verifiedAt: now(), notify });
  }
  async function process(eventId: string) {
    const active = processing.get(eventId);
    if (active) return active;
    const task = (async () => {
      const row = (await db.query<{ raw_body: string; attempts: number }>("select raw_body,attempts from webhook_inbox where event_id=$1 and state='pending'", [eventId])).rows[0];
      if (!row) return;
      try {
        await apply(JSON.parse(row.raw_body) as Event);
        await db.query("update webhook_inbox set state='processed',processed_at=$2,last_error=null,attempts=attempts+1 where event_id=$1", [eventId, now()]);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Webhook processing failed';
        app.log.warn({ eventId, error: message }, 'PayPal event awaiting repair');
        const retryAt = new Date(now().getTime() + Math.min(30_000 * 2 ** Math.min(row.attempts, 7), 3_600_000));
        await db.query('update webhook_inbox set attempts=attempts+1,last_error=$2,next_attempt_at=$3 where event_id=$1', [eventId, message, retryAt]);
      }
    })();
    processing.set(eventId, task);
    try { await task; } finally { processing.delete(eventId); }
  }
  let running: Promise<void> | undefined;
  function repair() {
    if (running) return running;
    running = (async () => {
      const { rows } = await db.query<{ event_id: string }>("select event_id from webhook_inbox where state='pending' and next_attempt_at <= $1 order by next_attempt_at limit 100", [now()]);
      for (const row of rows) await process(row.event_id);
      await repairClosings(db, now());
    })().catch(error => { app.log.error({ error: error instanceof Error ? error.message : 'Unknown' }, 'Webhook repair failed'); }).finally(() => { running = undefined; });
    return running;
  }
  app.addHook('onClose', async () => { await running; await Promise.all(processing.values()); });
  return { process, repair };
}
