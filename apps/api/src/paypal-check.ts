import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import type { Pool } from 'pg';
import { active } from './checkouts.js';

// The only toolkit tools this check may hold. Both read; neither moves money.
const allowed = ['get_order', 'list_transactions'] as const;
type ToolName = typeof allowed[number];
interface ToolkitTool { execute: (args: Record<string, unknown>, options: { toolCallId: string; messages: unknown[] }) => PromiseLike<unknown> }
export type Toolkit = Record<ToolName, ToolkitTool>;

// The toolkit builds its tool list from `actions`, so naming only these two actions is the allowlist.
// Comparing against getTools() of the installed version catches a release that maps them differently.
export function installedToolkit(clientId: string, clientSecret: string): Toolkit {
  const toolkit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: {
    actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true },
  } });
  const tools = toolkit.getTools();
  const names = Object.keys(tools).sort();
  if (names.join() !== [...allowed].sort().join()) throw new Error(`Unexpected PayPal toolkit tools: ${names.join(', ')}`);
  return tools as unknown as Toolkit;
}

type Outcome = 'agrees' | 'differs' | 'capture_not_recorded' | 'capture_pending' | 'no_capture' | 'unreadable';
export interface OrderCheck { orderId: string; codes: string; inSession: boolean; unresolved: boolean; outcome: Outcome; lastRead?: Exclude<Outcome, 'unreadable'>; lastReadAt?: string; localNetPence: number; paypalNetPence: number | null; note: string }
export interface PayPalCheck {
  checkedAt: string; localSalesPence: number; paypalSalesPence: number | null; totalsAgree: boolean | null; totalsNote: string | null;
  orders: OrderCheck[]; ordersSkipped: number;
  transactions: { status: 'ran'; listed: number; missing: number | null; note: string } | { status: 'unavailable'; note: string };
}
interface Row { orderId: string; codes: string; inSession: boolean; flagged: boolean; captured: number; refunded: number }
type Picked = Row & { unresolved: boolean }
// What a failed read keeps for the server log: PayPal's status, error code and short message, plus its error name and debug id when the body carries them.
// The installed toolkit passes on the status, code and message only. Never the body, a header or a token.
interface Failure { code?: string; name?: string; debugId?: string; message?: string }
type Read = { ok: true; data: Record<string, unknown> } | { ok: false; status: number | null; error?: Failure };

const orderCap = 40;
const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const toPence = (amount: unknown) => {
  const value = amount as { currency_code?: unknown; value?: unknown } | undefined;
  return value?.currency_code === 'GBP' && typeof value.value === 'string' && /^\d+(\.\d{1,2})?$/.test(value.value) ? Math.round(Number(value.value) * 100) : null;
};
const asArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];

// A run of 24 or more token characters could be a credential echoed back, so it never reaches the log.
export const loggable = (value: unknown, length = 200) => typeof value === 'string' && value ? value.replace(/[A-Za-z0-9._~+/=-]{24,}/g, '[removed]').slice(0, length) : undefined;
function failure(body: Record<string, unknown>): Failure {
  const wrapped = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
  const detail = { code: loggable(body.code ?? wrapped.type, 60), name: loggable(body.name ?? wrapped.name, 60), debugId: typeof (body.debug_id ?? wrapped.debug_id) === 'string' ? String(body.debug_id ?? wrapped.debug_id).replace(/[^A-Za-z0-9]/g, '').slice(0, 40) : undefined,
    message: loggable(body.message ?? wrapped.message ?? body.error) };
  return Object.fromEntries(Object.entries(detail).filter(([, value]) => value)) as Failure;
}

// The toolkit returns an error as a JSON body rather than throwing: `ok: false` from PayPal, or an `error` key from its own wrapper.
async function read(tool: ToolkitTool, args: Record<string, unknown>): Promise<Read> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([tool.execute(args, { toolCallId: 'closing-check', messages: [] }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }, 20_000); })]);
    const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, status: null, error: { name: 'UnexpectedBody' } };
    const body = data as Record<string, unknown>;
    return body.ok === false || 'error' in body ? { ok: false, status: typeof body.status === 'number' ? body.status : null, error: failure(body) } : { ok: true, data: body };
  } catch (error) { return { ok: false, status: null, error: { name: error instanceof Error ? loggable(error.name, 60) : 'Unknown' } }; }
  finally { clearTimeout(timer); }
}

const notStarted: Read = { ok: false, status: null };
// Four at a time, so a long list does not open forty requests at once. Each read has its own 20 second limit, so a list
// of forty could take minutes, and a deadline stops new reads starting. An order not read by then stays as it was.
async function readOrders(tool: ToolkitTool, ids: string[], deadline = Infinity): Promise<Read[]> {
  const results = new Array<Read>(ids.length).fill(notStarted);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    for (let index = next++; index < ids.length && Date.now() < deadline; index = next++) results[index] = await read(tool, { id: ids[index]! });
  }));
  return results;
}

// Net of completed refunds. A capture that was later refunded still counts as captured, so refunds are taken off once.
function paypalNet(order: Record<string, unknown>) {
  if (!Array.isArray(order.purchase_units)) return null;
  let captured = 0; let refunded = 0; let pending = false; let unreadable = false;
  for (const unit of asArray(order.purchase_units)) {
    const payments = (unit.payments ?? {}) as Record<string, unknown>;
    for (const capture of asArray(payments.captures)) {
      const amount = toPence(capture.amount);
      if (capture.status === 'PENDING') pending = true;
      else if (capture.status === 'COMPLETED' || capture.status === 'REFUNDED' || capture.status === 'PARTIALLY_REFUNDED') {
        if (amount === null) unreadable = true; else captured += amount;
      }
    }
    for (const refund of asArray(payments.refunds)) {
      if (refund.status !== 'COMPLETED') continue;
      const amount = toPence(refund.amount);
      if (amount === null) unreadable = true; else refunded += amount;
    }
  }
  return unreadable ? null : { net: captured - refunded, captured, pending };
}

function compare(row: Picked, order: Read): Pick<OrderCheck, 'outcome' | 'paypalNetPence' | 'note'> {
  const local = row.captured - row.refunded;
  const remote = order.ok ? paypalNet(order.data) : null;
  if (!remote) return { outcome: 'unreadable', paypalNetPence: null, note: 'PayPal could not be read for this order just now.' };
  const base = { paypalNetPence: remote.net };
  if (remote.net === local) {
    return remote.pending ? { ...base, outcome: 'capture_pending', note: 'PayPal shows a capture still pending, so the amount may change.' }
      : remote.captured === 0 ? { ...base, outcome: 'no_capture', note: row.unresolved ? 'PayPal shows no completed capture for this order. That fits an unresolved payment.' : 'PayPal shows no completed capture and this record has none.' }
        : { ...base, outcome: 'agrees', note: 'PayPal and this record agree.' };
  }
  if (row.captured === 0 && remote.net > 0) return { ...base, outcome: 'capture_not_recorded', note: `PayPal shows a completed capture of ${pounds(remote.net)} that this record has not confirmed. Use Check payment again on the live feed.` };
  return { ...base, outcome: 'differs', note: `PayPal shows ${pounds(remote.net)} after refunds. This record has ${pounds(local)}.` };
}

// The transaction list is a separate call from the order reads, so its sentence names it and never reads as if nothing was checked.
const transactionNotes = {
  refused: "PayPal's transaction list was not read: PayPal refused it for this app.",
  failed: "PayPal's transaction list was not read: PayPal could not list it just now.",
  unreadable: "PayPal's transaction list was not read: PayPal returned it in a form this check does not read.",
};
// Checks stored before the wording changed carry the old sentences, and the owner pages show stored checks.
const legacyNotes: Record<string, string> = {
  'PayPal refused transaction listing for this app, so this cross-check did not run. Transaction Search must be enabled on the PayPal app.': transactionNotes.refused,
  'PayPal refused transaction listing for this app, so this cross-check did not run.': transactionNotes.refused,
  'PayPal could not list transactions just now, so this cross-check did not run.': transactionNotes.failed,
  'PayPal returned a transaction list in a form this check does not read, so this cross-check did not run.': transactionNotes.unreadable,
};
export function currentWording(check: PayPalCheck): PayPalCheck {
  const note = legacyNotes[check.transactions.note];
  return note ? { ...check, transactions: { ...check.transactions, note } } : check;
}

export type CheckLog = (detail: object, message: string) => void;
async function transactions(tool: ToolkitTool, sessionOpened: Date, now: Date, captureIds: string[], log?: CheckLog): Promise<PayPalCheck['transactions']> {
  // Transaction Search reports a window of at most 31 days, and new transactions can take hours to appear. A check on a session
  // opened minutes earlier was not read on the hosted stall, while a window opened six hours earlier was. The cause is inferred, not
  // confirmed: Transaction Search seems to refuse a start after its last refresh, which trails real time by up to about three hours.
  // So the window starts at least a day back. Only this session's capture ids are looked for in it, so a wider window changes no count of missing captures.
  const start = new Date(Math.max(Math.min(sessionOpened.getTime(), now.getTime() - 86_400_000), now.getTime() - 30 * 86_400_000));
  const result = await read(tool, { start_date: start.toISOString(), end_date: now.toISOString(), page_size: 100 });
  if (!result.ok) {
    log?.({ status: result.status, ...result.error }, "PayPal's transaction list was not read");
    return { status: 'unavailable', note: result.status === 403 ? transactionNotes.refused : transactionNotes.failed };
  }
  if (!Array.isArray(result.data.transaction_details)) { log?.({ status: null, name: 'UnexpectedBody' }, "PayPal's transaction list was not read"); return { status: 'unavailable', note: transactionNotes.unreadable }; }
  const listed = new Set(asArray(result.data.transaction_details).map(entry => (entry.transaction_info as Record<string, unknown> | undefined)?.transaction_id));
  const complete = typeof result.data.total_pages === 'number' && result.data.total_pages <= 1;
  const missing = complete ? captureIds.filter(id => !listed.has(id)).length : null;
  return { status: 'ran', listed: listed.size, missing, note: 'The list covers at least the last day, so it can include earlier sessions. PayPal can take a few hours to list a new transaction, so a missing one is not a difference on its own.' };
}

// A failed read says nothing about the order, so an unreadable order carries what PayPal last said. Its outcome stays
// unreadable, because the closing report and the clerk describe this check, and in it PayPal was not read.
export function carryLastRead(check: PayPalCheck, earlier: PayPalCheck | null): PayPalCheck {
  const known = new Map(earlier?.orders.map(order => [order.orderId, order.outcome === 'unreadable'
    ? { lastRead: order.lastRead, lastReadAt: order.lastReadAt }
    : { lastRead: order.outcome, lastReadAt: earlier.checkedAt }]));
  return { ...check, orders: check.orders.map(order => {
    const carried = order.outcome === 'unreadable' ? known.get(order.orderId) : undefined;
    return carried?.lastRead ? { ...order, lastRead: carried.lastRead, ...(carried.lastReadAt ? { lastReadAt: carried.lastReadAt } : {}) } : order;
  }) };
}

export async function runPayPalCheck(db: Pool, toolkit: Toolkit, input: { stallId: string; sessionId: string; localSalesPence: number; now: Date; log?: CheckLog }): Promise<PayPalCheck> {
  const { rows: sessions } = await db.query<{ opened_at: Date }>('select opened_at from trading_sessions where id=$1 and stall_id=$2', [input.sessionId, input.stallId]);
  const opened = sessions[0]?.opened_at ?? input.now;
  const { rows } = await db.query<Row>(`select c.paypal_order_id as "orderId", c.trading_session_id=$1 as "inSession",
      coalesce((select string_agg(l.code,', ' order by l.code) from checkout_lines l where l.checkout_id=c.id),'') as codes,
      coalesce((select sum(cap.amount_pence) from captures cap where cap.checkout_id=c.id and cap.status='COMPLETED'),0)::integer as captured,
      coalesce((select sum(r.amount_pence) from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id
        where cap.checkout_id=c.id and cap.status='COMPLETED' and r.status='COMPLETED'),0)::integer as refunded,
      (c.state in ${active} or c.review_required) as "flagged"
    from checkouts c where c.stall_id=$2 and c.paypal_order_id is not null and (c.trading_session_id=$1 or c.state in ${active} or c.review_required)
    order by c.created_at, c.id`, [input.sessionId, input.stallId]);
  const picked: Picked[] = rows.slice(0, orderCap).map(row => ({ ...row, unresolved: row.flagged && row.refunded === 0 }));
  const results = await readOrders(toolkit.get_order, picked.map(row => row.orderId));
  const orders = picked.map((row, index): OrderCheck => {
    const verdict = compare(row, results[index]!);
    return { orderId: row.orderId, codes: row.codes, inSession: row.inSession, unresolved: row.unresolved, localNetPence: row.captured - row.refunded, ...verdict };
  });
  const inSession = orders.filter(order => order.inSession);
  const skipped = Math.max(0, rows.length - orderCap);
  const settled = !skipped && inSession.every(order => order.outcome !== 'unreadable' && order.outcome !== 'capture_pending');
  // Orders with no capture give PayPal nothing to total, so zero against zero is not a match anyone checked.
  const comparable = settled && inSession.some(order => order.outcome !== 'no_capture');
  const paypalSalesPence = comparable ? inSession.reduce((sum, order) => sum + order.paypalNetPence!, 0) : null;
  const totalsNote = comparable ? null
    : skipped ? `${skipped} ${skipped === 1 ? 'order was' : 'orders were'} not checked, because this check reads at most ${orderCap}, so totals could not be compared.`
      : settled && !inSession.length ? 'There were no PayPal orders to check for this session.'
        : settled ? 'PayPal shows no captured payment for this session, so there is no total to compare.'
          : inSession.every(order => order.outcome === 'unreadable') ? 'PayPal data was unavailable, so totals could not be compared.'
            : 'Totals could not be compared, because some orders could not be read or have a capture still pending.';
  const { rows: captures } = await db.query<{ id: string }>(`select cap.paypal_capture_id as id from captures cap join checkouts c on c.id=cap.checkout_id
    where c.trading_session_id=$1 and cap.status='COMPLETED'`, [input.sessionId]);
  return {
    checkedAt: input.now.toISOString(), localSalesPence: input.localSalesPence, paypalSalesPence,
    totalsAgree: paypalSalesPence === null ? null : paypalSalesPence === input.localSalesPence, totalsNote,
    orders, ordersSkipped: skipped,
    transactions: await transactions(toolkit.list_transactions, opened, input.now, captures.map(row => row.id), input.log),
  };
}

type Stored = Exclude<Outcome, 'unreadable'>;
type Queryable = Pick<Pool, 'query'>;
// These describe an order with no recorded capture, so they say nothing about an order whose capture has since been recorded.
const beforeCapture = new Set<Outcome>(['capture_not_recorded', 'capture_pending', 'no_capture']);

// What PayPal last said about each of the stall's orders, from the closing checks and the ledger's own reads, latest last.
// A check that could not read PayPal says nothing about the order, so it never replaces an earlier read.
// Each entry takes the time of the read it records, so a carried read keeps the time PayPal was actually read.
export async function storedReads(db: Queryable, stallId: string) {
  const checks = (await db.query<{ check: PayPalCheck }>(`select c.paypal_check as "check" from closings c join trading_sessions t on t.id=c.trading_session_id
    where t.stall_id=$1 and c.paypal_check is not null`, [stallId])).rows.map(row => row.check).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  const reads = (await db.query<{ orderId: string; outcome: Stored; at: Date }>(`select paypal_order_id as "orderId",outcome,read_at as at
    from paypal_order_reads where stall_id=$1`, [stallId])).rows;
  const entries = [
    ...checks.flatMap(check => check.orders.map(order => order.outcome === 'unreadable' && order.lastRead
      // Checks stored before lastReadAt existed have no time for a carried read, so it sorts before every timed read.
      ? { orderId: order.orderId, outcome: order.lastRead as Outcome, at: order.lastReadAt ?? '' }
      : { orderId: order.orderId, outcome: order.outcome, at: check.checkedAt })),
    ...reads.map(row => ({ orderId: row.orderId, outcome: row.outcome as Outcome, at: row.at.toISOString() })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const orders = new Map<string, Outcome>();
  for (const entry of entries) if (entry.outcome !== 'unreadable' || !orders.has(entry.orderId)) orders.set(entry.orderId, entry.outcome);
  const latest = [...checks.map(check => check.checkedAt), ...reads.map(row => row.at.toISOString())].sort().at(-1) ?? null;
  return { orders, checks, latest };
}

export function readFor(orders: Map<string, Outcome>, orderId: string | null, captured: boolean) {
  const outcome = orderId ? orders.get(orderId) : undefined;
  return outcome && !(captured && beforeCapture.has(outcome)) ? outcome : undefined;
}

interface LedgerCheck {
  checkedAt: string; sent: number; read: number; agree: number; differ: number; notRead: number; left: number; note: string;
  // Codes and outcomes answer the owner's question. Order ids stay out, because the Stall clerk passes this to the model.
  orders: { codes: string; outcome: Outcome; note: string }[];
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The ledger's check: each captured order on the stall that has no read yet, from any session, read with get_order and stored.
// The closing page's check stays with its own session. Neither changes anything at PayPal or in the records.
export async function runLedgerCheck(db: Pool, toolkit: () => Toolkit, input: { stallId: string; now: Date; deadlineMs?: number }): Promise<LedgerCheck> {
  const { orders: known } = await storedReads(db, input.stallId);
  const { rows } = await db.query<Row>(`select c.paypal_order_id as "orderId", true as "inSession",
      coalesce((select string_agg(l.code,', ' order by l.code) from checkout_lines l where l.checkout_id=c.id),'') as codes,
      cap.captured::integer as captured,
      coalesce((select sum(r.amount_pence) from refunds r join captures done on done.paypal_capture_id=r.paypal_capture_id
        where done.checkout_id=c.id and done.status='COMPLETED' and r.status='COMPLETED'),0)::integer as refunded,
      (c.state in ${active} or c.review_required) as "flagged"
    from checkouts c join lateral (select sum(amount_pence) as captured,min(coalesce(captured_at,observed_at)) as first from captures
      where checkout_id=c.id and status='COMPLETED') cap on cap.captured is not null
    where c.stall_id=$1 and c.paypal_order_id is not null
    order by cap.first,c.created_at,c.id`, [input.stallId]);
  const unread = rows.filter(row => readFor(known, row.orderId, true) === undefined || known.get(row.orderId) === 'unreadable');
  const picked: Picked[] = unread.slice(0, orderCap).map(row => ({ ...row, unresolved: row.flagged && row.refunded === 0 }));
  const left = unread.length - picked.length;
  const checkedAt = input.now.toISOString();
  if (!picked.length) {
    return { checkedAt, sent: 0, read: 0, agree: 0, differ: 0, notRead: 0, left: 0, orders: [],
      note: rows.length ? 'Every captured order already has a PayPal read, so nothing was sent to PayPal.' : 'There are no captured orders to read, so nothing was sent to PayPal.' };
  }
  const results = await readOrders(toolkit().get_order, picked.map(row => row.orderId), Date.now() + (input.deadlineMs ?? 60_000));
  const orders = picked.map((row, index) => ({ row, ...compare(row, results[index]!) }));
  const done = orders.filter(order => order.outcome !== 'unreadable');
  if (done.length) {
    await db.query(`insert into paypal_order_reads (stall_id,paypal_order_id,outcome,read_at) select $1,unnest($2::text[]),unnest($3::text[]),$4
      on conflict (stall_id,paypal_order_id) do update set outcome=excluded.outcome,read_at=excluded.read_at`,
    [input.stallId, done.map(order => order.row.orderId), done.map(order => order.outcome), input.now]);
  }
  const agree = done.filter(order => order.outcome === 'agrees').length;
  const differ = done.filter(order => order.outcome === 'differs' || order.outcome === 'capture_not_recorded').length;
  const notRead = picked.length - done.length;
  const note = [
    done.length ? `PayPal read ${plural(done.length, 'order', 'orders')}: ${agree} ${agree === 1 ? 'agrees' : 'agree'} with the record${differ ? `, ${differ} ${differ === 1 ? 'differs' : 'differ'}` : ''}.` : 'PayPal could not be read just now.',
    notRead ? `${plural(notRead, 'order was', 'orders were')} not read this time, so earlier results stand.` : '',
    left ? `${plural(left, 'more order is', 'more orders are')} left to read, because one check reads at most ${orderCap}. Check again to read them.` : '',
  ].filter(Boolean).join(' ');
  return { checkedAt, sent: picked.length, read: done.length, agree, differ, notRead, left, note,
    orders: orders.map(order => ({ codes: order.row.codes, outcome: order.outcome, note: order.note })) };
}
