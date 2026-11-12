import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { active, expireReservations, transaction } from './checkouts.js';
import { summaryKey, type summaryService, type SummaryTrace } from './closing-summary.js';
import { donationsFor, pledgePence, sessionCharity } from './charity.js';
import { carryLastRead, currentWording, runPayPalCheck, type PayPalCheck, type Toolkit } from './paypal-check.js';
import { priceDropsIn } from './price-review.js';

interface Session { id: string; status: string; cutoff_at: Date | null }
type Observation = 'unknown' | 'present' | 'absent' | 'removed';
interface ShelfItem {
  id: string; name: string; code: string; seeded: boolean; observation: Observation; reason: string | null;
  paid: boolean; refunded: boolean; unresolved: boolean;
  // A free item that was taken. tipPence is what its tips came to after refunds, and message is the taker's own text.
  taken: boolean; tipPence: number; message: string | null;
  free: boolean;
}
// Nobody checks the shelf at close. An item with a completed sale or a free take is gone with its buyer, and any other item is still at the stall unless the owner flags it as not there.
export const labels = {
  paidAbsent: 'Sold, gone with the buyer', takenAbsent: 'Taken free, gone with the taker',
  freeAbsent: 'Gone from the shelf, free item, nothing to pay', unsoldPresent: 'Unsold, still at the stall',
  unpaidAbsent: 'Not on the shelf, no confirmed payment. This record cannot say what happened.',
  unresolved: 'Payment unresolved',
};
// A demo reset's session replaces the stock, so its items are grouped only by what was recorded against them.
const restockedLabels = { unresolved: labels.unresolved, paid: 'Paid', taken: 'Taken free' };

async function regenerate(tx: PoolClient, session: Session, now: Date) {
  const closing = (await tx.query<{ id: string }>('insert into closings (trading_session_id) values ($1) on conflict (trading_session_id) do update set trading_session_id=excluded.trading_session_id returning id', [session.id])).rows[0]!;
  // A demo reset closes the session and replaces the stock itself, so only items with something recorded against them are reported.
  const restocked = (await tx.query("select 1 from trading_sessions where id=$1 and closed_by='demo_reset'", [session.id])).rowCount === 1;
  // An item the owner took off sale during the session is recorded as removed with its reason, so it is not counted as unsold.
  // Only when the row is first written: a later removal, such as a reset's, must not rewrite a closed report. observed_at stays null, since the owner checked nothing.
  await tx.query(`insert into shelf_checks (closing_id,item_id,free,observation,reason) select $1,i.id,i.mode='free',
    case when r.removed then 'removed' else 'unknown' end,case when r.removed then trim(i.removed_reason) end from session_stock s join items i on i.id=s.item_id
    cross join lateral (select not $3::boolean and i.status='removed' and length(trim(coalesce(i.removed_reason,''))) > 0 as removed) r
    where s.trading_session_id=$2 on conflict do nothing`, [closing.id, session.id, restocked]);
  // One statement gives the observations and money the same database snapshot while payments continue.
  const snapshot = (await tx.query<{ items: ShelfItem[]; recordedSalesPence: number; refundedPence: number; paidCheckouts: number; itemsSold: number; itemsTaken: number; tipsPence: number; tipCount: number; unresolved: boolean }>(`
    with payments as (
      select *,(state in ${active} or review_required) and not refunded as unresolved from (
        select c.id,c.trading_session_id,c.state,c.review_required,c.kind,
          exists(select 1 from captures cap where cap.checkout_id=c.id and cap.status='COMPLETED') as paid,
          exists(select 1 from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id where cap.checkout_id=c.id and r.status='COMPLETED') as refunded,
          (select coalesce(sum(r.amount_pence),0) from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id where cap.checkout_id=c.id and r.status='COMPLETED')
            >= (select coalesce(sum(cap.amount_pence),0) from captures cap where cap.checkout_id=c.id and cap.status='COMPLETED') as refunded_in_full
        from checkouts c join trading_sessions t on t.id=c.trading_session_id
        join trading_sessions report on report.id=$1 and report.stall_id=t.stall_id
        where t.opened_at <= report.opened_at
      ) c
    ), session_payments as (select * from payments where trading_session_id=$1),
    -- A tip is money received for an item that is already gone, so it never makes the item a paid sale.
    takes as (select ft.item_id,ft.message,ft.trading_session_id from free_takes ft join trading_sessions t on t.id=ft.trading_session_id
      join trading_sessions report on report.id=$1 and report.stall_id=t.stall_id where t.opened_at <= report.opened_at)
    select
      (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'code',i.code,'seeded',i.seeded,
        'observation',sc.observation,'reason',sc.reason,
        'paid',exists(select 1 from payments p join checkout_lines l on l.checkout_id=p.id where l.item_id=i.id and p.paid and p.kind='sale'),
        'refunded',exists(select 1 from payments p join checkout_lines l on l.checkout_id=p.id where l.item_id=i.id and p.refunded and p.kind='sale'),
        'unresolved',exists(select 1 from payments p join checkout_lines l on l.checkout_id=p.id where l.item_id=i.id and p.unresolved),
        'taken',exists(select 1 from takes tk where tk.item_id=i.id),
        'free',sc.free,
        'message',(select tk.message from takes tk where tk.item_id=i.id),
        'tipPence',(select coalesce(sum(cap.amount_pence-coalesce(r.total,0)),0)::integer from captures cap join payments p on p.id=cap.checkout_id and p.kind='tip'
          join checkout_lines l on l.checkout_id=p.id and l.item_id=i.id
          left join lateral (select sum(amount_pence) as total from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED') r on true
          where cap.status='COMPLETED')) order by i.created_at,i.id),'[]')
       from shelf_checks sc join items i on i.id=sc.item_id where sc.closing_id=$2) as items,
      (select coalesce(sum(cap.amount_pence-coalesce(r.total,0)),0)::integer from captures cap join session_payments p on p.id=cap.checkout_id
        left join lateral (select sum(amount_pence) as total from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED') r on true
        where cap.status='COMPLETED') as "recordedSalesPence",
      (select coalesce(sum(r.amount_pence),0)::integer from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id
        join session_payments p on p.id=cap.checkout_id where r.status='COMPLETED') as "refundedPence",
      (select count(*)::integer from session_payments where paid and kind='sale') as "paidCheckouts",
      (select count(distinct l.item_id)::integer from checkout_lines l join session_payments p on p.id=l.checkout_id where p.state='paid' and p.kind='sale' and not (p.refunded and p.refunded_in_full)) as "itemsSold",
      (select count(*)::integer from takes where trading_session_id=$1) as "itemsTaken",
      (select coalesce(sum(cap.amount_pence-coalesce(r.total,0)),0)::integer from captures cap join session_payments p on p.id=cap.checkout_id and p.kind='tip'
        left join lateral (select sum(amount_pence) as total from refunds where paypal_capture_id=cap.paypal_capture_id and status='COMPLETED') r on true
        where cap.status='COMPLETED') as "tipsPence",
      (select count(*)::integer from session_payments where paid and kind='tip') as "tipCount",
      exists(select 1 from session_payments where unresolved) as unresolved`, [session.id, closing.id])).rows[0]!;
  // After a reset only items with a payment, refund, take or tip are reported, each listed by what was recorded.
  if (restocked) snapshot.items = snapshot.items.filter(item => item.paid || item.refunded || item.unresolved || item.taken || item.tipPence > 0);
  const groups = Object.entries(restocked ? restockedLabels : labels).map(([key, label]) => ({ key, label, items: [] as ShelfItem[] }));
  const removed: ShelfItem[] = [];
  for (const item of snapshot.items) {
    // A free item flagged as gone is never reported as an unpaid absence, since nothing is owed for it.
    const key = item.unresolved ? 'unresolved' : restocked ? item.taken || item.tipPence > 0 ? 'taken' : 'paid'
      : item.observation === 'removed' ? null
        : item.taken ? 'takenAbsent' : item.paid ? 'paidAbsent'
          : item.observation === 'absent' ? item.free ? 'freeAbsent' : 'unpaidAbsent' : 'unsoldPresent';
    if (key) groups.find(group => group.key === key)!.items.push(item);
    else removed.push(item);
  }
  const provisional = snapshot.unresolved || snapshot.items.some(item => item.unresolved);
  // The pledge is derived from the net sales above and the donations are read from their own table, so neither changes a sales figure.
  const pledge = await sessionCharity(tx, session.id);
  const charity = pledge && { ...pledge, basisPence: snapshot.recordedSalesPence, pledgePence: pledgePence(snapshot.recordedSalesPence, pledge.percent), donations: await donationsFor(tx, session.id) };
  // While the stall is open again, the page shows the last closed session. Say so, with when that session closed, so its totals are not read as today's.
  const earlier = (await tx.query<{ closed_at: Date | null }>(`select s.closed_at from trading_sessions s where s.id=$1 and s.status='closed'
    and exists(select 1 from trading_sessions n where n.stall_id=s.stall_id and n.status='open')`, [session.id])).rows[0];
  const report = { id: closing.id, sessionId: session.id, sessionStatus: session.status, restocked, cutoffAt: session.cutoff_at, earlierClosedAt: earlier ? (earlier.closed_at ?? session.cutoff_at) : null,
    status: provisional ? 'provisional' : 'final', paymentAsOf: now, recordedSalesPence: snapshot.recordedSalesPence, refundedPence: snapshot.refundedPence,
    paidCheckouts: snapshot.paidCheckouts, itemsSold: snapshot.itemsSold, itemsTaken: snapshot.itemsTaken, tipsPence: snapshot.tipsPence, tipCount: snapshot.tipCount, items: snapshot.items, groups, removed, charity, priceDrops: await priceDropsIn(tx, session.id) };
  await tx.query('update closings set status=$2,payment_as_of=$3,totals=$4,updated_at=$3 where id=$1', [closing.id, report.status, now, JSON.stringify(report)]);
  return report;
}

export type ClosingReport = Awaited<ReturnType<typeof regenerate>>;

// The summary shows only against the report content it was written from, and the PayPal check shows with the time it ran.
// A summary for older content is never shown or mentioned: when the rewrite is refused or fails, the plain report stands alone.
async function saved(db: Pool, report: ClosingReport | null) {
  if (!report) return { summary: null, paypalCheck: null };
  const row = (await db.query<{ summary: string | null; summary_key: string | null; paypal_check: PayPalCheck | null }>('select summary,summary_key,paypal_check from closings where id=$1', [report.id])).rows[0];
  const current = row?.summary_key === summaryKey(report);
  return { summary: current ? row?.summary ?? null : null, paypalCheck: row?.paypal_check ? currentWording(row.paypal_check) : null };
}

export async function repairClosings(db: Pool, now: Date) {
  const sessions = (await db.query<{ id: string; stall_id: string }>("select id,stall_id from trading_sessions where status in ('closing','closed')")).rows;
  for (const s of sessions) {
    await expireReservations(db, s.stall_id, now);
    await transaction(db, async tx => {
      const session = (await tx.query<Session>('select id,status,cutoff_at from trading_sessions where id=$1 for update', [s.id])).rows[0]!;
      const closed = await tx.query(`update trading_sessions set status='closed',closed_at=$2 where id=$1 and status='closing'
        and not exists(select 1 from checkouts where trading_session_id=$1 and state in ${active} and not review_required) returning id`, [s.id, now]);
      if (closed.rowCount) session.status = 'closed';
      await regenerate(tx, session, now);
    });
  }
}

export async function closingRoutes(app: FastifyInstance, db: Pool, now: () => Date, notify: (stallId: string) => void,
  extras: { summaries: ReturnType<typeof summaryService>; toolkit: () => Toolkit }) {
  const latest = (stallId: string) => transaction(db, async tx => {
    // A session the owner closed is always reported, since the owner can still flag an item as not at the stall. A demo reset's session, or one from before closed_by was recorded, is reported only if something happened in it.
    const session = (await tx.query<Session>(`select s.id,s.status,s.cutoff_at from trading_sessions s where s.stall_id=$1 and s.status <> 'open'
      and (s.status = 'closing' or s.closed_by = 'owner'
        or exists(select 1 from checkouts c where c.trading_session_id=s.id
          and (c.state not in ('expired','cancelled') or c.review_required or exists(select 1 from captures cp where cp.checkout_id=c.id)))
        or exists(select 1 from free_takes t where t.trading_session_id=s.id)
        or exists(select 1 from offers o join session_stock ss on ss.item_id=o.item_id and ss.trading_session_id=s.id
          where o.created_at >= s.opened_at and (s.closed_at is null or o.created_at <= s.closed_at))
        or exists(select 1 from shelf_checks sc join closings cl on cl.id=sc.closing_id where cl.trading_session_id=s.id and sc.observed_at is not null))
      order by s.opened_at desc,s.id desc limit 1 for update of s`, [stallId])).rows[0];
    return session ? regenerate(tx, session, now()) : null;
  });
  // The summary starts when the owner closes the stall, and again whenever the report's content changes, never more than once for the same content.
  const autoSummary = (stallId: string, closing: ClosingReport | null, log: (message: string) => void) => {
    if (closing && !closing.restocked && !closing.earlierClosedAt) { void extras.summaries.auto(closing, log).then(started => { if (started) notify(stallId); }); }
  };
  app.post('/api/owner/stall/close', async (request, reply) => {
    const result = await transaction(db, async tx => {
      const session = (await tx.query<Session>("select id,status,cutoff_at from trading_sessions where stall_id=$1 and status <> 'closed' for update", [request.stallId])).rows[0];
      if (!session) return null;
      if (session.status === 'open') {
        session.status = 'closing'; session.cutoff_at = now();
        await tx.query("update trading_sessions set status='closing',cutoff_at=$2,closed_by='owner' where id=$1", [session.id, session.cutoff_at]);
      }
      return regenerate(tx, session, now());
    });
    if (result) autoSummary(request.stallId, result, message => { request.log.warn(message); });
    return result ?? reply.code(409).send({ error: 'There is no open trading session.' });
  });
  app.get('/api/owner/closing', async request => {
    const closing = await latest(request.stallId);
    const stallName = (await db.query<{ name: string }>('select name from stalls where id=$1', [request.stallId])).rows[0]!.name;
    const stallOpen = (await db.query("select 1 from trading_sessions where stall_id=$1 and status='open'", [request.stallId])).rowCount === 1;
    autoSummary(request.stallId, closing, message => { request.log.warn(message); });
    // Read before the saved summary: a write that finishes in between would otherwise show no summary with nothing pending, and the screen would stop checking.
    const summaryPending = !!closing && extras.summaries.pending(closing);
    return { stallName, closing, stallOpen, ...await saved(db, closing), summaryPending };
  });
  // The PayPal check runs only when the owner asks, since the report polls every 30 seconds. The summary route stays for a deliberate retry from the API.
  app.post('/api/owner/closing/summary', async (request, reply) => {
    const closing = await latest(request.stallId);
    if (!closing) return reply.code(409).send({ error: 'There is no closing report yet.' });
    // Only the published demo stall gets the trace, so the closing check can be measured on the hosted service. It carries no model text.
    const demo = (await db.query<{ is_demo: boolean }>('select is_demo from stalls where id=$1', [request.stallId])).rows[0]?.is_demo === true;
    let trace: SummaryTrace | undefined;
    const summary = await extras.summaries.write(closing, message => { request.log.warn(message); }, t => { trace = t; });
    notify(request.stallId);
    return demo ? { summary, trace } : { summary };
  });
  app.post('/api/owner/closing/paypal-check', async (request, reply) => {
    const closing = await latest(request.stallId);
    if (!closing) return reply.code(409).send({ error: 'There is no closing report yet.' });
    try {
      const check = await runPayPalCheck(db, extras.toolkit(), { stallId: request.stallId, sessionId: closing.sessionId, localSalesPence: closing.recordedSalesPence, now: now(), log: (detail, message) => { request.log.warn(detail, message); } });
      const paypalCheck = await transaction(db, async tx => {
        const earlier = (await tx.query<{ paypal_check: PayPalCheck | null }>('select paypal_check from closings where id=$1 for update', [closing.id])).rows[0]?.paypal_check ?? null;
        const stored = carryLastRead(check, earlier);
        await tx.query('update closings set paypal_check=$2 where id=$1', [closing.id, JSON.stringify(stored)]);
        return stored;
      });
      return { paypalCheck };
    } catch (error) {
      request.log.warn({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'PayPal check unavailable');
      return reply.code(502).send({ error: 'The PayPal check could not run just now. The report above is unaffected.' });
    }
  });
  app.put<{ Body: { sessionId: string; itemId: string; observation: Observation; reason?: string } }>('/api/owner/closing/shelf-check', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['sessionId', 'itemId', 'observation'], properties: {
      sessionId: { type: 'string', format: 'uuid' }, itemId: { type: 'string', format: 'uuid' },
      observation: { type: 'string', enum: ['unknown', 'present', 'absent', 'removed'] },
      reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
    } } },
  }, async (request, reply) => {
    const input = request.body;
    if (input.observation === 'removed' && !input.reason?.trim()) return reply.code(400).send({ error: 'Give a reason for removal.' });
    await expireReservations(db, request.stallId, now());
    const report = await transaction(db, async tx => {
      await tx.query('select id from stalls where id=$1 for no key update', [request.stallId]);
      const sessions = (await tx.query<Session>("select id,status,cutoff_at from trading_sessions where stall_id=$2 and (id=$1 or status <> 'closed') order by opened_at,id for update", [input.sessionId, request.stallId])).rows;
      const session = sessions.find(s => s.id === input.sessionId && s.status !== 'open');
      if (!session) return null;
      await regenerate(tx, session, now());
      const item = (await tx.query<{ reserved_checkout_id: string | null; observation: Observation; observed: boolean; took_off_sale: boolean }>(`select i.reserved_checkout_id,sc.observation,sc.observed_at is not null as observed,
        exists(select 1 from shelf_checks other where other.item_id=i.id and other.took_off_sale) as took_off_sale from shelf_checks sc join closings c on c.id=sc.closing_id join items i on i.id=sc.item_id
        where c.trading_session_id=$1 and sc.item_id=$2 for update of i`, [session.id, input.itemId])).rows[0];
      if (!item) return null;
      const removing = input.observation === 'removed';
      if (removing && item.reserved_checkout_id) return 'reserved';
      // took_off_sale marks removals made by a shelf check, so an edited reason follows the stock record while an owner-route removal keeps its own.
      if (removing && item.took_off_sale) await tx.query("update items set removed_reason=$2 where id=$1 and status='removed'", [input.itemId, input.reason!.trim()]);
      // A removal recorded at close, not by a shelf check, is no correction to undo, so the item stays off sale.
      const restored = !removing && item.observation === 'removed' && item.observed && item.took_off_sale && !!(await tx.query(`update items set status='available',removed_at=null,removed_reason=null where id=$1 and status='removed'
        and not exists(select 1 from captures cap join checkout_lines l on l.checkout_id=cap.checkout_id where l.item_id=$1 and cap.status='COMPLETED')`, [input.itemId])).rowCount;
      if (restored) {
        await tx.query('update shelf_checks set took_off_sale=false where item_id=$1', [input.itemId]);
        const trading = sessions.find(s => s.status !== 'closed');
        if (trading) await tx.query('insert into session_stock values ($1,$2) on conflict do nothing', [trading.id, input.itemId]);
      }
      const tookOffSale = (item.took_off_sale && !restored) || (removing && !!(await tx.query("update items set status='removed',removed_at=$2,removed_reason=$3 where id=$1 and status='available'", [input.itemId, now(), input.reason!.trim()])).rowCount);
      await tx.query(`update shelf_checks sc set observation=$3,reason=$4,observed_at=$5,took_off_sale=$6
        from closings c where sc.closing_id=c.id and c.trading_session_id=$1 and sc.item_id=$2`,
      [session.id, input.itemId, input.observation, removing ? input.reason!.trim() : null, now(), tookOffSale]);
      return regenerate(tx, session, now());
    });
    if (report === 'reserved') return reply.code(409).send({ error: 'This item is held for a payment, so it cannot be removed yet.' });
    if (!report) return reply.code(404).send({ error: 'Shelf check item not found.' });
    notify(request.stallId);
    autoSummary(request.stallId, report, message => { request.log.warn(message); });
    const summaryPending = extras.summaries.pending(report);
    return { closing: report, ...await saved(db, report), summaryPending };
  });
}
