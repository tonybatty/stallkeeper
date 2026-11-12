import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { transaction } from './checkouts.js';
import { lastPriceReview, priceDropsIn } from './price-review.js';

export function feedUpdates() {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  return {
    notify: (stallId: string) => { events.emit(stallId); },
    subscribe(stallId: string, listener: () => void) {
      events.on(stallId, listener);
      return () => { events.off(stallId, listener); };
    },
  };
}
const questionLimit = 30;
// The live feed's takings and count of what a trading session sold and gave away. The Overview tiles use it too, so the two never disagree.
// Takings are every completed capture in the session, tips included, net of completed refunds.
// A sale counts once per line, until a refund takes back its whole capture. A tip sells nothing, and a free take is never a sale.
export async function sessionCounts(db: Pick<Pool, 'query'>, stallId: string, sessionId: string) {
  return (await db.query<{ recordedSalesPence: number; itemsSold: number; itemsTaken: number }>(`select
    (select coalesce(sum(cap.amount_pence-coalesce(r.total,0)),0)::integer from captures cap join checkouts c on c.id=cap.checkout_id
      left join lateral (select sum(amount_pence) as total from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED') r on true
      where c.stall_id=$1 and c.trading_session_id=$2 and cap.status='COMPLETED') as "recordedSalesPence",
    (select count(*)::integer from events e join checkouts c on e.business_key=e.type || ':' || c.id::text join checkout_lines l on l.checkout_id=c.id
      join captures cap on cap.paypal_capture_id=e.payload->>'captureId'
      where e.stall_id=$1 and e.trading_session_id=$2 and e.type in ('sale','tip') and c.kind='sale'
      and coalesce((select sum(amount_pence) from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED'),0) < cap.amount_pence) as "itemsSold",
    (select count(*)::integer from free_takes where stall_id=$1 and trading_session_id=$2) as "itemsTaken"`, [stallId, sessionId])).rows[0]!;
}
export async function feedRoutes(app: FastifyInstance, db: Pool, updates: ReturnType<typeof feedUpdates>, now: () => Date) {
  app.get('/api/owner/feed', async request => transaction(db, async tx => {
    await tx.query('set transaction isolation level repeatable read read only');
    const stallName = (await tx.query<{ name: string }>('select name from stalls where id=$1', [request.stallId])).rows[0]!.name;
    const session = (await tx.query<{ id: string; opened_at: Date; closed_at: Date | null; status: string }>('select id,opened_at,closed_at,status from trading_sessions where stall_id=$1 order by opened_at desc limit 1', [request.stallId])).rows[0];
    const flaggedPayments = (await tx.query(`select c.id as "checkoutId", c.review_reason as reason,c.total_pence as "totalPence",
      l.name,l.code,i.seeded from checkouts c join checkout_lines l on l.checkout_id=c.id join items i on i.id=l.item_id
      where c.stall_id=$1 and c.review_required
      and not exists (select 1 from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id where cap.checkout_id=c.id and r.status='COMPLETED')
      order by c.created_at,c.id`, [request.stallId])).rows;
    if (!session) return { stallName, session: null, recordedSalesPence: 0, itemsSold: 0, itemsTaken: 0, unsoldRecords: 0, earlierLedger: false, sales: [], takes: [], flaggedPayments, minorActivity: [], buyerQuestions: [], priceDrops: [], priceReview: null, updatedAt: now() };
    // Tips share the list with sales, told apart by kind. A free take has no payment, so it is listed on its own below.
    // The price line comes from the same fields as the stall ledger's grid: the offer card, the line's asking price and the amount paid.
    // The floor is never read here. A price drop counts only if its new price is the one the sale was asked at.
    const saleRows = (await tx.query<{ id: string; time: Date; checkoutId: string; kind: string; name: string; code: string; amountPence: number; seeded: boolean; webhookVerifiedAt: Date | null; refundedPence: number; capturePence: number;
      itemId: string; mode: string; askingPence: number | null; card: boolean; offeredPence: number | null; droppedFromPence: number | null }>(`select e.id,e.created_at as time,c.id as "checkoutId",c.kind,l.name,l.code,l.amount_pence as "amountPence",i.seeded,
      cap.webhook_verified_at as "webhookVerifiedAt",coalesce(r.total,0)::integer as "refundedPence",cap.amount_pence as "capturePence",
      l.item_id as "itemId",i.mode,l.asking_pence as "askingPence",c.offer_card_id is not null as card,offer.amount_pence as "offeredPence",
      (select (d.payload->>'oldPence')::integer from events d where d.stall_id=$1 and d.type='price_drop' and d.payload->>'itemId'=l.item_id::text
        and (d.payload->>'newPence')::integer=l.asking_pence and d.created_at<=c.created_at order by d.created_at desc,d.id limit 1) as "droppedFromPence"
      from events e join checkouts c on e.business_key=e.type || ':' || c.id::text
      join checkout_lines l on l.checkout_id=c.id join items i on i.id=l.item_id
      left join offer_cards card on card.id=c.offer_card_id left join offers offer on offer.id=card.offer_id
      join captures cap on cap.paypal_capture_id=e.payload->>'captureId'
      left join lateral (select sum(amount_pence) as total from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED') r on true
      where e.stall_id=$1 and e.trading_session_id=$2 and e.type in ('sale','tip') order by e.created_at desc,e.id`, [request.stallId, session.id])).rows;
    // The item id is only for matching refused offers to sales, so it is left out of what the owner's page gets.
    const sales = saleRows.map(row => ({ id: row.id, time: row.time, checkoutId: row.checkoutId, kind: row.kind, name: row.name, code: row.code, amountPence: row.amountPence,
      seeded: row.seeded, webhookVerifiedAt: row.webhookVerifiedAt, refundedPence: row.refundedPence,
      price: row.kind === 'tip' ? null : { source: row.card ? 'offer' : row.mode === 'pwyw' ? 'pwyw' : 'listed', askingPence: row.askingPence, offeredPence: row.offeredPence, droppedFromPence: row.droppedFromPence } }));
    // The message is a stranger's text. It travels as data and the page renders it as text.
    const takes = (await tx.query(`select f.id,f.taken_at as time,f.message,i.name,i.code,i.seeded from free_takes f join items i on i.id=f.item_id
      where f.stall_id=$1 and f.trading_session_id=$2 order by f.taken_at desc,f.id`, [request.stallId, session.id])).rows;
    // Mirrors the sessions the stall ledger lists: a completed capture, a payment still to check, a reported donation, or an offer.
    const earlierLedger = (await tx.query<{ found: boolean }>(`select (
      exists(select 1 from captures cap join checkouts c on c.id=cap.checkout_id where c.stall_id=$1 and c.trading_session_id <> $2 and cap.status='COMPLETED')
      or exists(select 1 from checkouts c where c.stall_id=$1 and c.trading_session_id <> $2 and (c.review_required or c.state in ('capturing','checking'))
        and not exists(select 1 from captures cap where cap.checkout_id=c.id and cap.status='COMPLETED'))
      or exists(select 1 from charity_donations d join trading_sessions t on t.id=d.trading_session_id where t.stall_id=$1 and d.trading_session_id <> $2)
      or exists(select 1 from offers o join items i on i.id=o.item_id where i.stall_id=$1 and o.created_at < $3
        and exists(select 1 from trading_sessions t where t.stall_id=$1 and t.opened_at <= o.created_at))) as found`, [request.stallId, session.id, session.opened_at])).rows[0]!.found;
    const unsold = (await tx.query(`select count(*)::integer as count from items where stall_id=$1
      and created_at <= coalesce($2, now()) and (sold_at is null or sold_at > coalesce($2, now())) and (removed_at is null or removed_at > coalesce($2, now()))`, [request.stallId, session.closed_at])).rows[0].count;
    // An offer that was not accepted is recorded as refused, but a counter carries the card the buyer was offered, so the feed can say what it was countered at.
    const refused = (await tx.query(`select e.id,e.payload,e.created_at,o.item_id,case when o.outcome='counter' then card.amount_pence end as counter_pence
      from events e left join offers o on e.business_key='offer:' || o.id::text left join offer_cards card on card.offer_id=o.id
      where e.stall_id=$1 and e.trading_session_id=$2 and e.type='offer_refused' order by e.created_at desc limit 50`, [request.stallId, session.id])).rows;
    // The first sale of the same item after the refusal, as the ledger's Offers tab marks an offer that became a sale.
    const becameSale = (itemId: string, at: Date) => saleRows.filter(sale => sale.kind === 'sale' && sale.itemId === itemId && sale.time >= at).at(-1)?.amountPence ?? null;
    const minorActivity = refused.map(row => ({ id: row.id, itemName: row.payload.itemName, code: row.payload.code,
      offeredPence: row.payload.offeredPence, counterPence: row.counter_pence ?? null, reason: row.payload.reason, at: row.created_at, becameSalePence: row.item_id ? becameSale(row.item_id, row.created_at) : null }));
    const asked = (await tx.query<{ id: string; content: string; created_at: Date; item_id: string; name: string; code: string; seeded: boolean }>(`select m.id::text,m.content,m.created_at,i.id as item_id,i.name,i.code,i.seeded
      from chat_messages m join items i on i.id=m.item_id
      where i.stall_id=$1 and i.status <> 'removed' and m.role='user' and m.created_at >= $2
      and not exists (select 1 from offers o where o.message_id=m.id)
      order by m.created_at desc,m.id desc limit $3`, [request.stallId, session.opened_at, questionLimit])).rows;
    const buyerQuestions: Array<{ itemId: string; name: string; code: string; seeded: boolean; questions: Array<{ id: string; text: string; at: Date }> }> = [];
    for (const row of asked) {
      let group = buyerQuestions.find(g => g.itemId === row.item_id);
      if (!group) buyerQuestions.push(group = { itemId: row.item_id, name: row.name, code: row.code, seeded: row.seeded, questions: [] });
      group.questions.push({ id: row.id, text: row.content, at: row.created_at });
    }
    return { stallName, session: { id: session.id, openedAt: session.opened_at, status: session.status }, ...await sessionCounts(tx, request.stallId, session.id), unsoldRecords: unsold, earlierLedger, sales, takes, flaggedPayments, minorActivity, buyerQuestions, priceDrops: await priceDropsIn(tx, session.id), priceReview: await lastPriceReview(tx, session.id), updatedAt: now() };
  }));
  const streams = new Set<() => void>();
  app.addHook('preClose', async () => { for (const close of streams) close(); });
  app.get('/api/owner/feed/stream', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = () => { if (!reply.raw.destroyed && !reply.raw.write('event: update\ndata: {}\n\n')) close(); };
    const unsubscribe = updates.subscribe(request.stallId, send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.write('event: heartbeat\ndata: {}\n\n')) close();
    }, 15_000);
    heartbeat.unref();
    function close() { clearInterval(heartbeat); unsubscribe(); streams.delete(close); reply.raw.end(); }
    streams.add(close);
    reply.raw.on('close', close);
    send();
  });
}
