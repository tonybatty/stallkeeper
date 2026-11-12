import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { applyPaymentEvidence } from './checkouts.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false };
let app: ReturnType<typeof buildApp>;
let now: Date;
let owner: Record<string, string>;
let item: { id: string; code: string };
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let evidence: Record<string, unknown>;
let createCount: number;
let captureCount: number;
let createBody: { purchase_units: Array<{ custom_id: string }> };
let createError = false;
let orderRead: Response | (() => Response) = () => Response.json({});
let readCount: number;
const buyer = async () => ({ stallkeeper_buyer: (await app.inject(`/api/i/${item.code}`)).cookies[0]!.value });
const pay = (cookies: Record<string, string>) => app.inject({ method: 'POST', url: `/api/i/${item.code}/checkout`, cookies, payload: {} });
const action = (id: string, cookies: Record<string, string>, name = 'capture') => app.inject({ method: 'POST', url: `/api/checkouts/${id}/${name}`, cookies, payload: {} });
function completed(id: string, amount = '28.00', currency = 'GBP', status = 'COMPLETED') {
  return { id: 'ORDER1', status: 'APPROVED', purchase_units: [{ custom_id: id, payments: { captures: [{ id: 'CAPTURE1', status, amount: { value: amount, currency_code: currency } }] } }] };
}
beforeEach(async () => {
  await db.query('truncate items, buyer_sessions, trading_sessions cascade');
  now = new Date('2026-11-05T12:00:00Z'); createCount = 0; captureCount = 0; readCount = 0; createError = false;
  orderRead = () => Response.json({});
  evidence = {};
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (String(url).endsWith('/capture')) { captureCount++; return Response.json(evidence); }
    if (init?.method === 'GET') { readCount++; return typeof orderRead === 'function' ? orderRead() : orderRead; }
    createCount++;
    createBody = JSON.parse(String(init?.body));
    if (createError) throw new DOMException('Timeout', 'TimeoutError');
    return Response.json({ id: `ORDER${createCount}` });
  });
  app = buildApp(config, { db, fetcher, now: () => now });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  item = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Lamp', notes: 'Tested', mode: 'haggle', askingPence: 2800, floorPence: 1800 } })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
});
afterEach(async () => { await app.close(); });
it('admits exactly one of two buyers racing for an item, after committing the reservation', async () => {
  const a = await buyer(); const b = await buyer();
  const results = await Promise.all([pay(a), pay(b)]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
  expect(createCount).toBe(1);
  expect((await db.query('select reserved_checkout_id from items where id=$1', [item.id])).rows[0].reserved_checkout_id).toBe(createBody.purchase_units[0]!.custom_id);
  const loser = results[0]!.statusCode === 409 ? a : b;
  const page = (await app.inject({ url: `/api/i/${item.code}`, cookies: loser })).json();
  expect(page.availability).toBe('reserved'); expect(page.checkout).toBeNull();
  // The other buyer's reservation has a known end, so the page can say when the item frees up.
  const deadline = (await db.query<{ reservation_deadline: Date }>('select reservation_deadline from checkouts')).rows[0]!.reservation_deadline;
  expect(page.reservedUntil).toBe(deadline.toISOString());
  const winner = loser === a ? b : a;
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies: winner })).json().reservedUntil).toBe(deadline.toISOString());
});
it('promises no free-again time while a capture is being checked or the checkout is held for review', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); const other = await buyer();
  const freeAgain = async () => (await app.inject({ url: `/api/i/${item.code}`, cookies: other })).json();
  await db.query("update checkouts set state='checking' where id=$1", [c.checkoutId]);
  now = new Date(new Date(c.reservedUntil).getTime() + 60_000);
  expect(await freeAgain()).toMatchObject({ availability: 'reserved', reservedUntil: null });
  await db.query("update checkouts set state='awaiting_approval', review_required=true where id=$1", [c.checkoutId]);
  expect(await freeAgain()).toMatchObject({ availability: 'reserved', reservedUntil: null });
});
it('coalesces repeat presses into one checkout and one PayPal create', async () => {
  const cookies = await buyer();
  const responses = await Promise.all([pay(cookies), pay(cookies), pay(cookies)]);
  const ids = responses.map(r => r.json().checkoutId);
  expect(new Set(ids).size).toBe(1); expect(createCount).toBe(1);
  expect((await db.query('select * from checkouts')).rowCount).toBe(1);
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies })).json().checkout.checkoutId).toBe(ids[0]);
});
it('retries unknown creation with the stored request key and unchanged deadline', async () => {
  const cookies = await buyer(); createError = true;
  const first = (await pay(cookies)).json(); expect(first.state).toBe('creating');
  createError = false;
  const second = (await pay(cookies)).json(); expect(second.state).toBe('awaiting_approval');
  expect(second.checkoutId).toBe(first.checkoutId); expect(second.reservedUntil).toBe(first.reservedUntil);
  const calls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/orders'));
  expect(new Headers(calls[0]![1]?.headers).get('PayPal-Request-Id')).toBe(new Headers(calls[1]![1]?.headers).get('PayPal-Request-Id'));
});
it('expires an approval racing the deadline without capture or revival', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  now = new Date(c.reservedUntil);
  const [capture, page] = await Promise.all([action(c.checkoutId, cookies), app.inject({ url: `/api/i/${item.code}`, cookies })]);
  expect(capture.statusCode).toBe(409); expect(capture.json().state).toBe('expired'); expect(captureCount).toBe(0);
  expect(page.json().availability).toBe('available');
  expect((await action(c.checkoutId, cookies)).statusCode).toBe(409); expect(captureCount).toBe(0);
});
it('captures once, records one sale from capture status, and reopens the paid checkout', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); evidence = completed(c.checkoutId);
  const results = await Promise.all([action(c.checkoutId, cookies), action(c.checkoutId, cookies)]);
  expect(results.some(r => r.json().state === 'paid')).toBe(true); expect(captureCount).toBe(1);
  await applyPaymentEvidence(db, c.checkoutId, evidence);
  expect((await db.query('select * from captures')).rowCount).toBe(1);
  expect((await db.query('select * from events')).rowCount).toBe(1);
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('sold');
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies })).json().checkout.state).toBe('paid');
});
it.each(['PENDING', 'DECLINED'])('does not treat an order-level COMPLETED as paid for %s capture', async status => {
  const cookies = await buyer(); const c = (await pay(cookies)).json(); evidence = { ...completed(c.checkoutId, '28.00', 'GBP', status), status: 'COMPLETED' };
  expect((await action(c.checkoutId, cookies)).json().state).toBe(status === 'DECLINED' ? 'failed' : 'checking');
  expect((await db.query('select * from events')).rowCount).toBe(0);
  if (status === 'DECLINED') expect((await pay(cookies)).json().checkoutId).not.toBe(c.checkoutId);
});
it.each(['amount', 'currency', 'order', 'custom'])('blocks mismatched %s evidence from collection', async kind => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  const value = completed(kind === 'custom' ? 'wrong' : c.checkoutId, kind === 'amount' ? '27.00' : '28.00', kind === 'currency' ? 'USD' : 'GBP');
  if (kind === 'order') value.id = 'OTHER'; evidence = value;
  const result = (await action(c.checkoutId, cookies)).json(); expect(result.reviewRequired).toBe(true); expect(result.state).toBe('checking');
  expect((await db.query('select * from events')).rowCount).toBe(0);
  expect((await db.query('select * from captures')).rowCount).toBe(0);
  now = new Date('2026-11-06T12:00:00Z');
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies })).json().availability).toBe('reserved');
});
it('releases on cancel, refuses removal while reserved, and scopes checkout access to its buyer', async () => {
  const cookies = await buyer(); const other = await buyer(); const c = (await pay(cookies)).json();
  expect((await action(c.checkoutId, other)).statusCode).toBe(404);
  expect((await action(c.checkoutId, other, 'cancel')).statusCode).toBe(404);
  expect((await app.inject({ url: `/api/checkouts/${c.checkoutId}`, cookies: other })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: `/api/owner/items/${item.id}/remove`, cookies: owner, payload: { reason: 'Changed mind' } })).statusCode).toBe(409);
  expect((await action(c.checkoutId, cookies, 'cancel')).json().state).toBe('cancelled');
  expect((await action(c.checkoutId, cookies)).json().state).toBe('cancelled'); expect(captureCount).toBe(0);
  expect((await pay(cookies)).json().checkoutId).not.toBe(c.checkoutId);
});
it('keeps capturing and unknown capture reservations past the deadline and through cancel', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  let resolve!: (response: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const pending = action(c.checkoutId, cookies);
  await vi.waitFor(() => expect(resolve).toBeDefined());
  now = new Date('2026-11-06T12:00:00Z');
  expect((await action(c.checkoutId, cookies, 'cancel')).json().state).toBe('capturing');
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies })).json().availability).toBe('reserved');
  resolve(new Response(null, { status: 503 }));
  expect((await pending).json().state).toBe('checking');
  expect((await action(c.checkoutId, cookies, 'cancel')).json().state).toBe('checking');
});
it('releases an instrument decline for another payment attempt', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  fetcher.mockResolvedValueOnce(Response.json({ details: [{ issue: 'INSTRUMENT_DECLINED' }] }, { status: 422 }));
  expect((await action(c.checkoutId, cookies)).json().state).toBe('failed');
  expect((await pay(cookies)).json().checkoutId).not.toBe(c.checkoutId);
});
it('releases an unapproved capture, which PayPal proves took no money', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  fetcher.mockResolvedValueOnce(Response.json({ details: [{ issue: 'ORDER_NOT_APPROVED' }] }, { status: 422 }));
  expect((await action(c.checkoutId, cookies)).json().state).toBe('failed');
  expect((await db.query('select reserved_checkout_id from items where id=$1', [item.id])).rows[0].reserved_checkout_id).toBeNull();
  expect((await pay(cookies)).json().checkoutId).not.toBe(c.checkoutId);
});
it('applies a capture without deadlocking against a buyer who holds the session and wants the item', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  await db.query("update checkouts set state='capturing' where id=$1", [c.checkoutId]);
  const rival = await db.connect();
  try {
    await rival.query('begin');
    await rival.query('select id from trading_sessions for update');
    const applying = applyPaymentEvidence(db, c.checkoutId, completed(c.checkoutId));
    await vi.waitFor(async () => expect((await db.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rowCount).toBe(1));
    await rival.query('select id from items where id=$1 for update', [item.id]);
    await rival.query('commit');
    expect((await applying).state).toBe('paid');
  } finally { rival.release(); }
  expect((await db.query("select * from events where type='sale'")).rowCount).toBe(1);
});
it.each([
  ['the public stall', async () => (await app.inject('/api/stall')).json().items[0].availability, 'available'],
  ['the owner list', async () => (await app.inject({ url: '/api/owner/items', cookies: owner })).json().items[0].status, 'available'],
  ['an owner edit', async () => (await app.inject({ method: 'PATCH', url: `/api/owner/items/${item.id}`, cookies: owner, payload: { notes: 'Dusted' } })).json().status, 'available'],
  ['owner removal', async () => (await app.inject({ method: 'POST', url: `/api/owner/items/${item.id}/remove`, cookies: owner, payload: { reason: 'Changed mind' } })).statusCode, 200],
])('releases a lapsed reservation when read through %s', async (_name, read, expected) => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  now = new Date(c.reservedUntil);
  expect(await read()).toBe(expected);
});
it('refuses buyer amounts and preserves the reserved total across owner price edits', async () => {
  const cookies = await buyer();
  expect((await app.inject({ method: 'POST', url: `/api/i/${item.code}/checkout`, cookies, payload: { amount: 1 } })).statusCode).toBe(400);
  const c = (await pay(cookies)).json();
  await app.inject({ method: 'PATCH', url: `/api/owner/items/${item.id}`, cookies: owner, payload: { askingPence: 3000 } });
  expect((await pay(cookies)).json().totalPence).toBe(2800);
  evidence = completed(c.checkoutId); expect((await action(c.checkoutId, cookies)).json().state).toBe('paid');
});
it('limits a buyer to one reservation even across different items', async () => {
  const other = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Mirror', notes: 'Used', mode: 'fixed', askingPence: 1200 } })).json();
  const cookies = await buyer();
  const results = await Promise.all([pay(cookies), app.inject({ method: 'POST', url: `/api/i/${other.code}/checkout`, cookies, payload: {} })]);
  expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]); expect(createCount).toBe(1);
  expect(results.find(r => r.statusCode === 409)!.json().error).toBe('You already have another item reserved. Finish paying for it, or wait for that reservation to end, then try again.');
});
it('refuses admission when closing but allows an existing reservation to finish', async () => {
  const cookies = await buyer(); const other = await buyer(); const c = (await pay(cookies)).json();
  await db.query("update trading_sessions set status='closing'");
  expect((await pay(other)).statusCode).toBe(409);
  evidence = completed(c.checkoutId); expect((await action(c.checkoutId, cookies)).json().state).toBe('paid');
});
it('does not revive a reservation when PayPal create finishes after expiry', async () => {
  const cookies = await buyer();
  let finish!: () => void;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/orders')) {
      expect((await db.query('select * from checkouts')).rows[0].state).toBe('creating');
      await new Promise<void>(resolve => { finish = resolve; });
    }
    return original(url, init);
  });
  const creating = pay(cookies);
  await vi.waitFor(() => expect(finish).toBeDefined());
  now = new Date('2026-11-05T12:05:00Z'); finish();
  const c = (await creating).json(); expect(c.state).toBe('expired');
  expect((await action(c.checkoutId, cookies)).statusCode).toBe(409); expect(captureCount).toBe(0);
});

const approvedOrder = (id: string, status = 'APPROVED') => ({ id: 'ORDER1', status, purchase_units: [{ custom_id: id }] });
it('captures an approved order when the SDK reports a cancel', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  orderRead = () => Response.json(approvedOrder(c.checkoutId)); evidence = completed(c.checkoutId);
  const result = (await action(c.checkoutId, cookies, 'sdk-cancel')).json();
  expect(result.state).toBe('paid'); expect(readCount).toBe(1); expect(captureCount).toBe(1);
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('sold');
});
it.each(['PAYER_ACTION_REQUIRED', 'COMPLETED'])('releases a %s order when the SDK reports a cancel, without capturing', async status => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  orderRead = () => Response.json(approvedOrder(c.checkoutId, status));
  expect((await action(c.checkoutId, cookies, 'sdk-cancel')).json().state).toBe('cancelled');
  expect(readCount).toBe(1); expect(captureCount).toBe(0);
  expect((await db.query('select reserved_checkout_id from items where id=$1', [item.id])).rows[0].reserved_checkout_id).toBeNull();
});
it('releases the checkout when the PayPal read fails on an SDK cancel', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  orderRead = () => new Response(null, { status: 503 });
  expect((await action(c.checkoutId, cookies, 'sdk-cancel')).json().state).toBe('cancelled');
  expect(readCount).toBe(1); expect(captureCount).toBe(0);
  expect((await db.query('select reserved_checkout_id from items where id=$1', [item.id])).rows[0].reserved_checkout_id).toBeNull();
});
it('does not capture an approved order whose identity differs, on an SDK cancel', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  orderRead = () => Response.json(approvedOrder('someone-elses-checkout'));
  expect((await action(c.checkoutId, cookies, 'sdk-cancel')).json().state).toBe('cancelled'); expect(captureCount).toBe(0);
});
it('never reads or captures the order when the Cancel checkout button is used', async () => {
  const cookies = await buyer(); const c = (await pay(cookies)).json();
  orderRead = () => Response.json(approvedOrder(c.checkoutId)); evidence = completed(c.checkoutId);
  expect((await action(c.checkoutId, cookies, 'cancel')).json().state).toBe('cancelled');
  expect(readCount).toBe(0); expect(captureCount).toBe(0);
});
it('scopes the SDK cancel to its buyer and leaves a paid checkout alone', async () => {
  const cookies = await buyer(); const other = await buyer(); const c = (await pay(cookies)).json();
  expect((await action(c.checkoutId, other, 'sdk-cancel')).statusCode).toBe(404); expect(readCount).toBe(0);
  evidence = completed(c.checkoutId); expect((await action(c.checkoutId, cookies)).json().state).toBe('paid');
  expect((await action(c.checkoutId, cookies, 'sdk-cancel')).json().state).toBe('paid'); expect(readCount).toBe(0);
});
it('keeps the configured sandbox login out of the checkout create and read responses', async () => {
  await app.close();
  app = buildApp({ ...config, demoBuyerEmail: 'judge@example.invalid', demoBuyerPassword: 'fixture-buyer' }, { db, fetcher, now: () => now });
  const cookies = await buyer();
  const keys = ['approvedAt', 'checkoutId', 'kind', 'paypalOrderId', 'reservedUntil', 'reviewRequired', 'state', 'tipRefunded', 'totalPence'];
  const created = await pay(cookies);
  const read = await app.inject({ url: `/api/checkouts/${created.json().checkoutId}`, cookies });
  const page = (await app.inject({ url: `/api/i/${item.code}`, cookies })).json();
  for (const body of [created.json(), read.json(), page.checkout]) expect(Object.keys(body).sort()).toEqual(keys);
  for (const response of [created, read]) {
    expect(response.body).not.toContain('judge@example.invalid');
    expect(response.body).not.toContain('fixture-buyer');
  }
});
