import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', webhookId: 'test', publicBaseUrl: 'http://localhost:5173', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false };
let app: ReturnType<typeof buildApp>;
let now: Date;
let owner: Record<string, string>;
let item: { id: string; code: string };
let sequence: number;
let captureState: string;
const orders = new Map<string, string>();
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const post = (url: string, cookies = owner, payload?: object) => app.inject({ method: 'POST', url, cookies, ...(payload ? { payload } : {}) });
const close = () => post('/api/owner/stall/close');
const read = async () => (await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing;
const add = async (name = 'Lamp') => (await post('/api/owner/items', owner, { name, notes: 'Tested', mode: 'fixed', askingPence: 2800 })).json();
const buyer = async () => ({ stallkeeper_buyer: (await app.inject(`/api/i/${item.code}`)).cookies[0]!.value });
const pay = (cookies: Record<string, string>) => post(`/api/i/${item.code}/checkout`, cookies, {});
const capture = (id: string, cookies: Record<string, string>) => post(`/api/checkouts/${id}/capture`, cookies);
const observe = (report: { sessionId: string }, observation: string, itemId = item.id, reason?: string, cookies = owner) => app.inject({ method: 'PUT', url: '/api/owner/closing/shelf-check', cookies, payload: { sessionId: report.sessionId, itemId, observation, ...(reason ? { reason } : {}) } });
async function restart() { await app.close(); app = buildApp(config, { db, fetcher, now: () => now }); await app.ready(); }
function evidence(orderId: string) {
  return { id: orderId, purchase_units: [{ custom_id: orders.get(orderId), payments: { captures: [{ id: `CAP-${orderId}`, status: captureState, amount: { value: '28.00', currency_code: 'GBP' } }] } }] };
}
async function webhook(orderId: string, type = 'COMPLETED', captureValue = '28.00') {
  return app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers: {
    'paypal-auth-algo': 'test', 'paypal-cert-url': 'test', 'paypal-transmission-id': 'test', 'paypal-transmission-sig': 'test', 'paypal-transmission-time': 'test',
  }, payload: { id: `EVENT-${orderId}-${type}`, event_type: `PAYMENT.CAPTURE.${type}`, resource: {
    id: type === 'REFUNDED' ? `REF-${orderId}` : `CAP-${orderId}`, status: 'COMPLETED',
    amount: { value: type === 'REFUNDED' ? '4.00' : captureValue, currency_code: 'GBP' },
    supplementary_data: { related_ids: { order_id: orderId, capture_id: `CAP-${orderId}` } },
  } } });
}
beforeEach(async () => {
  await db.query('truncate items,buyer_sessions,trading_sessions,webhook_inbox cascade');
  now = new Date(); sequence = 0; captureState = 'COMPLETED'; orders.clear();
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (path.endsWith('/verify-webhook-signature')) return Response.json({ verification_status: 'SUCCESS' });
    if (path.endsWith('/capture')) return Response.json(evidence(path.split('/').at(-2)!));
    const id = `ORDER${++sequence}`;
    orders.set(id, JSON.parse(String(init?.body)).purchase_units[0].custom_id);
    return Response.json({ id });
  });
  app = buildApp(config, { db, fetcher, now: () => now });
  owner = { stallkeeper_owner: (await post('/api/owner/login', {}, { password: 'owner' })).cookies[0]!.value };
  item = await add();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
});
afterEach(async () => { await app.close(); });
it('reports at once with no shelf check, counts an unsold item as still at the stall, and never calls the report matched', async () => {
  const first = (await close()).json();
  expect(first).toMatchObject({ status: 'final', sessionStatus: 'closing', recordedSalesPence: 0, paidCheckouts: 0, itemsSold: 0 });
  expect(first.items).toEqual([expect.objectContaining({ id: item.id, observation: 'unknown' })]);
  expect(first.groups.find((g: { key: string }) => g.key === 'unsoldPresent')).toMatchObject({ label: 'Unsold, still at the stall', items: [expect.objectContaining({ id: item.id })] });
  expect(first.groups.map((g: { key: string }) => g.key)).not.toContain('unknown');
  expect(JSON.stringify(first)).not.toMatch(/matched/i);
  expect((await close()).json().id).toBe(first.id);
  expect((await read()).id).toBe(first.id);
  expect((await db.query('select * from closings')).rowCount).toBe(1);
  expect((await db.query('select * from shelf_checks')).rows[0]).toMatchObject({ observation: 'unknown', observed_at: null });
});
it('serialises Close racing admission, and never admits another buyer after Close', async () => {
  const cookies = await buyer(); const other = await buyer();
  const [closing, checkout] = await Promise.all([close(), pay(cookies)]);
  expect(closing.statusCode).toBe(200);
  expect([200, 409]).toContain(checkout.statusCode);
  expect((await pay(other)).statusCode).toBe(409);
  if (checkout.statusCode === 200) expect((await capture(checkout.json().checkoutId, cookies)).json().state).toBe('paid');
  expect((await db.query('select status from trading_sessions')).rows[0].status).toBe('closing');
});
it('waits for the same session row lock as admission', async () => {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    await tx.query('select id from trading_sessions for update');
    let completed = false;
    const closing = close().then(response => { completed = true; return response; });
    await vi.waitFor(async () => {
      const waits = await db.query("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%trading_sessions%'");
      expect(waits.rowCount).toBeGreaterThan(0);
    });
    expect(completed).toBe(false);
    await tx.query('commit');
    expect((await closing).statusCode).toBe(200);
  } finally { await tx.query('rollback'); tx.release(); }
});
it('allows capture racing Close within the original deadline without extending it', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  const [closing, payment] = await Promise.all([close(), capture(c.checkoutId, cookies)]);
  expect(closing.statusCode).toBe(200); expect(payment.json().state).toBe('paid');
  expect(payment.json().reservedUntil).toBe(c.reservedUntil);
  expect((await pay(await buyer())).statusCode).toBe(409);
});
it('rejects capture at the original deadline after Close and closes through repair', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); await close();
  now = new Date(c.reservedUntil);
  expect((await capture(c.checkoutId, cookies)).statusCode).toBe(409);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/capture'))).toHaveLength(0);
  await restart();
  expect((await read()).sessionStatus).toBe('closed');
  expect((await read()).status).toBe('final');
});
it('keeps unresolved captures active beyond the cutoff and regenerates on late evidence and refunds', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); captureState = 'PENDING';
  expect((await capture(c.checkoutId, cookies)).json().state).toBe('checking');
  const report = (await close()).json(); await observe(report, 'absent');
  now = new Date(new Date(c.reservedUntil).getTime() + 60_000); await restart();
  expect((await read())).toMatchObject({ sessionStatus: 'closing', status: 'provisional', recordedSalesPence: 0 });
  expect((await read()).groups.find((g: { key: string }) => g.key === 'unresolved').items).toHaveLength(1);
  expect((await webhook(c.paypalOrderId)).statusCode).toBe(200);
  await restart();
  const persisted = (await db.query('select * from closings')).rows[0];
  expect(persisted.totals).toMatchObject({ id: report.id, status: 'final', sessionStatus: 'closed', recordedSalesPence: 2800, paidCheckouts: 1, itemsSold: 1 });
  expect(persisted.totals.groups.find((g: { key: string }) => g.key === 'paidAbsent').items).toHaveLength(1);
  expect((await webhook(c.paypalOrderId, 'REFUNDED')).statusCode).toBe(200);
  await restart();
  expect((await db.query('select * from closings')).rows).toEqual([expect.objectContaining({ id: report.id, status: 'final', totals: expect.objectContaining({ recordedSalesPence: 2400, refundedPence: 400, paidCheckouts: 1, itemsSold: 1 }) })]);
  expect((await read()).groups.find((g: { key: string }) => g.key === 'paidAbsent').items).toEqual([expect.objectContaining({ id: item.id, refunded: true })]);
});
it('keeps a capture in flight reserved when Close and the deadline pass', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const paying = capture(c.checkoutId, cookies);
  await vi.waitFor(() => expect(finish).toBeDefined());
  await close(); now = new Date(new Date(c.reservedUntil).getTime() + 1000);
  expect((await read()).status).toBe('provisional');
  finish(Response.json(evidence(c.paypalOrderId)));
  expect((await paying).json().state).toBe('paid');
  await restart(); expect((await read()).sessionStatus).toBe('closed');
});
it('snapshots opening stock and additions, retains later removals, and starts a fresh session on reopening', async () => {
  const removed = await add('Removed during session');
  await post(`/api/owner/items/${removed.id}/remove`, owner, { reason: 'Kept it' });
  const report = (await close()).json();
  expect(report.items.map((i: { id: string }) => i.id).sort()).toEqual([item.id, removed.id].sort());
  expect(report.items.find((i: { id: string }) => i.id === item.id).observation).toBe('unknown');
  expect(report.items.find((i: { id: string }) => i.id === removed.id)).toMatchObject({ observation: 'removed', reason: 'Kept it' });
  expect((await observe(report, 'removed', removed.id)).statusCode).toBe(400);
  expect((await observe(report, 'removed', removed.id, 'Kept it')).statusCode).toBe(200);
  const checked = (await observe(report, 'present')).json().closing;
  expect(checked.status).toBe('final'); expect(checked.removed[0].reason).toBe('Kept it');
  expect(checked.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items).toHaveLength(1);
  await restart();
  const addedAfter = await add('Next session');
  expect((await read()).items).toHaveLength(2);
  const opened = (await post('/api/owner/stall/open')).json(); expect(opened.id).not.toBe(report.sessionId);
  const next = (await close()).json();
  expect(next.items.map((i: { id: string }) => i.id).sort()).toEqual([item.id, addedAfter.id].sort());
  expect(next.items.every((i: { observation: string }) => i.observation === 'unknown')).toBe(true);
});
it('marks the report as an earlier session, with its closing time, only once the stall has reopened', async () => {
  const report = (await close()).json();
  expect(report.earlierClosedAt).toBeNull();
  await restart();
  expect((await read()).earlierClosedAt).toBeNull();
  const closedAt = new Date(now.getTime() + 60_000);
  await db.query("update trading_sessions set closed_at=$2 where id=$1", [report.sessionId, closedAt]);
  await post('/api/owner/stall/open');
  expect((await read()).earlierClosedAt).toBe(closedAt.toISOString());
  await close();
  expect((await read()).earlierClosedAt).toBeNull();
});
it('does not accuse for an item the owner flags as not at the stall, and allows undoing the flag', async () => {
  const report = (await close()).json();
  const absent = (await observe(report, 'absent')).json().closing;
  expect(absent.groups.find((g: { key: string }) => g.key === 'unpaidAbsent')).toMatchObject({ label: 'Not on the shelf, no confirmed payment. This record cannot say what happened.', items: [expect.objectContaining({ id: item.id })] });
  const undone = (await observe(report, 'unknown')).json().closing;
  expect(undone).toMatchObject({ status: 'final' });
  expect(undone.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items).toEqual([expect.objectContaining({ id: item.id })]);
});
it('scopes closing and shelf changes to the signed owner cookie', async () => {
  const report = (await close()).json();
  expect((await post('/api/owner/stall/close', {})).statusCode).toBe(401);
  const demo = { stallkeeper_owner: (await post('/api/owner/login', {}, { password: 'demo' })).cookies[0]!.value };
  expect((await app.inject({ url: '/api/owner/closing', cookies: demo })).json().closing).toBeNull();
  expect((await observe(report, 'absent', item.id, undefined, demo)).statusCode).toBe(404);
  expect((await read()).items[0].observation).toBe('unknown');
});
it('counts confirmed money separately from items sold when late payment needs review', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); const report = (await close()).json();
  now = new Date(c.reservedUntil); await restart();
  await observe(report, 'present');
  expect((await webhook(c.paypalOrderId)).statusCode).toBe(200);
  await restart();
  expect(await read()).toMatchObject({ status: 'provisional', recordedSalesPence: 2800, paidCheckouts: 1, itemsSold: 0 });
  expect((await read()).groups.find((g: { key: string }) => g.key === 'unresolved').items).toHaveLength(1);
});
it('excludes items already sold when the next session opens', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  expect((await capture(c.checkoutId, cookies)).json().state).toBe('paid');
  const first = (await close()).json();
  expect(first.groups.find((g: { key: string }) => g.key === 'paidAbsent')).toMatchObject({ label: 'Sold, gone with the buyer', items: [expect.objectContaining({ id: item.id })] });
  expect(first).toMatchObject({ status: 'final' });
  await restart();
  const nextItem = await add('Mirror');
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  const second = (await close()).json();
  expect(second.items.map((i: { id: string }) => i.id)).toEqual([nextItem.id]);
  expect(second.recordedSalesPence).toBe(0);
});
it('lets a flagged checkout close the session and reopen, listing it as unresolved', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); captureState = 'PENDING';
  expect((await capture(c.checkoutId, cookies)).json().state).toBe('checking');
  const report = (await close()).json(); await observe(report, 'present');
  expect((await webhook(c.paypalOrderId, 'COMPLETED', '27.00')).statusCode).toBe(200);
  expect((await db.query('select state,review_required from checkouts')).rows[0]).toEqual({ state: 'checking', review_required: true });
  await restart();
  expect(await read()).toMatchObject({ sessionStatus: 'closed', status: 'provisional' });
  expect((await read()).groups.find((g: { key: string }) => g.key === 'unresolved').items).toEqual([expect.objectContaining({ id: item.id })]);
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
});
it('takes a shelf check removal out of sale and out of the next session', async () => {
  const report = (await close()).json();
  expect((await observe(report, 'removed', item.id, 'Sold for cash')).statusCode).toBe(200);
  expect((await db.query('select status,removed_reason from items where id=$1', [item.id])).rows[0]).toEqual({ status: 'removed', removed_reason: 'Sold for cash' });
  await restart();
  const cookies = await buyer();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  expect((await app.inject('/api/stall')).json().items).toEqual([]);
  expect((await pay(cookies)).statusCode).toBe(409);
  expect((await close()).json().items).toEqual([]);
});
it('keeps the stock list and closing report on the edited removal reason', async () => {
  const report = (await close()).json();
  await observe(report, 'removed', item.id, 'Sold for cash');
  const edited = await observe(report, 'removed', item.id, 'Given away');
  expect(edited.json().closing.items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ observation: 'removed', reason: 'Given away' });
  expect((await app.inject({ method: 'GET', url: '/api/owner/items', cookies: owner })).json().items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ status: 'removed', removedReason: 'Given away' });
});
it('leaves other shelf observations on sale', async () => {
  const report = (await close()).json();
  await observe(report, 'absent'); await observe(report, 'unknown');
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('available');
});
it('refuses a shelf check removal while a payment holds the item', async () => {
  const c = (await pay(await buyer())).json(); const report = (await close()).json();
  const refused = await observe(report, 'removed', item.id, 'Sold for cash');
  expect(refused.statusCode).toBe(409);
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('available');
  expect((await read()).items[0].observation).toBe('unknown');
  now = new Date(c.reservedUntil);
  expect((await observe(report, 'removed', item.id, 'Sold for cash')).statusCode).toBe(200);
});
it('labels an item by completed captures from earlier sessions, keeping money per session', async () => {
  const c = (await pay(await buyer())).json(); await close();
  now = new Date(c.reservedUntil); await restart();
  expect((await webhook(c.paypalOrderId)).statusCode).toBe(200);
  await restart();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  const next = (await close()).json();
  const flagged = (await observe(next, 'absent')).json().closing;
  expect(flagged).toMatchObject({ status: 'provisional', recordedSalesPence: 0, paidCheckouts: 0 });
  expect(flagged.groups.find((g: { key: string }) => g.key === 'unresolved').items).toEqual([expect.objectContaining({ id: item.id, paid: true })]);
  expect((await webhook(c.paypalOrderId, 'REFUNDED')).statusCode).toBe(200);
  const refunded = await read();
  expect(refunded).toMatchObject({ status: 'final', recordedSalesPence: 0, refundedPence: 0 });
  expect(refunded.groups.find((g: { key: string }) => g.key === 'unpaidAbsent').items).toEqual([]);
  expect(refunded.groups.find((g: { key: string }) => g.key === 'paidAbsent').items).toEqual([expect.objectContaining({ id: item.id })]);
});
it('leaves an earlier report unchanged when the item trades in a later session', async () => {
  const first = (await observe((await close()).json(), 'present')).json().closing;
  expect(first.status).toBe('final');
  await restart();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  const unchanged = async () => {
    const report = await read();
    expect(report).toMatchObject({ sessionId: first.sessionId, status: 'final', recordedSalesPence: 0, paidCheckouts: 0, itemsSold: 0 });
    expect(report.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items).toEqual([expect.objectContaining({ id: item.id, paid: false, unresolved: false })]);
  };
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  expect(c.state).toBe('awaiting_approval');
  await unchanged();
  expect((await capture(c.checkoutId, cookies)).json().state).toBe('paid');
  await unchanged();
});
it('puts an item back on sale when a shelf check removal is corrected', async () => {
  const report = (await close()).json();
  await observe(report, 'removed', item.id, 'Sold for cash');
  await observe(report, 'removed', item.id, 'Given away');
  const corrected = (await observe(report, 'present')).json().closing;
  expect(corrected.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items).toHaveLength(1);
  expect((await db.query('select status,removed_at,removed_reason from items where id=$1', [item.id])).rows[0]).toEqual({ status: 'available', removed_at: null, removed_reason: null });
  await restart();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  expect((await app.inject('/api/stall')).json().items).toEqual([expect.objectContaining({ code: item.code, availability: 'available' })]);
  expect((await close()).json().items).toEqual([expect.objectContaining({ id: item.id })]);
});
it('adds a corrected item to the session already open', async () => {
  const report = (await close()).json();
  await observe(report, 'removed', item.id, 'Sold for cash');
  await restart();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  await observe(report, 'absent');
  expect((await close()).json().items).toEqual([expect.objectContaining({ id: item.id })]);
});
async function removeDuringNextSession() {
  const first = (await close()).json();
  await restart();
  expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
  expect((await observe(first, 'removed', item.id, 'Sold for cash')).statusCode).toBe(200);
  return (await close()).json();
}
it('restores an item from the next report when an earlier report took it off sale', async () => {
  const second = await removeDuringNextSession();
  expect(second.items).toEqual([expect.objectContaining({ id: item.id })]);
  await observe(second, 'removed', item.id, 'Sold for cash');
  await observe(second, 'present');
  expect((await db.query('select status,removed_reason from items where id=$1', [item.id])).rows[0]).toEqual({ status: 'available', removed_reason: null });
  expect((await db.query('select took_off_sale from shelf_checks')).rows).toEqual([{ took_off_sale: false }, { took_off_sale: false }]);
  await post(`/api/owner/items/${item.id}/remove`, owner, { reason: 'Kept it' });
  await observe(second, 'removed', item.id, 'Kept it');
  await observe(second, 'absent');
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('removed');
});
it('keeps an item off sale when a report that never recorded the removal is checked', async () => {
  const second = await removeDuringNextSession();
  await observe(second, 'present');
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('removed');
});
it('records an item taken off sale before close as removed, not as unsold', async () => {
  const lamp = await add('Second lamp');
  await post(`/api/owner/items/${lamp.id}/remove`, owner, { reason: 'Chipped base' });
  const report = (await close()).json();
  expect(report.removed).toEqual([expect.objectContaining({ id: lamp.id, observation: 'removed', reason: 'Chipped base' })]);
  expect(report.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items.map((i: { id: string }) => i.id)).toEqual([item.id]);
  expect((await db.query('select observed_at,took_off_sale from shelf_checks where item_id=$1', [lamp.id])).rows[0]).toEqual({ observed_at: null, took_off_sale: false });
});
it('leaves an owner removal alone when the shelf observation changes', async () => {
  await post(`/api/owner/items/${item.id}/remove`, owner, { reason: 'Kept it' });
  const report = (await close()).json();
  await observe(report, 'removed', item.id, 'Kept it');
  await observe(report, 'present');
  expect((await db.query('select status,removed_reason from items where id=$1', [item.id])).rows[0]).toEqual({ status: 'removed', removed_reason: 'Kept it' });
});
it('keeps a removed item off sale on correction once a completed capture exists', async () => {
  const c = (await pay(await buyer())).json(); const report = (await close()).json();
  now = new Date(c.reservedUntil); await restart();
  expect((await observe(report, 'removed', item.id, 'Sold for cash')).statusCode).toBe(200);
  expect((await webhook(c.paypalOrderId)).statusCode).toBe(200);
  await observe(report, 'present');
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('removed');
});
it('keeps the edited reason in step after a correction was refused by a completed capture', async () => {
  const c = (await pay(await buyer())).json(); const report = (await close()).json();
  now = new Date(c.reservedUntil); await restart();
  await observe(report, 'removed', item.id, 'Sold for cash');
  await webhook(c.paypalOrderId);
  await observe(report, 'present');
  const edited = await observe(report, 'removed', item.id, 'Given away');
  expect(edited.json().closing.items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ observation: 'removed', reason: 'Given away' });
  expect((await app.inject({ method: 'GET', url: '/api/owner/items', cookies: owner })).json().items.find((i: { id: string }) => i.id === item.id)).toMatchObject({ status: 'removed', removedReason: 'Given away' });
});
it('does not deadlock Add item against a session holder writing rows that reference the stall', async () => {
  const { id: session, stall_id: stall } = (await db.query('select id,stall_id from trading_sessions')).rows[0];
  const tx = await db.connect();
  try {
    await tx.query('begin');
    await tx.query('select id from trading_sessions where id=$1 for update', [session]);
    const adding = add('Mirror');
    await vi.waitFor(async () => {
      const waits = await db.query("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%trading_sessions%'");
      expect(waits.rowCount).toBeGreaterThan(0);
    });
    await tx.query("insert into events (stall_id,trading_session_id,type,payload,business_key) values ($1,$2,'sale','{}','lock-order')", [stall, session]);
    await tx.query('commit');
    expect((await adding).name).toBe('Mirror');
  } finally { await tx.query('rollback'); tx.release(); }
});
it('keeps a sold item gone with its buyer even if the owner flags it as present', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  expect((await capture(c.checkoutId, cookies)).json().state).toBe('paid');
  const report = (await close()).json();
  const flagged = (await observe(report, 'present')).json().closing;
  expect(flagged.groups.find((g: { key: string }) => g.key === 'paidAbsent').items).toHaveLength(1);
  expect(flagged.groups.find((g: { key: string }) => g.key === 'unsoldPresent').items).toEqual([]);
});
