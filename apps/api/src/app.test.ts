import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp, publicOrigin } from './app.js';

const config = {
  clientId: 'test-id', clientSecret: 'test-secret', webhookId: 'HOOK123',
  ownerPassword: 'main-password', demoOwnerPassword: 'demo-password', sessionSecret: 'test-session-secret', production: false, publicBaseUrl: 'https://stall.example',
};
const db = testDatabase();
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('publicOrigin', () => {
  it.each([['https://stall.example', 'https://stall.example'], ['https://stall.example/', 'https://stall.example'], ['http://localhost:5173', 'http://localhost:5173']])('accepts %s', (input, expected) => expect(publicOrigin(input)).toBe(expected));
  it.each(['', 'stall.example', 'localhost:5173', 'mailto:owner@stall.example', 'ftp://stall.example'])('refuses %j', input => expect(() => publicOrigin(input)).toThrow('PUBLIC_BASE_URL'));
});
function setup(result: unknown = { id: 'ORDER123' }, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'private-token', expires_in: 3600 })).mockResolvedValueOnce(Response.json(result, { status }));
  const app = buildApp(config, { fetcher, db });
  apps.push(app);
  return { app, fetcher };
}
const event = { id: 'EVENT123', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAPTURE123' } };
const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 'transmission-id', 'paypal-transmission-sig': 'signature', 'paypal-transmission-time': '2026-11-04T12:00:00Z' };

it('reports the deployed commit on health and nothing else', async () => {
  const app = buildApp({ ...config, commit: '0123456789abcdef' }, { db });
  apps.push(app);
  expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok', commit: '0123456789abcdef' });
  const blank = buildApp({ ...config, commit: '' }, { db });
  apps.push(blank);
  expect((await blank.inject('/api/health')).json()).toEqual({ status: 'ok', commit: 'unknown' });
});
it.each(['webhook_inbox', 'stalls'])('serves health while startup repair waits for a lock on %s', async table => {
  const eventId = `STARTUP-${table}`;
  await db.query('insert into webhook_inbox(event_id,event_type,raw_body,next_attempt_at) values ($1,$2,$3,$4)', [
    eventId, 'IGNORED', JSON.stringify({ id: eventId, event_type: 'IGNORED', resource: {} }), new Date(0),
  ]);
  await db.query('update stalls set demo_reset_at=null where is_demo=true');
  const lock = await db.connect();
  await lock.query('begin');
  await lock.query(`lock table ${table} in access exclusive mode`);
  const app = buildApp(config, { db });
  apps.push(app);
  const listening = app.listen({ port: 0, host: '127.0.0.1' });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = await Promise.race([
      listening,
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Startup repair blocked readiness')), 2000); }),
    ]);
    const response = await fetch(`${address}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', commit: 'unknown' });
  } finally {
    clearTimeout(deadline);
    await lock.query('rollback');
    lock.release();
    await listening;
  }
  await vi.waitFor(async () => {
    expect((await db.query('select state,attempts from webhook_inbox where event_id=$1', [eventId])).rows[0]).toMatchObject({ state: 'processed', attempts: 1 });
    expect((await db.query('select demo_reset_at from stalls where is_demo=true')).rows[0].demo_reset_at).not.toBeNull();
  });
});
it('serves health and webhooks only under /api, where the hosted URLs stay fixed', async () => {
  const { app } = setup();
  expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok', commit: 'unknown' });
  expect((await app.inject('/health')).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/webhooks/paypal', headers, payload: event })).statusCode).toBe(404);
});
describe('web app', () => {
  function withBuild() {
    const webDist = mkdtempSync(join(tmpdir(), 'stallkeeper-web-'));
    writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="app"></div>');
    mkdirSync(join(webDist, 'assets'));
    writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1);');
    const app = buildApp({ ...config, webDist }, { db }); apps.push(app);
    return app;
  }
  it.each(['/', '/index.html', '/i/K7Q2', '/demo', '/owner/ledger', '/checkout/return'])('serves the web app at %s', async url => {
    const response = await withBuild().inject(url);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="app">');
    expect(response.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN' });
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['cross-origin-opener-policy']).toBeUndefined();
  });
  it('sends the same HTML headers on HEAD requests', async () => {
    const response = await withBuild().inject({ method: 'HEAD', url: '/demo' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN' });
  });
  it('serves built assets as files, not as the web app', async () => {
    const response = await withBuild().inject('/assets/app.js');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log(1);');
  });
  it.each(['/api', '/api/', '/api/nope', '/api/nope/deeper?x=1'])('returns a JSON 404 for unknown %s', async url => {
    const response = await withBuild().inject(url);
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Not found.' });
  });
  it('returns a JSON 404 for a missing build file rather than the web app', async () => {
    const response = await withBuild().inject('/assets/missing.js');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not found.' });
  });
  it('keeps API routes working beside the web app', async () => {
    expect((await withBuild().inject('/api/health')).json()).toEqual({ status: 'ok', commit: 'unknown' });
  });
  it('does not answer unknown non-GET requests with the web app', async () => {
    expect((await withBuild().inject({ method: 'POST', url: '/i/K7Q2', payload: {} })).statusCode).toBe(404);
  });
  it('returns a JSON 404 for every path when no build exists', async () => {
    const { app } = setup();
    for (const url of ['/', '/i/K7Q2']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Not found.' });
    }
  });
});
describe('webhook verification', () => {
  it('sends the original event and signature headers to PayPal before accepting', async () => {
    const { app, fetcher } = setup({ verification_status: 'SUCCESS' });
    const response = await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: config.webhookId, webhook_event: event });
  });
  it('passes the received event to PayPal byte for byte', async () => {
    const { app, fetcher } = setup({ verification_status: 'SUCCESS' });
    const raw = '{ "resource" : {"amount": 22.10, "id":"CAPTURE123", "note":"caf\\u00e9 £"},\n\t"event_type":"PAYMENT.CAPTURE.COMPLETED",   "id":"EVENT123" }';
    const response = await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, payload: raw });
    expect(response.statusCode).toBe(200);
    const fields = { auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: config.webhookId };
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(`${JSON.stringify(fields).slice(0, -1)},"webhook_event":${raw}}`);
  });
  it.each([{ verification_status: 'FAILURE' }, {}, { verification_status: 'success' }])('rejects an unverified response %j', async result => {
    const { app } = setup(result);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event })).statusCode).toBe(400);
  });
  it.each([{}, { id: 'EVENT123' }, { ...event, resource: null }, [], null])('rejects malformed events %j without calling PayPal', async payload => {
    const { app, fetcher } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload })).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects missing signature headers and invalid JSON', async () => {
    const { app, fetcher } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', payload: event })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"id":"EVENT123"},"x":{' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers })).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns an error on verification outage so PayPal can retry', async () => {
    const { app } = setup({}, 503);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event })).statusCode).toBe(502);
  });
  it('fails closed until the webhook ID is configured', async () => {
    const app = buildApp({ ...config, webhookId: undefined }, { db }); apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers, payload: event })).statusCode).toBe(503);
  });
});
describe('payment repair', () => {
  it('logs a failed tick with its class and a short message, and no long token', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const lines: string[] = [];
    try {
      const app = buildApp(config, { db, logger: { level: 'info', stream: { write: line => { lines.push(line); } } } });
      await app.ready();
      const query = db.query.bind(db);
      const spy = vi.spyOn(db, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => text === 'select id from stalls'
        ? Promise.reject(new TypeError(`Repair broke near ${'x'.repeat(30)}`))
        : (query as (...args: unknown[]) => unknown)(text, ...rest)) as typeof db.query);
      try {
        vi.advanceTimersByTime(30_000);
        await app.close();
      } finally { spy.mockRestore(); }
      const failed = lines.map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.msg === 'Payment repair failed');
      expect(failed).toMatchObject({ errorType: 'TypeError', message: 'Repair broke near [removed]' });
    } finally { vi.useRealTimers(); }
  });
});
