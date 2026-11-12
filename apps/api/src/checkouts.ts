import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { PAY_WHAT_YOU_WANT_MAX_PENCE, pounds, pricingItem, validateAmount, validateOffer } from './pricing.js';
import { PayPal, PayPalError } from './paypal.js';

type State = 'creating' | 'awaiting_approval' | 'capturing' | 'checking' | 'paid' | 'expired' | 'cancelled' | 'failed';
interface Checkout {
  id: string; stall_id: string; trading_session_id: string; buyer_session_id: string; state: State;
  total_pence: number; checkout_key: string; create_request_id: string; capture_request_id: string;
  paypal_order_id: string | null; reservation_deadline: Date; review_required: boolean; review_reason: string | null;
  approved_at: Date | null; capture_started_at: Date | null; kind: 'sale' | 'tip';
}
interface Line { item_id: string; code: string; name: string; amount_pence: number }
export const active = "('creating','awaiting_approval','capturing','checking')";
const refuse = (refused: string, status = 422) => ({ refused, status });
export const takenByAnother = 'Someone else has already taken this. Please leave it for them.';
export const tipRefundedReason = 'Tip refunded. The item stays taken.';
const publicCheckout = (c: Checkout) => ({ checkoutId: c.id, state: c.state, totalPence: c.total_pence,
  paypalOrderId: c.paypal_order_id, reservedUntil: c.reservation_deadline, reviewRequired: c.review_required, approvedAt: c.approved_at, kind: c.kind, tipRefunded: c.review_reason === tipRefundedReason });
const failureLog = (error: unknown, c: Checkout) => ({ errorType: error instanceof Error ? error.name : 'Unknown',
  ...(error instanceof PayPalError ? { status: error.status, debugId: error.debugId, issue: error.issue, operation: error.operation } : {}),
  checkoutId: c.id, paypalOrderId: c.paypal_order_id });

const repairLimitReason = 'Payment is still unresolved after 30 minutes. Check payment again or review it in PayPal.';
const abandonedCaptureMs = 3 * 60_000;

export async function transaction<T>(db: Pool, run: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  let unusable: Error | undefined;
  try { await tx.query('begin'); const result = await run(tx); await tx.query('commit'); return result; }
  // A client that cannot roll back, such as one whose query timed out, is closed rather than handed to the next request. The first error is the one reported.
  catch (error) { await tx.query('rollback').catch((failed: Error) => { unusable = failed; }); throw error; }
  finally { tx.release(unusable); }
}
async function release(tx: PoolClient, c: Checkout, state: State) {
  await tx.query('update checkouts set state=$2 where id=$1', [c.id, state]);
  await tx.query('update items set reserved_checkout_id=null, reserved_until=null where reserved_checkout_id=$1', [c.id]);
  c.state = state;
}
async function keepChecking(tx: PoolClient, c: Checkout) {
  if (c.state !== 'capturing') return;
  await tx.query("update checkouts set state='checking' where id=$1", [c.id]);
  c.state = 'checking';
}
async function expire(tx: PoolClient, c: Checkout, now: Date) {
  if (!c.review_required && ['creating', 'awaiting_approval'].includes(c.state) && c.reservation_deadline <= now) await release(tx, c, 'expired');
}
export async function expireReservations(db: Pool, stallId: string, now: Date) {
  await transaction(db, async tx => {
    const { rows } = await tx.query<Checkout>("select * from checkouts where stall_id=$1 and state in ('creating','awaiting_approval') and reservation_deadline <= $2 and not review_required order by id for update", [stallId, now]);
    for (const c of rows) await expire(tx, c, now);
  });
}
export async function buyerId(db: Pool, request: FastifyRequest) {
  const token = request.cookies.stallkeeper_buyer;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return (await db.query<{ id: string }>('select id from buyer_sessions where token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0]?.id;
}
export async function itemCheckout(db: Pool, buyer: string | undefined, itemId: string) {
  if (!buyer) return null;
  const c = (await db.query<Checkout>(`select c.* from checkouts c join checkout_lines l on l.checkout_id=c.id where c.buyer_session_id=$1 and l.item_id=$2 and (c.state in ${active} or c.state='paid' or c.review_required) order by c.created_at desc limit 1`, [buyer, itemId])).rows[0];
  return c ? publicCheckout(c) : null;
}

export function pence(amount: unknown) {
  if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount)) return undefined;
  const result = Number(amount.replace('.', ''));
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
interface Evidence {
  id?: string;
  status?: string;
  purchase_units?: Array<{ custom_id?: string; payments?: { captures?: Array<{
    id?: string; status?: string; amount?: { currency_code?: string; value?: string }; create_time?: string;
  }> } }>;
}

export async function applyPaymentEvidence(db: Pool, checkoutId: string, order: Evidence, options: { verifiedAt?: Date; notify?: (stallId: string) => void } = {}) {
  let stallId: string | undefined;
  const result = await transaction(db, async tx => {
    const session = await tx.query('select t.id from trading_sessions t join checkouts c on c.trading_session_id=t.id where c.id=$1 for key share of t', [checkoutId]);
    if (!session.rowCount) throw new Error('Checkout not found');
    const c = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [checkoutId])).rows[0]!;
    stallId = c.stall_id;
    const review = async (reason: string) => {
      const updated = await tx.query<{ state: State }>(`update checkouts set review_required=true, review_reason=$2, state=case when state in ${active} then 'checking' else state end where id=$1 returning state`, [c.id, reason]);
      c.review_required = true; c.review_reason = reason; c.state = updated.rows[0]!.state;
    };
    const units = order?.purchase_units;
    if (!order?.id || !Array.isArray(units) || !units.length || !units[0]?.custom_id) {
      await keepChecking(tx, c);
      return publicCheckout(c);
    }
    if (order.id !== c.paypal_order_id || units.length !== 1 || units[0]?.custom_id !== c.id) {
      await review('Payment order or checkout identity does not match.'); return publicCheckout(c);
    }
    const captures = units[0].payments?.captures;
    if (!Array.isArray(captures) || !captures.length) {
      await keepChecking(tx, c);
      return publicCheckout(c);
    }
    if (captures.length !== 1) { await review('Unexpected number of captures.'); return publicCheckout(c); }
    const capture = captures[0]!;
    if (!capture.id || capture.amount?.currency_code !== 'GBP' || pence(capture.amount.value) !== c.total_pence) {
      await review('Capture amount or currency does not match.'); return publicCheckout(c);
    }
    if (capture.status === 'DECLINED') {
      if (['capturing', 'checking'].includes(c.state) && (!c.review_required || c.review_reason === repairLimitReason)) {
        await tx.query('update checkouts set review_required=false,review_reason=null where id=$1', [c.id]);
        c.review_required = false; c.review_reason = null;
        await release(tx, c, 'failed');
      }
      return publicCheckout(c);
    }
    if (capture.status !== 'COMPLETED') {
      await keepChecking(tx, c);
      return publicCheckout(c);
    }
    const inserted = await tx.query(`insert into captures (paypal_capture_id,checkout_id,amount_pence,currency,status,captured_at,webhook_verified_at)
      values ($1,$2,$3,'GBP','COMPLETED',$4,$5) on conflict (paypal_capture_id) do update set observed_at=now(), webhook_verified_at=coalesce(captures.webhook_verified_at,excluded.webhook_verified_at)
      where captures.checkout_id=excluded.checkout_id returning paypal_capture_id`, [capture.id, c.id, c.total_pence, capture.create_time ?? null, options.verifiedAt ?? null]);
    if (!inserted.rowCount) { await review('Capture belongs to another checkout.'); return publicCheckout(c); }
    const { rows: items } = await tx.query<{ id: string; status: string; reserved_checkout_id: string | null; sold_checkout_id: string | null }>(`select i.id,i.status,i.reserved_checkout_id,i.sold_checkout_id from items i join checkout_lines l on l.item_id=i.id where l.checkout_id=$1 order by i.id for update of i`, [c.id]);
    if (c.state === 'paid') return publicCheckout(c);
    // A tip is paid on an item that was taken before it started, so it holds no reservation and never sells the item.
    const tip = c.kind === 'tip';
    if (!['capturing', 'checking'].includes(c.state) || (!tip && (!items.length || items.some(i => i.status !== 'available' || i.reserved_checkout_id !== c.id)))) {
      if (!tip) await tx.query(`update items set reserved_checkout_id=$1,reserved_until=null
        where id in (select item_id from checkout_lines where checkout_id=$1)
        and status='available' and reserved_checkout_id is null`, [c.id]);
      await review(tip ? 'Completed capture without an active checkout.' : 'Completed capture without an active reservation.'); return publicCheckout(c);
    }
    if (c.review_required && c.review_reason !== repairLimitReason) return publicCheckout(c);
    await tx.query("update checkouts set state='paid',review_required=false,review_reason=null where id=$1", [c.id]);
    if (!tip) await tx.query("update items set status='sold', sold_checkout_id=$1, sold_at=now(), reserved_checkout_id=null, reserved_until=null where reserved_checkout_id=$1", [c.id]);
    const eventType = tip ? 'tip' : 'sale';
    await tx.query("insert into events (stall_id,trading_session_id,type,payload,business_key) values ($1,$2,$5,$3,$4) on conflict (business_key) do nothing", [c.stall_id, c.trading_session_id, JSON.stringify({ checkoutId: c.id, captureId: capture.id, totalPence: c.total_pence }), `${eventType}:${c.id}`, eventType]);
    c.state = 'paid'; c.review_required = false; c.review_reason = null; return publicCheckout(c);
  });
  if (stallId) options.notify?.(stallId);
  return result;
}

async function capturePayment(app: FastifyInstance, db: Pool, paypal: PayPal, c: Checkout, notify: (stallId: string) => void) {
  try {
    let evidence;
    try { evidence = await paypal.captureOrder(c.paypal_order_id!, c.capture_request_id); }
    catch (error) {
      if (error instanceof PayPalError && error.issue === 'ORDER_ALREADY_CAPTURED') evidence = await paypal.getOrder(c.paypal_order_id!);
      else throw error;
    }
    return await applyPaymentEvidence(db, c.id, evidence, { notify });
  } catch (error) {
    app.log.error(failureLog(error, c), 'PayPal capture did not complete');
    return transaction(db, async tx => {
      const current = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [c.id])).rows[0]!;
      if (current.state === 'capturing') {
        if (error instanceof PayPalError && (error.issue === 'INSTRUMENT_DECLINED' || error.issue === 'ORDER_NOT_APPROVED')) await release(tx, current, 'failed');
        else await keepChecking(tx, current);
      }
      return publicCheckout(current);
    });
  }
}

export function paymentRepair(app: FastifyInstance, db: Pool, paypal: PayPal, now: () => Date, notify: (stallId: string) => void) {
  const pending = new Map<string, Promise<boolean>>();
  function recheck(id: string) {
    const existing = pending.get(id);
    if (existing) return existing;
    const task = (async () => {
      const c = (await db.query<Checkout>('select * from checkouts where id=$1', [id])).rows[0];
      if (!c) return false;
      let checked = false;
      try {
        if (!c.paypal_order_id) throw new Error('Checkout has no PayPal order');
        const order: Evidence = await paypal.getOrder(c.paypal_order_id);
        await applyPaymentEvidence(db, c.id, order, { notify });
        checked = true;
        const units = order.purchase_units;
        if (order.id === c.paypal_order_id && order.status === 'APPROVED' && units?.length === 1 && units[0]?.custom_id === c.id &&
            (!units[0].payments?.captures || units[0].payments.captures.length === 0)) {
          const claimed = await transaction(db, async tx => {
            const current = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [id])).rows[0]!;
            if (current.state !== 'checking' || current.review_required || !current.capture_started_at ||
                now().getTime() - current.capture_started_at.getTime() >= 30 * 60_000) return;
            await tx.query("update checkouts set state='capturing' where id=$1", [id]);
            current.state = 'capturing';
            return current;
          });
          if (claimed) await capturePayment(app, db, paypal, claimed, notify);
        }
      } catch (error) { app.log.error(failureLog(error, c), 'Payment read unavailable'); }
      const flagged = await db.query<{ stall_id: string }>(`update checkouts set review_required=true,review_reason=$2
        where id=$1 and state='checking' and not review_required and capture_started_at <= $3 returning stall_id`,
      [id, repairLimitReason, new Date(now().getTime() - 30 * 60_000)]);
      for (const row of flagged.rows) notify(row.stall_id);
      return checked;
    })();
    pending.set(id, task);
    void task.finally(() => { pending.delete(id); }).catch(() => {});
    return task;
  }
  async function repair() {
    const stalls = (await db.query<{ id: string }>('select id from stalls')).rows;
    for (const stall of stalls) await expireReservations(db, stall.id, now());
    await db.query("update checkouts set state='checking' where state='capturing' and capture_started_at <= $1", [new Date(now().getTime() - abandonedCaptureMs)]);
    const { rows } = await db.query<{ id: string }>("select id from checkouts where state='checking' and not review_required order by id");
    for (const row of rows) await recheck(row.id);
  }
  app.addHook('onClose', async () => { await Promise.all(pending.values()); });
  return { repair, recheck };
}

export async function checkoutRoutes(app: FastifyInstance, { db, paypal, now, notify }: { db: Pool; paypal: PayPal; now: () => Date; notify: (stallId: string) => void }) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  // The deployment runs one instance. Coalescing avoids concurrent creates while durable keys cover retries after restart.
  const creates = new Map<string, Promise<ReturnType<typeof publicCheckout>>>();
  async function create(c: Checkout) {
    const existing = creates.get(c.id);
    if (existing) return existing;
    const pending = (async () => {
      try {
        c = await transaction(db, async tx => {
          const current = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [c.id])).rows[0]!;
          await expire(tx, current, now());
          return current;
        });
        if (c.state !== 'creating' || c.review_required) return publicCheckout(c);
        const lines = (await db.query<Line>('select * from checkout_lines where checkout_id=$1 order by item_id', [c.id])).rows;
        const result = await paypal.createOrder({ id: c.id, totalPence: c.total_pence, lines: lines.map(l => ({ name: l.name, code: l.code, amountPence: l.amount_pence })) }, c.create_request_id);
        if (typeof result.id !== 'string' || !result.id) throw new Error('Missing PayPal order ID');
        const orderId = result.id;
        return await transaction(db, async tx => {
          const current = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [c.id])).rows[0]!;
          await expire(tx, current, now());
          await tx.query("update checkouts set paypal_order_id=$2, state=case when state='creating' then 'awaiting_approval' else state end where id=$1", [c.id, orderId]);
          current.paypal_order_id = orderId;
          if (current.state === 'creating') current.state = 'awaiting_approval';
          return publicCheckout(current);
        });
      } catch (error) {
        app.log.error(failureLog(error, c), 'PayPal create outcome unavailable');
        // Unknown creates keep their stored key and reservation; a later press may retry the same operation.
        return publicCheckout((await db.query<Checkout>('select * from checkouts where id=$1', [c.id])).rows[0]!);
      }
    })();
    creates.set(c.id, pending);
    try { return await pending; } finally { creates.delete(c.id); }
  }
  app.post<{ Params: { code: string }; Body: { agreedPriceId?: string; amountPence?: number } }>('/api/i/:code/checkout', async (request, reply) => {
    if (request.body !== undefined && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).some(key => key !== 'agreedPriceId' && key !== 'amountPence') || (request.body.agreedPriceId !== undefined && (typeof request.body.agreedPriceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.body.agreedPriceId))) || (request.body.amountPence !== undefined && !Number.isSafeInteger(request.body.amountPence)))) return reply.code(400).send({ error: 'Checkout takes no amount.' });
    const buyer = await buyerId(db, request);
    if (!buyer) return reply.code(401).send({ error: 'Open the item page before paying.' });
    const item = (await db.query<{ id: string; stall_id: string; mode: string }>('select id,stall_id,mode from items where code=$1', [request.params.code.toUpperCase()])).rows[0];
    if (!item) return reply.code(404).send({ error: 'Item not found.' });
    // Only a pay-what-you-want item, or the tip on a free item, takes an amount from the buyer.
    const tipping = item.mode === 'free';
    const payWhatYouWant = item.mode === 'pwyw' || tipping;
    const offered = request.body?.amountPence;
    if (!payWhatYouWant && offered !== undefined) return reply.code(400).send({ error: 'Checkout takes no amount.' });
    if (payWhatYouWant && offered === undefined) return reply.code(400).send({ error: tipping ? 'Enter the tip you want to leave.' : 'Enter the amount you want to pay.' });
    await expireReservations(db, item.stall_id, now());
    const result = await transaction(db, async tx => {
      const session = (await tx.query<{ id: string; status: string }>("select id,status from trading_sessions where stall_id=$1 and status <> 'closed' for update", [item.stall_id])).rows[0];
      await tx.query('select id from buyer_sessions where id=$1 for update', [buyer]);
      const existing = (await tx.query<Checkout>(`select * from checkouts where buyer_session_id=$1 and state in ${active} and kind=$2 and ($2='sale' or checkout_key=$3) for update`, [buyer, tipping ? 'tip' : 'sale', item.id])).rows[0];
      if (existing) {
        await expire(tx, existing, now());
        if (['creating', 'awaiting_approval', 'capturing', 'checking'].includes(existing.state)) return existing.checkout_key === item.id ? existing : 'another-item-held';
      }
      const stock = (await pricingItem(tx, item.id))!;
      if (stock.mode !== item.mode) return null;
      if (tipping) {
        // The take is committed before any tip starts, so nothing about the tip can lose or hold the item.
        const take = (await tx.query<{ trading_session_id: string }>('select trading_session_id from free_takes where item_id=$1 and buyer_session_id=$2', [item.id, buyer])).rows[0];
        if (!take) return refuse(stock.status === 'sold' ? takenByAnother : 'Take the item first, then you can leave a tip.', 409);
        if (!session || session.status !== 'open' || take.trading_session_id !== session.id) return refuse('This stall has closed, so tips are no longer taken.', 409);
        const verdict = validateAmount(offered!);
        if (verdict === 'too_low') return refuse(`The least you can leave is ${pounds(1)}.`);
        if (verdict === 'above_maximum') return refuse(`The most you can leave is ${pounds(PAY_WHAT_YOU_WANT_MAX_PENCE)}.`);
        const deadline = new Date(now().getTime() + 5 * 60_000);
        const c = (await tx.query<Checkout>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline,kind)
          values ($1,$2,$3,'creating',$4,$5,$6,$7,$8,'tip') returning *`, [item.stall_id, session.id, buyer, offered, item.id, randomUUID(), randomUUID(), deadline])).rows[0]!;
        await tx.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$6)', [c.id, item.id, stock.code, `Tip for ${stock.name}`, stock.asking_pence, offered]);
        return c;
      }
      if (!session || session.status !== 'open') return null;
      const agreedPriceId = request.body?.agreedPriceId;
      const agreed = agreedPriceId ? (await tx.query<{ amount_pence: number; price_version: number; expires_at: Date }>(
        "select amount_pence,price_version,expires_at from offer_cards where id=$1 and item_id=$2 and buyer_session_id=$3 and status='agreed' for update", [agreedPriceId, item.id, buyer])).rows[0] : undefined;
      if (agreedPriceId && (!agreed || agreed.price_version !== stock.price_version || agreed.expires_at <= now())) return null;
      // The amount is read, checked and stored here, at reservation. Capture compares PayPal's amount with this stored total and never with anything the browser sends.
      const total = agreed?.amount_pence ?? (payWhatYouWant ? offered! : stock.asking_pence);
      const verdict = validateOffer(stock, total);
      if (payWhatYouWant && verdict === 'too_low') return refuse(`The least you can pay for this item is ${pounds(stock.minimum_pence ?? 1)}.`);
      if (verdict === 'above_maximum') return refuse(`The most you can pay for this item is ${pounds(PAY_WHAT_YOU_WANT_MAX_PENCE)}.`);
      if (verdict !== 'ok') return null;
      const deadline = new Date(now().getTime() + 5 * 60_000);
      const c = (await tx.query<Checkout>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline,offer_card_id)
        values ($1,$2,$3,'creating',$4,$5,$6,$7,$8,$9) returning *`, [item.stall_id, session.id, buyer, total, item.id, randomUUID(), randomUUID(), deadline, agreedPriceId ?? null])).rows[0]!;
      await tx.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$6)', [c.id, item.id, stock.code, stock.name, stock.asking_pence, total]);
      await tx.query('update items set reserved_checkout_id=$2,reserved_until=$3 where id=$1', [item.id, c.id, deadline]);
      return c;
    });
    if (result === 'another-item-held') return reply.code(409).send({ error: 'You already have another item reserved. Finish paying for it, or wait for that reservation to end, then try again.' });
    if (!result) return reply.code(409).send({ error: 'This item cannot be reserved. Refresh the page to check availability.' });
    if ('refused' in result) return reply.code(result.status).send({ error: result.refused });
    return result.state === 'creating' ? create(result) : publicCheckout(result);
  });
  const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
  for (const action of ['read', 'capture', 'cancel'] as const) {
    app.route<{ Params: { id: string } }>({ method: action === 'read' ? 'GET' : 'POST', url: `/api/checkouts/:id${action === 'read' ? '' : `/${action}`}`, schema: { params }, async handler(request, reply) {
      const buyer = await buyerId(db, request);
      const result = await transaction(db, async tx => {
        const c = (await tx.query<Checkout>('select * from checkouts where id=$1 and buyer_session_id=$2 for update', [request.params.id, buyer ?? null])).rows[0];
        if (!c) return null;
        await expire(tx, c, now());
        if (action === 'cancel' && !c.review_required && ['creating', 'awaiting_approval'].includes(c.state)) await release(tx, c, 'cancelled');
        const capture = action === 'capture' && c.state === 'awaiting_approval' && !c.review_required;
        if (capture) { await tx.query("update checkouts set state='capturing',approved_at=coalesce(approved_at,$2),capture_started_at=$2 where id=$1", [c.id, now()]); c.state = 'capturing'; c.approved_at ??= now(); c.capture_started_at = now(); }
        return { c, capture };
      });
      if (!result) return reply.code(404).send({ error: 'Checkout not found.' });
      const { c, capture } = result;
      if (action === 'capture' && c.state === 'expired') return reply.code(409).send(publicCheckout(c));
      if (!capture) return publicCheckout(c);
      return capturePayment(app, db, paypal, c, notify);
    } });
  }
  // Only the PayPal SDK's onCancel calls this. A buyer's "Cancel checkout" button uses /cancel, which never captures.
  // On iPhone Safari the SDK can miss PayPal's approval message, then read PayPal closing its tab as a cancel while
  // the order is already approved. Reading the order first stops that cancel from dropping a payment the buyer made.
  app.post<{ Params: { id: string } }>('/api/checkouts/:id/sdk-cancel', { schema: { params } }, async (request, reply) => {
    const buyer = await buyerId(db, request);
    const found = (await db.query<Checkout>('select * from checkouts where id=$1 and buyer_session_id=$2', [request.params.id, buyer ?? null])).rows[0];
    if (!found) return reply.code(404).send({ error: 'Checkout not found.' });
    let approved = false;
    if (found.paypal_order_id && found.state === 'awaiting_approval' && !found.review_required) {
      try {
        const order: Evidence = await paypal.getOrder(found.paypal_order_id);
        const units = order.purchase_units;
        approved = order.id === found.paypal_order_id && order.status === 'APPROVED' &&
          units?.length === 1 && units[0]?.custom_id === found.id;
      } catch (error) {
        // A failed read must not strand the reservation, so it falls through to the release below.
        app.log.error(failureLog(error, found), 'PayPal read failed on SDK cancel; releasing the checkout');
      }
    }
    const result = await transaction(db, async tx => {
      const c = (await tx.query<Checkout>('select * from checkouts where id=$1 for update', [found.id])).rows[0]!;
      await expire(tx, c, now());
      if (c.review_required || !['creating', 'awaiting_approval'].includes(c.state)) return { c, capture: false };
      if (approved && c.state === 'awaiting_approval') {
        await tx.query("update checkouts set state='capturing',approved_at=coalesce(approved_at,$2),capture_started_at=$2 where id=$1", [c.id, now()]);
        c.state = 'capturing'; c.approved_at ??= now(); c.capture_started_at = now();
        return { c, capture: true };
      }
      await release(tx, c, 'cancelled');
      return { c, capture: false };
    });
    return result.capture ? capturePayment(app, db, paypal, result.c, notify) : publicCheckout(result.c);
  });
}
