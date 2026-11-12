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
let code: string;
let checkoutId: string;
let orderId: string;
let creates: number;
let readEvidence: Record<string, unknown>;
let captureResponse: () => Response | Promise<Response>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const capture = { id: 'CAPTURE', status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' } };
const evidence = (status = 'COMPLETED') => ({ id: orderId, status: 'COMPLETED', purchase_units: [{ custom_id: checkoutId, payments: { captures: [{ ...capture, status }] } }] });
const approved = () => ({ id: orderId, status: 'APPROVED', purchase_units: [{ custom_id: checkoutId }] });
const pay = () => app.inject({ method: 'POST', url: `/api/checkouts/${checkoutId}/capture`, cookies: buyer });
const read = async () => (await app.inject({ url: `/api/checkouts/${checkoutId}`, cookies: buyer })).json();
const feed = async () => (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
const recheck = (cookies = owner) => app.inject({ method: 'POST', url: `/api/owner/checkouts/${checkoutId}/recheck`, cookies });
const captureCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/capture'));
const readCalls = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'GET');
const captureKeys = () => captureCalls().map(([, init]) => new Headers(init?.headers).get('PayPal-Request-Id'));
function failReads() {
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => init?.method === 'GET' ? new Response(null, { status: 503 }) : original(url, init));
}
async function restart() {
  await app.close();
  app = buildApp(config, { db, fetcher, now: () => now });
  await app.ready();
}
async function tick(milliseconds = 30_000) {
  now = new Date(now.getTime() + milliseconds);
  await vi.advanceTimersByTimeAsync(30_000);
}
beforeEach(async () => {
  await db.query('truncate webhook_inbox,items,buyer_sessions,trading_sessions cascade');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  now = new Date('2026-11-05T12:00:00Z'); creates = 0;
  readEvidence = {};
  captureResponse = () => { throw new DOMException('Response lost', 'TimeoutError'); };
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (String(url).endsWith('/verify-webhook-signature')) return Response.json({ verification_status: 'SUCCESS' });
    if (String(url).endsWith('/capture')) return captureResponse();
    if (init?.method === 'GET') return Response.json(readEvidence);
    return Response.json({ id: `ORDER${++creates}` });
  });
  app = buildApp(config, { db, fetcher, now: () => now });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  code = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Lamp', notes: 'Tested', mode: 'fixed', askingPence: 2800 } })).json().code;
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  buyer = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
  const checkout = (await app.inject({ method: 'POST', url: `/api/i/${code}/checkout`, cookies: buyer, payload: {} })).json();
  checkoutId = checkout.checkoutId; orderId = checkout.paypalOrderId;
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });

it.each(['read', 'webhook'])('recovers a completed capture whose response was lost through %s, recording one sale', async source => {
  readEvidence = evidence();
  expect((await pay()).json().state).toBe('checking');
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('reserved');
  expect((await feed()).recordedSalesPence).toBe(0);
  if (source === 'read') {
    await tick();
    await vi.waitFor(async () => expect((await read()).state).toBe('paid'));
  }
  const event = { id: 'COMPLETE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, supplementary_data: { related_ids: { order_id: orderId } } } };
  await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event });
  await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event });
  expect((await read()).state).toBe('paid');
  expect((await feed())).toMatchObject({ recordedSalesPence: 2800, itemsSold: 1 });
  expect((await db.query('select * from captures')).rowCount).toBe(1);
  expect((await db.query("select * from events where type='sale'")).rowCount).toBe(1);
  expect(captureCalls()).toHaveLength(1); expect(creates).toBe(1);
});

it('recovers a capturing row at startup and never expires its reservation', async () => {
  await db.query("update checkouts set state='capturing',capture_started_at=$2 where id=$1", [checkoutId, now]);
  now = new Date(now.getTime() + 6 * 60_000);
  readEvidence = evidence('PENDING');
  await restart();
  expect((await read()).state).toBe('checking');
  await tick();
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('reserved');
  expect((await feed())).toMatchObject({ recordedSalesPence: 0, itemsSold: 0 });
  expect((await db.query('select * from captures')).rowCount).toBe(0);
  expect(captureCalls()).toHaveLength(0);
});

it('retries approved orders with the same capture key until 30 minutes, then supports an owner read', async () => {
  await pay(); readEvidence = approved();
  const key = new Headers(captureCalls()[0]![1]?.headers).get('PayPal-Request-Id');
  await tick();
  await vi.waitFor(() => expect(captureCalls()).toHaveLength(2));
  await vi.waitFor(async () => expect((await read()).state).toBe('checking'));
  expect(new Headers(captureCalls()[1]![1]?.headers).get('PayPal-Request-Id')).toBe(key);
  await tick(30 * 60_000);
  // The timer skips a fire while the previous repair is still finishing, so keep firing it.
  await vi.waitFor(async () => { await tick(); expect((await read()).reviewRequired).toBe(true); });
  expect(captureCalls()).toHaveLength(2);
  const flagged = (await feed()).flaggedPayments;
  expect(flagged).toHaveLength(1); expect(flagged[0].reason).toContain('30 minutes');
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('reserved');
  await recheck(); expect(captureCalls()).toHaveLength(2);
  readEvidence = evidence();
  expect((await recheck()).statusCode).toBe(200);
  expect((await read())).toMatchObject({ state: 'paid', reviewRequired: false });
  expect((await feed()).flaggedPayments).toEqual([]);
  expect(creates).toBe(1);
});

it('flags read failures after the recovery window and leaves the reservation intact', async () => {
  await pay();
  failReads();
  await tick(30 * 60_000);
  await vi.waitFor(async () => expect((await read()).reviewRequired).toBe(true));
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('reserved');
});

it.each(['creating', 'awaiting_approval'])('expires %s on the timer without a buyer request', async state => {
  await db.query('update checkouts set state=$2 where id=$1', [checkoutId, state]);
  await tick(5 * 60_000);
  await vi.waitFor(async () => expect((await db.query('select state from checkouts where id=$1', [checkoutId])).rows[0].state).toBe('expired'));
  expect((await db.query('select reserved_checkout_id from items where code=$1', [code])).rows[0].reserved_checkout_id).toBeNull();
  expect(captureCalls()).toHaveLength(0);
});

it('exposes recorded approval on return and finishes through the normal capture route', async () => {
  await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: { id: 'APPROVED', event_type: 'CHECKOUT.ORDER.APPROVED', resource: approved() } });
  const returned = (await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().checkout;
  expect(returned).toMatchObject({ state: 'awaiting_approval', approvedAt: now.toISOString() });
  expect(captureCalls()).toHaveLength(0);
  captureResponse = () => Response.json(evidence());
  expect((await pay()).json().state).toBe('paid');
});

it.each(['available', 'reserved', 'sold'])('keeps a late capture record without disturbing stock that is %s', async stock => {
  const late = evidence();
  await tick(5 * 60_000);
  await vi.waitFor(async () => expect((await read()).state).toBe('expired'));
  let newerId: string | undefined;
  if (stock !== 'available') {
    const newer = (await app.inject({ method: 'POST', url: `/api/i/${code}/checkout`, cookies: buyer, payload: {} })).json();
    newerId = newer.checkoutId;
    if (stock === 'sold') {
      captureResponse = () => Response.json({ ...late, id: newer.paypalOrderId, purchase_units: [{ custom_id: newerId, payments: { captures: [{ ...capture, id: 'OTHER_CAPTURE' }] } }] });
      await app.inject({ method: 'POST', url: `/api/checkouts/${newerId}/capture`, cookies: buyer });
    }
  }
  const response = await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: { id: 'LATE', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { ...capture, custom_id: checkoutId, supplementary_data: { related_ids: { order_id: orderId } } } } });
  expect(response.statusCode).toBe(200);
  expect((await read())).toMatchObject({ state: 'expired', reviewRequired: true });
  expect((await db.query('select * from captures where checkout_id=$1', [checkoutId])).rowCount).toBe(1);
  const item = (await db.query('select * from items where code=$1', [code])).rows[0];
  if (stock === 'reserved') expect(item.reserved_checkout_id).toBe(newerId);
  if (stock === 'sold') expect(item.sold_checkout_id).toBe(newerId);
  if (stock === 'available') expect(item.reserved_checkout_id).toBe(checkoutId);
  expect((await feed()).itemsSold).toBe(stock === 'sold' ? 1 : 0);
});

it('retries capture successfully after a lost request using its original key', async () => {
  await pay(); readEvidence = approved();
  captureResponse = () => Response.json(evidence());
  await tick();
  await vi.waitFor(async () => expect((await read()).state).toBe('paid'));
  const calls = captureCalls();
  expect(calls).toHaveLength(2);
  expect(new Headers(calls[1]![1]?.headers).get('PayPal-Request-Id')).toBe(new Headers(calls[0]![1]?.headers).get('PayPal-Request-Id'));
  expect((await feed())).toMatchObject({ itemsSold: 1, recordedSalesPence: 2800 });
});

it('keeps paid state and one sale after delayed pending and declined evidence', async () => {
  captureResponse = () => Response.json(evidence());
  await pay();
  for (const status of ['PENDING', 'DECLINED']) {
    await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: {
      id: status, event_type: `PAYMENT.CAPTURE.${status}`, resource: { ...capture, status, supplementary_data: { related_ids: { order_id: orderId } } },
    } });
    expect((await read()).state).toBe('paid');
  }
  expect((await feed())).toMatchObject({ itemsSold: 1, recordedSalesPence: 2800 });
});

it('scopes flagged payments and rechecks to the owner stall', async () => {
  await pay(); await tick(30 * 60_000);
  await vi.waitFor(async () => expect((await read()).reviewRequired).toBe(true));
  const demo = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
  expect((await recheck({})).statusCode).toBe(401);
  expect((await recheck(demo)).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/owner/feed', cookies: demo })).json().flaggedPayments).toEqual([]);
});

it.each([{}, { id: 'ORDER1', purchase_units: [] }])('repairs an unrecognised capture response', async response => {
  captureResponse = () => Response.json(response);
  expect((await pay()).json()).toMatchObject({ state: 'checking', reviewRequired: false });
  readEvidence = evidence();
  await tick();
  await vi.waitFor(async () => expect((await read()).state).toBe('paid'));
});

it('starts serving without waiting for PayPal to answer repair reads', async () => {
  await pay();
  const original = fetcher.getMockImplementation()!;
  let answer: ((response: Response) => void) | undefined;
  fetcher.mockImplementation((url, init) => init?.method === 'GET' ? new Promise<Response>(resolve => { answer = resolve; }) : original(url, init));
  await restart();
  expect((await app.inject('/api/health')).statusCode).toBe(200);
  await tick();
  await vi.waitFor(() => expect(answer).toBeDefined());
  answer!(Response.json(evidence()));
  await vi.waitFor(async () => expect((await read()).state).toBe('paid'));
});

it('retries with the original key when the database drops as PayPal answers a capture', async () => {
  const connect = vi.spyOn(db, 'connect');
  captureResponse = () => {
    connect.mockImplementation(() => Promise.reject(new Error('Database unavailable')));
    return Response.json(evidence());
  };
  expect((await pay()).statusCode).toBe(500);
  connect.mockRestore();
  expect((await read()).state).toBe('capturing');
  readEvidence = approved();
  await tick(3 * 60_000);
  await vi.waitFor(async () => expect((await read()).state).toBe('paid'));
  expect(new Set(captureKeys()).size).toBe(1); expect(captureKeys()).toHaveLength(2);
  expect((await feed())).toMatchObject({ itemsSold: 1, recordedSalesPence: 2800 });
  expect(creates).toBe(1);
});

it('leaves a capture in flight alone during the repair sweep', async () => {
  let answer: ((response: Response) => void) | undefined;
  captureResponse = () => new Promise<Response>(resolve => { answer = resolve; });
  const paying = pay();
  await vi.waitFor(() => expect(answer).toBeDefined());
  readEvidence = approved();
  await tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect((await read()).state).toBe('capturing');
  expect(readCalls()).toHaveLength(0);
  answer!(Response.json(evidence()));
  expect((await paying).json().state).toBe('paid');
  expect(captureCalls()).toHaveLength(1);
});

it('reports a failed owner read rather than a finished check', async () => {
  await pay(); await tick(30 * 60_000);
  await vi.waitFor(async () => expect((await read()).reviewRequired).toBe(true));
  failReads();
  expect((await recheck()).statusCode).toBe(502);
  expect((await feed()).flaggedPayments).toHaveLength(1);
});

const alreadyCaptured = () => Response.json({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, { status: 422 });

it('reads the order after ORDER_ALREADY_CAPTURED and records one sale', async () => {
  captureResponse = alreadyCaptured; readEvidence = evidence();
  expect((await pay()).json().state).toBe('paid');
  expect((await feed())).toMatchObject({ itemsSold: 1, recordedSalesPence: 2800 });
  expect((await db.query('select * from captures')).rowCount).toBe(1);
  expect(creates).toBe(1);
});

it('stays checking when the read after ORDER_ALREADY_CAPTURED fails', async () => {
  captureResponse = alreadyCaptured; failReads();
  expect((await pay()).json().state).toBe('checking');
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyer })).json().availability).toBe('reserved');
  expect((await feed())).toMatchObject({ itemsSold: 0, recordedSalesPence: 0 });
  expect(creates).toBe(1);
});

it('keeps a completed refund out of the review list and on its sale', async () => {
  captureResponse = () => Response.json(evidence());
  await pay();
  await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: {
    id: 'REFUND', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'REFUND', status: 'COMPLETED', amount: capture.amount, supplementary_data: { related_ids: { order_id: orderId, capture_id: capture.id } } },
  } });
  const snapshot = await feed();
  expect(snapshot.flaggedPayments).toEqual([]);
  expect(snapshot.sales).toMatchObject([{ checkoutId, refundedPence: 2800 }]);
});
