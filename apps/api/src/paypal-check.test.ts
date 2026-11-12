import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { closedStall } from '../test/closed-stall.js';
import { testDatabase } from '../test/database.js';
import { repairClosings } from './closing.js';
import { installedToolkit, runPayPalCheck, type CheckLog, type Toolkit } from './paypal-check.js';
const db = testDatabase();
let stall: Awaited<ReturnType<typeof closedStall>>;
afterEach(async () => { await stall.app.close(); });

const order = (id: string, captures: Array<{ status: string; value: string; id?: string }>, refunds: string[] = []) => JSON.stringify({ id, status: 'COMPLETED', purchase_units: [{ payments: {
  captures: captures.map(capture => ({ id: capture.id ?? `CAP-${id}`, status: capture.status, amount: { currency_code: 'GBP', value: capture.value } })),
  refunds: refunds.map(value => ({ id: `REF-${id}`, status: 'COMPLETED', amount: { currency_code: 'GBP', value } })) } }] });
const denied = JSON.stringify({ ok: false, status: 403, code: 'PAYPAL_API_HTTP_ERROR', message: 'Authorization failed due to insufficient permissions.' });
function fake(orders: (id: string) => string, listing: string = denied) {
  const get = vi.fn(async (args: Record<string, unknown>) => orders(String(args.id)));
  const list = vi.fn(async () => listing);
  const toolkit = { get_order: { execute: get }, list_transactions: { execute: list } } as unknown as Toolkit;
  return { toolkit, get, list };
}
const check = async () => (await stall.post('/api/owner/closing/paypal-check')).json();
const notRead = "PayPal's transaction list was not read";
const direct = async (toolkit: Toolkit, sessionId: string, log: CheckLog) => runPayPalCheck(db, toolkit, { stallId: (await db.query('select stall_id from trading_sessions where id=$1', [sessionId])).rows[0].stall_id, sessionId, localSalesPence: 2800, now: new Date('2026-11-05T12:00:00Z'), log });
const rows = async () => (await db.query("select (select count(*) from checkouts) as checkouts, (select count(*) from captures) as captures, (select count(*) from refunds) as refunds, (select string_agg(state,',') from checkouts) as states")).rows[0];

it('reads each order through get_order, agrees with the local totals, and says when transaction listing was refused', async () => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]));
  stall = await closedStall(db, { toolkit: tools.toolkit });
  const sale = await stall.sell(); await stall.close();
  const before = await rows();
  const { paypalCheck } = await check();
  expect(paypalCheck).toMatchObject({ localSalesPence: 2800, paypalSalesPence: 2800, totalsAgree: true, ordersSkipped: 0,
    orders: [{ orderId: sale.paypalOrderId, codes: stall.item.code, outcome: 'agrees', localNetPence: 2800, paypalNetPence: 2800, unresolved: false }],
    transactions: { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal refused it for this app." } });
  expect(JSON.stringify(paypalCheck)).not.toContain('Transaction Search');
  expect(tools.get).toHaveBeenCalledWith({ id: sale.paypalOrderId }, expect.anything());
  expect(await rows()).toEqual(before);
  expect((await stall.get()).paypalCheck).toEqual(paypalCheck);
});
it('calls a recorded capture that PayPal still holds after a full local refund a difference, not an unrecorded capture', async () => {
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }])).toolkit });
  await stall.sell(); await stall.close();
  await db.query("insert into refunds (paypal_refund_id,paypal_capture_id,amount_pence,status) select 'REF1',paypal_capture_id,2800,'COMPLETED' from captures");
  expect((await check()).paypalCheck.orders[0]).toMatchObject({ outcome: 'differs', localNetPence: 0, paypalNetPence: 2800 });
});
// A sale in an earlier session was refunded, which flags its checkout for review, so a later session's check reads it too.
// It nets £0 on both sides and agrees, so the page must not count it as one of this session's orders.
it('marks an earlier session\'s refunded order as not in this session', async () => {
  stall = await closedStall(db, { toolkit: fake(id => id === 'ORDER1' ? order(id, [{ status: 'REFUNDED', value: '28.00' }], ['28.00']) : order(id, [{ status: 'COMPLETED', value: '28.00' }])).toolkit });
  await stall.sell(); const first = await stall.close();
  await db.query("insert into refunds (paypal_refund_id,paypal_capture_id,amount_pence,status) values ('REF1','CAP-ORDER1',2800,'COMPLETED')");
  await db.query("update checkouts set review_required=true,review_reason='Payment refunded. Collection withdrawn.'");
  await stall.observe(first.sessionId, 'absent');
  await repairClosings(db, new Date('2026-11-05T12:00:00Z'));
  await db.query("update items set status='available', reserved_checkout_id=null");
  expect((await stall.post('/api/owner/stall/open')).statusCode).toBe(201);
  await stall.sell(); await stall.close();
  const { paypalCheck } = await check();
  expect(paypalCheck).toMatchObject({ localSalesPence: 2800, paypalSalesPence: 2800, totalsAgree: true, orders: [
    { orderId: 'ORDER1', inSession: false, outcome: 'agrees', localNetPence: 0, paypalNetPence: 0 },
    { orderId: 'ORDER2', inSession: true, outcome: 'agrees', localNetPence: 2800, paypalNetPence: 2800 },
  ] });
});
it('describes a completed capture that the local record has not confirmed, without changing it', async () => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]));
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.sell(true); await stall.close();
  const before = await rows();
  const { paypalCheck } = await check();
  expect(paypalCheck.orders[0]).toMatchObject({ outcome: 'capture_not_recorded', unresolved: true, localNetPence: 0, paypalNetPence: 2800, note: expect.stringContaining('Check payment again') });
  expect(paypalCheck).toMatchObject({ localSalesPence: 0, paypalSalesPence: 2800, totalsAgree: false });
  expect(await rows()).toEqual(before);
});
it('compares totals after refunds and reports a difference neutrally', async () => {
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'REFUNDED', value: '28.00' }], ['4.00'])).toolkit });
  await stall.sell(); await stall.close();
  const { paypalCheck } = await check();
  expect(paypalCheck.orders[0]).toMatchObject({ outcome: 'differs', paypalNetPence: 2400, note: 'PayPal shows £24.00 after refunds. This record has £28.00.' });
  expect(paypalCheck.totalsAgree).toBe(false);
});
it('keeps what PayPal last said through rechecks in an outage, and the closing report still says the order was not read', async () => {
  let reply = (id: string) => order(id, [{ status: 'COMPLETED', value: '28.00' }]);
  stall = await closedStall(db, { toolkit: fake(id => reply(id)).toolkit });
  await stall.sell(); await stall.close();
  const row = async () => (await stall.app.inject({ url: '/api/owner/ledger/data', cookies: stall.owner })).json().ledger[0];
  await check();
  expect(await row()).toMatchObject({ paypalCheck: 'PayPal agrees' });
  reply = () => denied;
  await check();
  expect((await check()).paypalCheck).toMatchObject({ orders: [{ outcome: 'unreadable' }], totalsAgree: null });
  expect(await row()).toMatchObject({ paypalCheck: 'PayPal agrees' });
  expect((await stall.get()).paypalCheck).toMatchObject({ orders: [{ outcome: 'unreadable' }] });
  reply = id => order(id, [{ status: 'COMPLETED', value: '20.00' }]);
  await check();
  expect(await row()).toMatchObject({ paypalCheck: 'PayPal differs' });
  reply = () => denied;
  await check();
  expect(await row()).toMatchObject({ paypalCheck: 'PayPal differs' });
});
it('does not claim a total when PayPal cannot be read or a capture is still pending', async () => {
  stall = await closedStall(db, { toolkit: fake(() => denied).toolkit });
  await stall.sell(); await stall.close();
  expect((await check()).paypalCheck).toMatchObject({ orders: [{ outcome: 'unreadable', paypalNetPence: null }], paypalSalesPence: null, totalsAgree: null, totalsNote: 'PayPal data was unavailable, so totals could not be compared.' });
  await stall.app.close();
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'PENDING', value: '28.00' }])).toolkit });
  await stall.sell(true); await stall.close();
  expect((await check()).paypalCheck).toMatchObject({ orders: [{ outcome: 'capture_pending' }], totalsAgree: null, totalsNote: expect.stringContaining('still pending') });
});
it('claims no match when the session has no PayPal orders to check', async () => {
  const tools = fake(() => denied);
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.close();
  expect((await check()).paypalCheck).toMatchObject({ orders: [], paypalSalesPence: null, totalsAgree: null, totalsNote: 'There were no PayPal orders to check for this session.' });
  expect(tools.get).not.toHaveBeenCalled();
});
it('claims no match when PayPal shows no capture and nothing is recorded', async () => {
  stall = await closedStall(db, { toolkit: fake(id => order(id, [])).toolkit });
  await stall.sell(true); await stall.close();
  expect((await check()).paypalCheck).toMatchObject({ orders: [{ outcome: 'no_capture' }], localSalesPence: 0, paypalSalesPence: null, totalsAgree: null, totalsNote: expect.stringContaining('no total to compare') });
});
const wrapperError = JSON.stringify({ error: { message: 'token failed', type: 'paypal_error' } });
const unavailable = { orders: [{ outcome: 'unreadable', paypalNetPence: null }], paypalSalesPence: null, totalsAgree: null, totalsNote: 'PayPal data was unavailable, so totals could not be compared.' };
it.each([
  ['a toolkit error body, with a sale recorded', wrapperError, false],
  ['a toolkit error body, with nothing recorded', wrapperError, true],
  ['a body with no order in it', '{}', false],
])('reports PayPal data as unavailable for %s', async (_name, body, pending) => {
  stall = await closedStall(db, { toolkit: fake(() => body, body).toolkit });
  await stall.sell(pending); await stall.close();
  const { paypalCheck } = await check();
  expect(paypalCheck).toMatchObject(unavailable);
  if (body === wrapperError) expect(paypalCheck.transactions).toEqual({ status: 'unavailable', note: "PayPal's transaction list was not read: PayPal could not list it just now." });
});
it('says how many orders were left out when there are more than one check reads', async () => {
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }])).toolkit });
  await stall.sell(); await stall.close();
  await db.query(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,paypal_order_id,reservation_deadline)
    select stall_id,trading_session_id,buyer_session_id,'expired',total_pence,checkout_key,gen_random_uuid(),gen_random_uuid(),'EXTRA'||n,reservation_deadline from checkouts, generate_series(1,41) n`);
  expect((await check()).paypalCheck).toMatchObject({ ordersSkipped: 2, totalsAgree: null, totalsNote: '2 orders were not checked, because this check reads at most 40, so totals could not be compared.' });
});
it('lists transactions when PayPal allows it, and counts captures not listed yet', async () => {
  const listing = (ids: string[]) => JSON.stringify({ transaction_details: ids.map(transaction_id => ({ transaction_info: { transaction_id } })), total_pages: 1 });
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]), listing(['OTHER'])).toolkit });
  const sale = await stall.sell(); await stall.close();
  expect((await check()).paypalCheck.transactions).toMatchObject({ status: 'ran', listed: 1, missing: 1 });
  await stall.app.close();
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]), listing([`CAP-ORDER1`])).toolkit });
  await stall.sell(); await stall.close();
  expect(sale.paypalOrderId).toBe('ORDER1');
  expect((await check()).paypalCheck.transactions).toMatchObject({ status: 'ran', listed: 1, missing: 0, note: expect.stringContaining('few hours') });
});
// A window starting seconds before the check was not read on the hosted stall, while one starting hours earlier was, so the window starts at least a day back.
it.each([
  ['a session opened minutes ago', '2026-11-05T11:55:00Z', '2026-11-04T12:00:00.000Z'],
  ['a session opened more than a day ago', '2026-11-03T08:00:00Z', '2026-11-03T08:00:00.000Z'],
  ['a session opened more than 30 days ago', '2026-09-01T08:00:00Z', '2026-10-06T12:00:00.000Z'],
])('asks PayPal for transactions from at least a day back, and at most 30 days, for %s', async (_name, opened, start) => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]));
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.sell(); await stall.close();
  await db.query('update trading_sessions set opened_at=$1', [opened]);
  await check();
  expect(tools.list).toHaveBeenCalledWith({ start_date: start, end_date: '2026-11-05T12:00:00.000Z', page_size: 100 }, expect.anything());
});
const token = 'A21AAFakeAccessTokenValue0123456789abcdefXYZ';
const refusal = `Data for the given start date is not available. Bearer ${token}`;
// The first two bodies are the two the installed toolkit returns for a failed call. It does not pass on PayPal's error name, debug id or headers, so the third is a body it does not send.
it.each([
  ["PayPal's error as the toolkit passes it on", { ok: false, status: 400, code: 'PAYPAL_API_HTTP_ERROR', message: refusal },
    { status: 400, code: 'PAYPAL_API_HTTP_ERROR', message: 'Data for the given start date is not available. Bearer [removed]' }],
  ["the toolkit's own error", { error: { message: refusal, type: 'paypal_error' } },
    { status: null, code: 'paypal_error', message: 'Data for the given start date is not available. Bearer [removed]' }],
  ["a body that also carries PayPal's error name, debug id and headers", { ok: false, status: 400, code: 'PAYPAL_API_HTTP_ERROR', name: 'INVALID_REQUEST', debug_id: 'f1d2e3a4b5c6d', message: refusal, headers: { authorization: `Bearer ${token}` } },
    { status: 400, code: 'PAYPAL_API_HTTP_ERROR', name: 'INVALID_REQUEST', debugId: 'f1d2e3a4b5c6d', message: 'Data for the given start date is not available. Bearer [removed]' }],
])('logs what PayPal said when the transaction list was not read, with no token in it, for %s', async (_name, body, logged) => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]), JSON.stringify(body));
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.sell(); const closing = await stall.close();
  const log = vi.fn();
  const result = await direct(tools.toolkit, closing.sessionId, log);
  expect(result.transactions).toEqual({ status: 'unavailable', note: `${notRead}: PayPal could not list it just now.` });
  expect(log).toHaveBeenCalledWith(logged, notRead);
  expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  expect(JSON.stringify(result)).not.toMatch(/start date|PAYPAL_API_HTTP_ERROR|paypal_error|f1d2e3a4b5c6d|INVALID_REQUEST/);
});
it('logs a toolkit error given as a plain string when the transaction list was not read, with no token in it', async () => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]), JSON.stringify({ error: `Failed to list transactions. Bearer ${token}` }));
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.sell(); const closing = await stall.close();
  const log = vi.fn();
  await direct(tools.toolkit, closing.sessionId, log);
  expect(log).toHaveBeenCalledWith({ status: null, message: 'Failed to list transactions. Bearer [removed]' }, notRead);
});
it('logs a transaction list read that timed out under its own name', async () => {
  const tools = fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }]));
  let asked!: () => void;
  const listing = new Promise<void>(resolve => { asked = resolve; });
  tools.list.mockImplementation(() => { asked(); return new Promise<string>(() => undefined); });
  stall = await closedStall(db, { toolkit: tools.toolkit });
  await stall.sell(); const closing = await stall.close();
  const log = vi.fn();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true });
  try {
    const result = direct(tools.toolkit, closing.sessionId, log);
    await listing;
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await result).transactions).toEqual({ status: 'unavailable', note: `${notRead}: PayPal could not list it just now.` });
  } finally { vi.useRealTimers(); }
  expect(log).toHaveBeenCalledWith({ status: null, name: 'TimeoutError' }, notRead);
});
it('needs a closing report before it reads anything', async () => {
  const tools = fake(() => denied);
  stall = await closedStall(db, { toolkit: tools.toolkit });
  expect((await stall.post('/api/owner/closing/paypal-check')).statusCode).toBe(409);
  expect(tools.get).not.toHaveBeenCalled();
});
it('holds exactly get_order and list_transactions from the installed package, and no tool that moves money', () => {
  const everything = new PayPalAgentToolkit({ clientId: 'x', clientSecret: 'y', configuration: { actions: Object.fromEntries(['orders', 'transactions', 'payments', 'invoices', 'disputes', 'subscriptions'].map(product => [product, { create: true, get: true, list: true, capture: true, createRefund: true }])), context: { sandbox: true } } });
  expect(Object.keys(everything.getTools())).toEqual(expect.arrayContaining(['get_order', 'list_transactions', 'create_order', 'pay_order', 'create_refund']));
  expect(Object.keys(installedToolkit('x', 'y')).sort()).toEqual(['get_order', 'list_transactions']);
});
// The hosted stall holds checks stored with the old sentence, which told the owner to change a PayPal app setting.
it('shows a check stored before the wording changed in the current wording', async () => {
  stall = await closedStall(db, { toolkit: fake(id => order(id, [{ status: 'COMPLETED', value: '28.00' }])).toolkit });
  await stall.sell(); const closing = await stall.close();
  const { paypalCheck } = await check();
  const old = { ...paypalCheck, transactions: { status: 'unavailable', note: 'PayPal refused transaction listing for this app, so this cross-check did not run. Transaction Search must be enabled on the PayPal app.' } };
  await db.query('update closings set paypal_check=$2 where id=$1', [closing.id, JSON.stringify(old)]);
  expect((await stall.get()).paypalCheck).toEqual({ ...old, transactions: { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal refused it for this app." } });
});
