import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', webhookId: 'hook', publicBaseUrl: 'https://stall.example', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false };
const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'signature', 'paypal-transmission-time': '2026-11-05T12:00:00Z' };
let app: ReturnType<typeof buildApp>;
let now: Date;
let owner: Record<string, string>;
let buyer: Record<string, string>;
let checkoutId: string;
let code: string;
let valid: boolean;
let captureCalls: number;
let fetcher: typeof fetch;
const capture = { id: 'CAPTURE', status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' } };
const event = (id = 'EVENT', resource = { ...capture, supplementary_data: { related_ids: { order_id: 'ORDER' } } }, type = 'PAYMENT.CAPTURE.COMPLETED') => ({ id, event_type: type, resource });
const deliver = (payload: unknown) => app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload });
const feed = async () => (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
beforeEach(async () => {
  await db.query('truncate webhook_inbox,items,buyer_sessions,trading_sessions cascade');
  now = new Date(Date.now() + 1000); valid = true; captureCalls = 0;
  fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (String(url).endsWith('/verify-webhook-signature')) return Response.json({ verification_status: valid ? 'SUCCESS' : 'FAILURE' });
    if (String(url).endsWith('/capture')) { captureCalls++; return Response.json({ id: 'ORDER', purchase_units: [{ custom_id: checkoutId, payments: { captures: [capture] } }] }); }
    return Response.json({ id: 'ORDER' });
  });
  app = buildApp(config, { db, fetcher, now: () => now });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  code = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Lamp', notes: 'Tested', mode: 'fixed', askingPence: 2800 } })).json().code;
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  buyer = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
  checkoutId = (await app.inject({ method: 'POST', url: `/api/i/${code}/checkout`, cookies: buyer, payload: {} })).json().checkoutId;
});
afterEach(async () => { vi.useRealTimers(); await app.close(); });
async function pay() { return app.inject({ method: 'POST', url: `/api/checkouts/${checkoutId}/capture`, cookies: buyer }); }
it('adds verification to the same sale after an API capture and duplicate webhooks', async () => {
  expect((await pay()).json().state).toBe('paid');
  const before = await feed();
  expect(before).toMatchObject({ recordedSalesPence: 2800, itemsSold: 1, unsoldRecords: 0 });
  expect(before.sales[0]).toMatchObject({ name: 'Lamp', code, amountPence: 2800, webhookVerifiedAt: null });
  expect((await deliver(event())).statusCode).toBe(200);
  await Promise.all([deliver(event()), deliver(event('SECOND'))]);
  const after = await feed();
  expect(after.sales).toHaveLength(1); expect(after.sales[0].id).toBe(before.sales[0].id);
  expect(after.sales[0].webhookVerifiedAt).toBe(now.toISOString()); expect(after.recordedSalesPence).toBe(2800);
  expect((await db.query('select * from captures')).rowCount).toBe(1);
  expect((await db.query("select * from events where type='sale'")).rowCount).toBe(1);
});
it('records webhook-first evidence once and does not capture on approval', async () => {
  await deliver({ id: 'APPROVAL', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER', purchase_units: [{ custom_id: checkoutId }] } });
  expect(captureCalls).toBe(0);
  expect((await db.query('select approved_at from checkouts')).rows[0].approved_at).toEqual(now);
  expect((await feed()).recordedSalesPence).toBe(0);
  await db.query("update checkouts set state='checking' where id=$1", [checkoutId]);
  await deliver(event()); await deliver(event());
  expect((await pay()).json().state).toBe('paid'); expect(captureCalls).toBe(0);
  expect((await feed()).recordedSalesPence).toBe(2800);
});
it('refuses bad signatures before durable receipt or sale', async () => {
  valid = false;
  expect((await deliver(event())).statusCode).toBe(400);
  expect((await db.query('select * from webhook_inbox')).rowCount).toBe(0);
  expect((await feed()).recordedSalesPence).toBe(0);
});
it('returns 5xx when the durable inbox insert fails', async () => {
  await db.query("create function reject_inbox() returns trigger language plpgsql as $$ begin raise exception 'disk unavailable'; end $$");
  await db.query('create trigger reject_inbox before insert on webhook_inbox for each row execute function reject_inbox()');
  try { expect((await deliver(event())).statusCode).toBe(500); }
  finally { await db.query('drop trigger reject_inbox on webhook_inbox'); await db.query('drop function reject_inbox()'); }
  expect((await feed()).recordedSalesPence).toBe(0);
});
it('retries unmatched events at startup once the checkout order appears', async () => {
  await db.query("update checkouts set paypal_order_id=null,state='checking' where id=$1", [checkoutId]);
  await deliver({ id: 'UNMATCHED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, custom_id: checkoutId, supplementary_data: { related_ids: { order_id: 'ORDER' } } } });
  expect((await db.query('select state,attempts,last_error from webhook_inbox')).rows[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Unmatched PayPal event' });
  await app.close();
  await db.query("update checkouts set paypal_order_id='ORDER' where id=$1", [checkoutId]);
  now = new Date(now.getTime() + 30_000);
  app = buildApp(config, { db, fetcher, now: () => now });
  await app.ready();
  expect((await feed()).recordedSalesPence).toBe(2800);
  expect((await db.query('select state,attempts from webhook_inbox')).rows[0]).toMatchObject({ state: 'processed', attempts: 2 });
});
it('retries on the 30-second timer with backoff and custom ID correlation', async () => {
  await app.close(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  app = buildApp(config, { db, fetcher, now: () => now }); await app.ready();
  await db.query('update checkouts set paypal_order_id=null where id=$1', [checkoutId]);
  await deliver({ id: 'RETRY', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, custom_id: checkoutId } });
  now = new Date(now.getTime() + 30_000); await vi.advanceTimersByTimeAsync(30_000); await new Promise(resolve => setTimeout(resolve, 30));
  await vi.waitFor(async () => expect((await db.query('select attempts from webhook_inbox')).rows[0].attempts).toBe(2));
  await db.query("update checkouts set paypal_order_id='ORDER',state='checking' where id=$1", [checkoutId]);
  now = new Date(now.getTime() + 30_000); await vi.advanceTimersByTimeAsync(30_000); await new Promise(resolve => setTimeout(resolve, 30));
  expect((await db.query('select attempts from webhook_inbox')).rows[0].attempts).toBe(2);
  // The timer skips a fire while the previous repair is still finishing, so keep firing it.
  await vi.waitFor(async () => {
    now = new Date(now.getTime() + 30_000); await vi.advanceTimersByTimeAsync(30_000);
    expect((await feed()).recordedSalesPence).toBe(2800);
  });
});
it('deduplicates refunds, reduces totals, withdraws collection and retains sold stock', async () => {
  await pay();
  const refund = { id: 'REFUND_EVENT', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND', status: 'COMPLETED', amount: { value: '10.00', currency_code: 'GBP' }, supplementary_data: { related_ids: { order_id: 'ORDER', capture_id: 'CAPTURE' } } } };
  await deliver(refund); await deliver(refund); await deliver({ ...refund, id: 'REFUND_EVENT_2' });
  expect((await feed())).toMatchObject({ recordedSalesPence: 1800, itemsSold: 1, unsoldRecords: 0 });
  expect((await feed()).sales[0].refundedPence).toBe(1000);
  const page = (await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json();
  expect(page.availability).toBe('sold'); expect(page.checkout).toMatchObject({ state: 'paid', reviewRequired: true });
  await deliver(event());
  expect((await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json().reviewRequired).toBe(true);
  expect((await db.query('select * from refunds')).rowCount).toBe(1);
});
it('scopes snapshots to the authenticated stall', async () => {
  await pay();
  expect((await app.inject('/api/owner/feed')).statusCode).toBe(401);
  expect((await app.inject('/api/owner/feed/stream')).statusCode).toBe(401);
  const demo = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
  expect((await app.inject({ url: '/api/owner/feed', cookies: demo })).json()).toMatchObject({ sales: [], recordedSalesPence: 0 });
});
it('streams committed sales and later verification to an owner on another connection', async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/owner/feed/stream`, { headers: { cookie: `stallkeeper_owner=${encodeURIComponent(owner.stallkeeper_owner!)}` }, signal: controller.signal });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: update');
    await pay();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: update');
    expect((await feed()).sales[0].webhookVerifiedAt).toBeNull();
    await deliver(event());
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: update');
    expect((await feed()).sales[0].webhookVerifiedAt).toBe(now.toISOString());
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
});
it('counts unsold records on the database clock when the API clock runs behind', async () => {
  now = new Date(now.getTime() - 3_600_000);
  expect((await feed()).unsoldRecords).toBe(1);
  await pay();
  expect((await feed()).unsoldRecords).toBe(0);
});
it('logs the cause when the repair sweep fails', async () => {
  const broken = buildApp(config, { db: { query: async (sql: string) => { if (sql.startsWith('update checkouts')) return { rows: [] }; throw new Error('database unavailable'); } } as unknown as typeof db, fetcher, now: () => now });
  const log = vi.spyOn(broken.log, 'error');
  await broken.ready();
  expect(log).toHaveBeenCalledWith({ error: 'database unavailable' }, 'Webhook repair failed');
  await broken.close();
});
it('sends named heartbeats that page code can observe', async () => {
  await app.close(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  app = buildApp(config, { db, fetcher, now: () => now });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/owner/feed/stream`, { headers: { cookie: `stallkeeper_owner=${encodeURIComponent(owner.stallkeeper_owner!)}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  try {
    await reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: heartbeat\ndata: {}\n\n');
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
});
it('streams an update when stock or the trading session changes', async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/owner/feed/stream`, { headers: { cookie: `stallkeeper_owner=${encodeURIComponent(owner.stallkeeper_owner!)}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  const nextUpdate = async () => expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: update');
  try {
    await nextUpdate();
    const added = await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Chair', notes: 'Sturdy', mode: 'fixed', askingPence: 1500 } });
    await nextUpdate();
    expect((await feed()).unsoldRecords).toBe(2);
    await app.inject({ method: 'POST', url: `/api/owner/items/${added.json().id}/remove`, cookies: owner, payload: { reason: 'Broken' } });
    await nextUpdate();
    expect((await feed()).unsoldRecords).toBe(1);
    await db.query("update trading_sessions set status='closed',closed_at=$1", [now]);
    await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
    await nextUpdate();
    expect((await feed()).session.status).toBe('open');
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
});
it('leaves a declined checkout finished when a late pending event arrives', async () => {
  await db.query("update checkouts set state='checking' where id=$1", [checkoutId]);
  const related = { supplementary_data: { related_ids: { order_id: 'ORDER' } } };
  await deliver(event('DECLINED', { ...capture, ...related, status: 'DECLINED' }, 'PAYMENT.CAPTURE.DECLINED'));
  await deliver(event('LATE_PENDING', { ...capture, ...related, status: 'PENDING' }, 'PAYMENT.CAPTURE.PENDING'));
  expect((await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json().state).toBe('failed');
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('available');
  expect((await db.query("select state from webhook_inbox where event_id='LATE_PENDING'")).rows[0].state).toBe('processed');
});
it('flags late evidence for review without reopening a finished checkout', async () => {
  await db.query("update checkouts set state='checking',paypal_order_id='OLD' where id=$1", [checkoutId]);
  const related = { supplementary_data: { related_ids: { order_id: 'OLD' } } };
  await deliver(event('DECLINED', { ...capture, ...related, status: 'DECLINED' }, 'PAYMENT.CAPTURE.DECLINED'));
  const next = (await app.inject({ method: 'POST', url: `/api/i/${code}/checkout`, cookies: buyer, payload: {} })).json();
  expect(next.checkoutId).not.toBe(checkoutId);
  await deliver(event('LATE_COMPLETED', { ...capture, ...related }));
  expect((await db.query("select state from webhook_inbox where event_id='LATE_COMPLETED'")).rows[0].state).toBe('processed');
  expect((await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json()).toMatchObject({ state: 'failed', reviewRequired: true });
  expect((await app.inject({ url: `/api/checkouts/${next.checkoutId}`, cookies: buyer })).json().state).toBe('awaiting_approval');
});
it('correlates a refund through its capture link when order identifiers are absent', async () => {
  await pay();
  await deliver({ id: 'LINK_REFUND', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'LINK_REFUND_ID', status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' }, links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE' }] } });
  expect((await feed())).toMatchObject({ recordedSalesPence: 0, itemsSold: 0 });
  expect((await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json().reviewRequired).toBe(true);
});
it('flags conflicting capture identity for review without a sale or a retry', async () => {
  await deliver({ id: 'WRONG_ORDER', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, custom_id: checkoutId, supplementary_data: { related_ids: { order_id: 'OTHER' } } } });
  expect((await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json()).toMatchObject({ state: 'checking', reviewRequired: true });
  expect((await feed())).toMatchObject({ recordedSalesPence: 0, itemsSold: 0 });
  expect((await db.query('select * from captures')).rowCount).toBe(0);
  expect((await db.query('select state,attempts,last_error from webhook_inbox')).rows[0]).toMatchObject({ state: 'processed', attempts: 1, last_error: null });
});
it('keeps out-of-order refund evidence pending without changing totals', async () => {
  await deliver({ id: 'EARLY_REFUND', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'EARLY', status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' }, supplementary_data: { related_ids: { order_id: 'ORDER', capture_id: 'CAPTURE' } } } });
  expect((await db.query("select state from webhook_inbox where event_id='EARLY_REFUND'")).rows[0].state).toBe('pending');
  await pay(); await app.close(); now = new Date(now.getTime() + 30_000);
  app = buildApp(config, { db, fetcher, now: () => now }); await app.ready();
  expect((await feed())).toMatchObject({ recordedSalesPence: 0, itemsSold: 0 });
});
