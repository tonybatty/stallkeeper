import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';

const config = {
  clientId: 'test-id', clientSecret: 'test-secret',
  ownerPassword: 'main-password', demoOwnerPassword: 'demo-password', sessionSecret: 'test-session-secret', production: false, publicBaseUrl: 'https://stall.example',
};
const db = testDatabase();
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function setup(overrides: Partial<typeof config> = {}) {
  const clock = { time: new Date('2026-11-07T09:00:00Z') };
  const app = buildApp({ ...config, ...overrides }, { db, now: () => clock.time });
  apps.push(app);
  return { app, clock };
}
type App = ReturnType<typeof setup>['app'];
const login = (app: App, password: string, extra: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  app.inject({ method: 'POST', url: '/api/owner/login', payload: { password }, ...extra });
async function cookieFor(app: App, password: string) {
  const cookie = (await login(app, password)).cookies[0];
  if (!cookie) throw new Error('No cookie set');
  return { stallkeeper_owner: cookie.value };
}
const stall = (app: App, cookies: Record<string, string> = {}, url = '/api/owner/stall') => app.inject({ url, cookies });
const stallId = async (isDemo: boolean) => (await db.query<{ id: string }>('select id from stalls where is_demo = $1', [isDemo])).rows[0]?.id;

describe('owner login', () => {
  it('opens each stall with its own password', async () => {
    const { app } = setup();
    const main = await login(app, 'main-password');
    expect(main.statusCode).toBe(200);
    expect(main.json()).toEqual({ name: 'Front-garden stall' });
    expect((await stall(app, await cookieFor(app, 'main-password'))).json()).toEqual({ name: 'Front-garden stall', closingTime: null, demo: false });
    expect((await login(app, 'demo-password')).json()).toEqual({ name: 'Market stall' });
    expect((await stall(app, await cookieFor(app, 'demo-password'))).json()).toEqual({ name: 'Market stall', closingTime: null, demo: true });
  });

  it('sets a signed, HTTP-only, SameSite=Lax cookie that is Secure only in production', async () => {
    const local = (await login(setup().app, 'main-password')).cookies[0];
    expect(local).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    expect(local?.secure).toBeUndefined();
    expect(local?.value).toContain(await stallId(false));
    const hosted = (await login(setup({ production: true }).app, 'main-password')).cookies[0];
    expect(hosted).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true });
  });

  it('refuses a wrong password without setting a cookie', async () => {
    const { app } = setup();
    const response = await login(app, 'wrong');
    expect(response.statusCode).toBe(401);
    expect(response.cookies).toEqual([]);
  });

  it('rejects a login with no password', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: '' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/owner/login', payload: {} })).statusCode).toBe(400);
  });

  it('logs out by clearing the cookie', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'POST', url: '/api/owner/logout', cookies: await cookieFor(app, 'main-password') });
    expect(response.statusCode).toBe(204);
    expect(response.cookies[0]).toMatchObject({ name: 'stallkeeper_owner', value: '', path: '/api/owner' });
  });
});

describe('login throttle', () => {
  const failTimes = async (app: App, times: number, remoteAddress: string) => {
    for (let attempt = 0; attempt < times; attempt += 1) expect((await login(app, 'wrong', { remoteAddress })).statusCode).toBe(401);
  };

  it('blocks an IP after five failures, even with the right password, until the window ends', async () => {
    const { app, clock } = setup();
    await failTimes(app, 5, '203.0.113.1');
    const blocked = await login(app, 'main-password', { remoteAddress: '203.0.113.1' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.cookies).toEqual([]);
    clock.time = new Date(clock.time.getTime() + 15 * 60 * 1000);
    expect((await login(app, 'main-password', { remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
  });

  it('lets the published demo password in from a locked address, without a cookie for the main stall', async () => {
    const { app } = setup();
    await failTimes(app, 5, '203.0.113.1');
    const demo = await login(app, 'demo-password', { remoteAddress: '203.0.113.1' });
    expect(demo.statusCode).toBe(200);
    expect(demo.json()).toEqual({ name: 'Market stall' });
    expect((await stall(app, { stallkeeper_owner: demo.cookies[0]!.value })).json()).toEqual({ name: 'Market stall', closingTime: null, demo: true });
  });

  it('keeps the demo bypass from clearing or extending the failure count', async () => {
    const { app } = setup();
    await failTimes(app, 5, '203.0.113.1');
    for (let tries = 0; tries < 3; tries += 1) expect((await login(app, 'demo-password', { remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
    const blocked = await login(app, 'main-password', { remoteAddress: '203.0.113.1' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
  });

  it('still answers a wrong password with 429 once the address is locked', async () => {
    const { app } = setup();
    await failTimes(app, 5, '203.0.113.1');
    expect((await login(app, 'wrong', { remoteAddress: '203.0.113.1' })).statusCode).toBe(429);
  });

  it('gives no bypass to a demo password that is also the main password', async () => {
    const { app } = setup({ demoOwnerPassword: 'main-password' });
    await failTimes(app, 5, '203.0.113.1');
    expect((await login(app, 'main-password', { remoteAddress: '203.0.113.1' })).statusCode).toBe(429);
  });

  it('counts each IP separately', async () => {
    const { app } = setup();
    await failTimes(app, 5, '203.0.113.1');
    expect((await login(app, 'main-password', { remoteAddress: '203.0.113.2' })).statusCode).toBe(200);
  });

  it.each(['demo-password', 'main-password'])('keeps counting failures across a successful login with %s', async password => {
    const { app } = setup();
    await failTimes(app, 4, '203.0.113.1');
    expect((await login(app, password, { remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
    await failTimes(app, 1, '203.0.113.1');
    expect((await login(app, 'main-password', { remoteAddress: '203.0.113.1' })).statusCode).toBe(429);
  });

  it('ignores addresses a client adds to X-Forwarded-For in production', async () => {
    const { app } = setup({ production: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(app, 'wrong', { headers: { 'x-forwarded-for': `198.51.100.${attempt}, 203.0.113.1` } });
    }
    expect((await login(app, 'main-password', { headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.1' } })).statusCode).toBe(429);
  });

  describe('behind Cloudflare in production', () => {
    // The edge address differs between requests from one client, as seen on the hosted service. The chain is
    // illustrative: it was not logged on Render.
    const attempt = (app: App, client: string, edge: number, forged = '198.51.100.7') =>
      login(app, 'wrong', { remoteAddress: '10.0.0.1', headers: { 'cf-connecting-ip': client, 'x-forwarded-for': `${forged}, ${client}, 104.16.0.${edge}` } });

    it('keys on the client address Cloudflare reports, whichever edge address carries the request', async () => {
      const { app } = setup({ production: true });
      for (let tries = 0; tries < 5; tries += 1) expect((await attempt(app, '203.0.113.1', tries)).statusCode).toBe(401);
      expect((await attempt(app, '203.0.113.1', 99)).statusCode).toBe(429);
    });

    it('does not let one client block another', async () => {
      const { app } = setup({ production: true });
      for (let tries = 0; tries < 5; tries += 1) await attempt(app, '203.0.113.1', 1);
      expect((await attempt(app, '203.0.113.2', 1)).statusCode).toBe(401);
    });

    it('lets a client pick no bucket with a forged X-Forwarded-For', async () => {
      const { app } = setup({ production: true });
      for (let tries = 0; tries < 5; tries += 1) await attempt(app, '203.0.113.1', 1, `198.51.100.${tries}`);
      expect((await attempt(app, '203.0.113.1', 1, '198.51.100.200')).statusCode).toBe(429);
    });

    it('keys an IPv6 client on its /64, however the address is written', async () => {
      const { app } = setup({ production: true });
      for (let tries = 0; tries < 5; tries += 1) expect((await attempt(app, `2001:db8:0:1::${tries + 1}`, tries)).statusCode).toBe(401);
      expect((await attempt(app, '2001:db8:0:1::ff', 9)).statusCode).toBe(429);
      expect((await attempt(app, '2001:0DB8:0:1:0:0:0:abcd', 9)).statusCode).toBe(429);
    });

    it.each([
      ['2001:db8:0:1::1', '2001:db8:0:2::1'],
      ['1::2:3:4:5:6', '1::3:3:4:5:6'],
    ])('gives IPv6 networks of %s and %s separate buckets', async (blocked, other) => {
      const { app } = setup({ production: true });
      for (let tries = 0; tries < 5; tries += 1) await attempt(app, blocked, tries);
      expect((await attempt(app, blocked, 9)).statusCode).toBe(429);
      expect((await attempt(app, other, 9)).statusCode).toBe(401);
    });

    it('falls back to the last forwarded address when the header is not an address', async () => {
      const { app } = setup({ production: true });
      const send = (password: string, header: string) => login(app, password, { headers: { 'cf-connecting-ip': header, 'x-forwarded-for': '104.16.0.1' } });
      for (let tries = 0; tries < 5; tries += 1) await send('wrong', `not-an-address-${tries}`);
      expect((await send('main-password', 'not-an-address-99')).statusCode).toBe(429);
    });

    it('falls back to the last forwarded address when the header is missing', async () => {
      const { app } = setup({ production: true });
      const send = (password: string, forged: string) => login(app, password, { headers: { 'x-forwarded-for': `${forged}, 104.16.0.1` } });
      for (let tries = 0; tries < 5; tries += 1) await send('wrong', `198.51.100.${tries}`);
      expect((await send('main-password', '198.51.100.99')).statusCode).toBe(429);
    });
  });

  it('ignores CF-Connecting-IP outside production', async () => {
    const { app } = setup();
    for (let tries = 0; tries < 5; tries += 1) {
      await login(app, 'wrong', { remoteAddress: '203.0.113.1', headers: { 'cf-connecting-ip': `198.51.100.${tries}` } });
    }
    expect((await login(app, 'main-password', { remoteAddress: '203.0.113.1', headers: { 'cf-connecting-ip': '198.51.100.99' } })).statusCode).toBe(429);
  });
});

describe('owner routes', () => {
  it('refuse a request with no cookie', async () => {
    expect((await stall(setup().app)).statusCode).toBe(401);
  });

  it('never let a demo login read the main stall', async () => {
    const { app } = setup();
    const demo = await cookieFor(app, 'demo-password');
    const mainId = await stallId(false);
    for (const url of [`/api/owner/stall?stall=${mainId}`, `/api/owner/stall?stallId=${mainId}`, `/api/owner/stall?id=${mainId}`]) {
      expect((await stall(app, demo, url)).json()).toEqual({ name: 'Market stall', closingTime: null, demo: true });
    }
  });

  it('refuse a demo cookie rewritten to name the main stall', async () => {
    const { app } = setup();
    const demoId = await stallId(true);
    const mainId = await stallId(false);
    if (!demoId || !mainId) throw new Error('Stalls are missing');
    const { stallkeeper_owner: value } = await cookieFor(app, 'demo-password');
    const forged = decodeURIComponent(value).replace(demoId, mainId);
    expect(forged).toContain(mainId);
    expect((await stall(app, { stallkeeper_owner: forged })).statusCode).toBe(401);
  });

  it('refuse a cookie signed with another secret', async () => {
    const other = setup({ sessionSecret: 'another-secret' });
    const cookies = await cookieFor(other.app, 'main-password');
    expect((await stall(setup().app, cookies)).statusCode).toBe(401);
  });

  it('refuse a cookie past its expiry even if the browser replays it', async () => {
    const { app, clock } = setup();
    const cookies = await cookieFor(app, 'main-password');
    clock.time = new Date(clock.time.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
    expect((await stall(app, cookies)).statusCode).toBe(200);
    clock.time = new Date(clock.time.getTime() + 1);
    expect((await stall(app, cookies)).statusCode).toBe(401);
  });
});
