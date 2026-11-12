import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { demoIdleResetMs } from './demo.js';
import { summaryInput } from './closing-summary.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'https://stall.example' };
let app: ReturnType<typeof buildApp>;
let now: Date;
let demoId: string;
let cookies: Record<string, string>;
beforeEach(async () => {
  now = new Date('2026-11-05T02:59:00Z');
  await db.query('truncate items,buyer_sessions,trading_sessions cascade');
  await db.query('update stalls set demo_reset_at=null');
  demoId = (await db.query('select id from stalls where is_demo=true')).rows[0].id;
  app = buildApp(config, { db, now: () => now });
  await app.ready();
  cookies = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
});
afterEach(async () => { await app.close(); vi.useRealTimers(); });
const reset = (auth = cookies) => app.inject({ method: 'POST', url: '/api/owner/demo/reset', cookies: auth });
const page = async () => (await app.inject('/api/demo')).json();
const lastReset = async () => (await db.query('select demo_reset_at from stalls where is_demo=true')).rows[0].demo_reset_at;
const held = (closing: { groups: Array<{ key: string; label: string; items: Array<{ id: string }> }> }) =>
  closing.groups.filter(group => group.items.length).map(group => ({ key: group.key, label: group.label, items: group.items.map(item => item.id) }));
const stocked = async (mode: string) => (await db.query(`select i.* from items i join session_stock s on s.item_id=i.id join trading_sessions t on t.id=s.trading_session_id
  where t.stall_id=$1 and t.status='open' and i.mode=$2 order by i.id limit 1`, [demoId, mode])).rows[0];
async function checkout(state: string, flagged = false, item?: { id: string; code: string; name: string; asking_pence: number }) {
  item ??= (await db.query('select * from items where stall_id=$1 limit 1', [demoId])).rows[0];
  const session = (await db.query("select id from trading_sessions where stall_id=$1 and status='open'", [demoId])).rows[0];
  const buyer = (await db.query('insert into buyer_sessions(token_hash) values ($1) returning id', [randomUUID()])).rows[0];
  const id = (await db.query(`insert into checkouts(stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline,review_required)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [demoId, session.id, buyer.id, state, item.asking_pence, randomUUID(), randomUUID(), randomUUID(), new Date(now.getTime() + 300_000), flagged])).rows[0].id;
  await db.query('insert into checkout_lines(checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$5)', [id, item.id, item.code, item.name, item.asking_pence]);
  return { id, item, session };
}
it('seeds fourteen illustrated items, exposes only demo access and decodes every QR to its fresh tag URL', async () => {
  const response = await app.inject('/api/demo');
  const data = response.json();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(data).toMatchObject({ buyer: null, owner: { loginUrl: '/owner/login', password: 'demo' } });
  expect(data.items).toHaveLength(14);
  expect(new Set(data.items.map((item: { code: string }) => item.code)).size).toBe(14);
  expect(new Set(data.items.map((item: { mode: string }) => item.mode))).toEqual(new Set(['fixed', 'haggle', 'pwyw', 'free']));
  expect(data.items.filter((item: { mode: string }) => item.mode === 'free')).toEqual([expect.objectContaining({ name: 'Box of cookbooks', askingPence: null, seeded: true })]);
  expect(data.items.filter((item: { mode: string }) => item.mode === 'pwyw')).toEqual([expect.objectContaining({ name: 'Garden seed tins', askingPence: null })]);
  expect((await db.query("select minimum_pence from items where mode='pwyw' and minimum_pence is not null")).rowCount).toBe(0);
  for (const item of data.items) {
    expect(item).toMatchObject({ seeded: true, availability: 'available' });
    expect(item.illustration).toBeTruthy();
    expect(item).not.toHaveProperty('floorPence');
    const png = PNG.sync.read(Buffer.from(item.qrPng.split(',')[1], 'base64'));
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(`https://stall.example/i/${item.code}`);
    const buyer = (await app.inject(`/api/i/${item.code}`)).json();
    expect(buyer.item).toMatchObject({ seeded: true, illustration: item.illustration });
    expect(buyer.item).not.toHaveProperty('floorPence');
  }
  expect((await app.inject('/api/stall')).json().items).toEqual([]);
  const before = data.items.map((item: { code: string }) => item.code);
  await app.close(); app = buildApp(config, { db, now: () => now }); await app.ready();
  expect((await page()).items.map((item: { code: string }) => item.code)).toEqual(before);
});
it('lists items that take offers first in the seed order, and keeps that order across requests and resets', async () => {
  const names = async () => (await page()).items.map((item: { name: string; mode: string }) => [item.name, item.mode]);
  const first = await names();
  expect(first.slice(0, 6).every(([, mode]: string[]) => mode === 'haggle')).toBe(true);
  expect(first.slice(6).every(([, mode]: string[]) => mode !== 'haggle')).toBe(true);
  expect(first.slice(-2)).toEqual([['Garden seed tins', 'pwyw'], ['Box of cookbooks', 'free']]);
  expect(first[0]).toEqual(['Brass desk lamp', 'haggle']);
  expect(await names()).toEqual(first);
  expect((await reset()).statusCode).toBe(200);
  expect(await names()).toEqual(first);
});
it('returns configured judge-only buyer details without exposing server credentials', async () => {
  await app.close();
  app = buildApp({ ...config, demoBuyerEmail: 'judge@example.invalid', demoBuyerPassword: 'fixture-buyer', clientSecret: 'private-server-secret' }, { db, now: () => now });
  const response = await app.inject('/api/demo');
  expect(response.json().buyer).toEqual({ email: 'judge@example.invalid', password: 'fixture-buyer' });
  expect(response.body).not.toContain('private-server-secret');
  expect(response.body).not.toContain('ownerPassword');
});
it('keeps the buyer login out of the item payload', async () => {
  await app.close();
  app = buildApp({ ...config, demoBuyerEmail: 'judge@example.invalid', demoBuyerPassword: 'fixture-buyer' }, { db, now: () => now });
  const [code] = await codes();
  const response = await app.inject(`/api/i/${code}`);
  expect(Object.keys(response.json()).sort()).toEqual(['agreedPrice', 'availability', 'card', 'charity', 'chatAvailable', 'checkout', 'demoStall', 'item', 'messages', 'reducedFromPence', 'reservedUntil', 'retailReference', 'stallName', 'take'].sort());
  expect(response.body).not.toContain('judge@example.invalid');
  expect(response.body).not.toContain('fixture-buyer');
});
it('keeps the pay what you want and free tags opening although the front grid leaves them out', async () => {
  const data = await page();
  for (const mode of ['pwyw', 'free']) {
    const item = data.items.find((entry: { mode: string }) => entry.mode === mode);
    const response = await app.inject(`/api/i/${item.code}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().item).toMatchObject({ mode });
  }
});
it('offers the demo film link only when one is configured', async () => {
  expect((await page()).filmUrl).toBeNull();
  await app.close();
  app = buildApp({ ...config, demoFilmUrl: 'https://video.example/film' }, { db, now: () => now });
  expect((await app.inject('/api/demo')).json().filmUrl).toBe('https://video.example/film');
});
it.each(['creating', 'awaiting_approval', 'capturing', 'checking'])('refuses reset for an active %s checkout without changing stock or session', async state => {
  await checkout(state);
  const before = await page();
  expect((await reset()).statusCode).toBe(409);
  expect(await page()).toEqual(before);
  expect((await db.query('select * from trading_sessions where stall_id=$1', [demoId])).rowCount).toBe(1);
});
it.each([
  ['paid', "status='sold',sold_checkout_id=$1,sold_at=now()", false],
  ['checking', 'reserved_checkout_id=$1', true],
  ['expired', null, true],
  ['cancelled', null, true],
  ['failed', null, true],
])('resets past a flagged %s checkout from an earlier session, leaving it and its item for review', async (state, itemUpdate, stillStock) => {
  const { id, item } = await checkout(state, true);
  if (itemUpdate) await db.query(`update items set ${itemUpdate} where id=$2`, [id, item.id]);
  await db.query("update trading_sessions set status='closed' where stall_id=$1", [demoId]);
  await db.query('insert into trading_sessions(stall_id) values ($1)', [demoId]);
  const heldCheckout = async () => (await db.query('select * from checkouts where id=$1', [id])).rows[0];
  const heldItem = async () => (await db.query('select * from items where id=$1', [item.id])).rows[0];
  const checkoutBefore = await heldCheckout();
  const itemBefore = await heldItem();
  const codes: string[] = (await db.query('select code from items where stall_id=$1', [demoId])).rows.map(row => row.code);
  expect((await reset()).statusCode).toBe(200);
  expect(await heldCheckout()).toEqual(checkoutBefore);
  expect(await heldItem()).toEqual(itemBefore);
  const fresh: string[] = (await page()).items.map((stocked: { code: string }) => stocked.code);
  // A flagged item that sold before the reset is no longer stock, so the judge's list holds the fresh fourteen only. One still on the shelf stays in the new session's stock.
  expect(fresh.filter(code => codes.includes(code))).toEqual(stillStock ? [item.code] : []);
  expect(fresh).toHaveLength(stillStock ? 15 : 14);
  for (const code of codes.filter(code => code !== item.code)) expect((await app.inject(`/api/i/${code}`)).json().availability).toBe('removed');
  expect((await db.query("select * from trading_sessions where stall_id=$1 and status='open'", [demoId])).rowCount).toBe(1);
});
it('lists the latest session\'s stock and what sold in it, and leaves an old flagged sale to the owner', async () => {
  const owner = async () => (await app.inject({ method: 'GET', url: '/api/owner/items', cookies })).json().items as { code: string; status: string }[];
  const old = await checkout('paid', true);
  await db.query("update items set status='sold',sold_checkout_id=$1,sold_at=$2 where id=$3", [old.id, now, old.item.id]);
  await db.query("update trading_sessions set status='closed' where stall_id=$1", [demoId]);
  await db.query('insert into trading_sessions(stall_id) values ($1)', [demoId]);
  expect((await reset()).statusCode).toBe(200);
  const seeded = (await page()).items as { code: string; availability: string }[];
  expect(seeded).toHaveLength(14);
  expect(seeded.map(listed => listed.code)).not.toContain(old.item.code);
  expect((await owner()).find(listed => listed.code === old.item.code)?.status).toBe('sold');
  const soldNow = seeded[0]!.code;
  await db.query("update items set status='sold',sold_at=$2 where code=$1", [soldNow, new Date(now.getTime() + 60_000)]);
  expect(((await page()).items as { code: string; availability: string }[]).find(listed => listed.code === soldNow)?.availability).toBe('sold');
  expect((await page()).items).toHaveLength(14);
});
it('requires a demo owner cookie, rotates stock and sessions, and keeps old payment records and codes', async () => {
  const main = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  expect((await reset({})).statusCode).toBe(401);
  expect((await reset(main)).statusCode).toBe(403);
  const { id, item, session } = await checkout('paid');
  await db.query("update items set status='sold',sold_checkout_id=$1,sold_at=$2 where id=$3", [id, now, item.id]);
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAPTURE',$1,$2,'GBP','COMPLETED')", [id, item.asking_pence]);
  const before = (await page()).items;
  const payments = (await db.query('select * from captures')).rows;
  expect((await reset()).statusCode).toBe(200);
  const after = await page();
  expect(after.items).toHaveLength(14);
  for (const old of before) {
    expect(after.items.some((fresh: { code: string }) => fresh.code === old.code)).toBe(false);
    expect((await app.inject(`/api/i/${old.code}`)).json().availability).toBe('removed');
  }
  expect((await db.query('select * from captures')).rows).toEqual(payments);
  expect((await db.query('select state from checkouts where id=$1', [id])).rows[0].state).toBe('paid');
  expect((await db.query('select code from checkout_lines where checkout_id=$1', [id])).rows[0].code).toBe(item.code);
  expect((await db.query('select status,cutoff_at,closed_at from trading_sessions where id=$1', [session.id])).rows[0]).toEqual({ status: 'closed', cutoff_at: now, closed_at: now });
  expect((await db.query("select * from trading_sessions where stall_id=$1 and status='open'", [demoId])).rowCount).toBe(1);
});
it('lets checkout admission finish while a reset waits on the session lock, then refuses the reset', async () => {
  const tx = await db.connect();
  await tx.query('begin');
  const session = (await tx.query("select id from trading_sessions where stall_id=$1 and status='open' for update", [demoId])).rows[0];
  const pid = (await tx.query('select pg_backend_pid() as pid')).rows[0].pid;
  const pending = reset();
  try {
    await vi.waitFor(async () => expect((await db.query('select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount).toBe(1));
    const buyer = (await tx.query('insert into buyer_sessions(token_hash) values ($1) returning id', [randomUUID()])).rows[0];
    await tx.query(`insert into checkouts(stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline)
      values ($1,$2,$3,'creating',1000,$4,$5,$6,$7)`, [demoId, session.id, buyer.id, randomUUID(), randomUUID(), randomUUID(), new Date(now.getTime() + 300_000)]);
    await tx.query('commit');
    expect((await pending).statusCode).toBe(409);
  } finally { await tx.query('rollback'); tx.release(); }
});
it.each([
  ['2026-11-06T02:59:30Z', '2026-11-06T03:00:00Z'],
  ['2026-07-06T01:59:30Z', '2026-07-06T02:00:00Z'],
  ['2026-03-29T01:59:30Z', '2026-03-29T02:00:00Z'],
  ['2026-10-25T02:59:30Z', '2026-10-25T03:00:00Z'],
])('the repair timer resets once at 03:00 London across %s', async (before, due) => {
  await app.close();
  now = new Date(before);
  await db.query('update stalls set demo_reset_at=$1 where is_demo=true', [new Date(now.getTime() - 86_400_000)]);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  app = buildApp(config, { db, now: () => now }); await app.ready();
  const codes = (await page()).items.map((item: { code: string }) => item.code);
  now = new Date(due); await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect(await lastReset()).toEqual(now));
  const fresh = (await page()).items.map((item: { code: string }) => item.code);
  expect(fresh.some((code: string) => codes.includes(code))).toBe(false);
  now = new Date(now.getTime() + 30_000); await vi.advanceTimersByTimeAsync(30_000);
  await app.close(); app = buildApp(config, { db, now: () => now }); await app.ready();
  expect((await page()).items.map((item: { code: string }) => item.code)).toEqual(fresh);
});
it('retries a blocked nightly reset after the payment resolves', async () => {
  const { id } = await checkout('checking');
  await app.close();
  now = new Date('2026-11-06T03:00:00Z');
  app = buildApp(config, { db, now: () => now }); await app.ready();
  expect(await lastReset()).toEqual(new Date('2026-11-05T02:59:00Z'));
  await db.query("update checkouts set state='failed' where id=$1", [id]);
  await app.close(); app = buildApp(config, { db, now: () => now }); await app.ready();
  expect(await lastReset()).toEqual(now);
});
it('starts the demo stall without a charity pledge', async () => {
  expect((await page()).charity).toBeNull();
  expect((await app.inject({ method: 'GET', url: '/api/owner/stall/charity', cookies })).json().charity).toBeNull();
});
it('clears a pledge the owner set on the demo stall when it resets', async () => {
  await app.inject({ method: 'PUT', url: '/api/owner/stall/charity', cookies, payload: { name: 'Elsewhere', percent: 50 } });
  expect((await page()).charity).toMatchObject({ line: "50% of today's takings go to Elsewhere.", seeded: false });
  expect((await reset()).statusCode).toBe(200);
  expect((await page()).charity).toBeNull();
  expect((await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies })).json().charity).toBeNull();
});

const minutes = (count: number) => demoIdleResetMs * count / 20;
const noon = new Date('2026-11-05T12:00:00Z');
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
// Restarting runs the same repair pass the 30 second timer runs, at the clock given. The nightly reset has already run today.
async function restartAt(time: Date) {
  await app.close();
  now = time;
  await db.query('update stalls set demo_reset_at=$1 where is_demo=true', [new Date('2026-11-05T03:30:00Z')]);
  app = buildApp(config, { db, now: () => now }); await app.ready();
  cookies = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
}
const codes = async (): Promise<string[]> => (await page()).items.map((item: { code: string }) => item.code);
async function closeStall(at: Date) {
  await restartAt(at);
  expect((await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies })).statusCode).toBe(200);
  await db.query("update trading_sessions set status='closed',closed_at=cutoff_at where stall_id=$1", [demoId]);
}
const shelfCheck = async (observation: string) => {
  const { closing } = (await app.inject({ url: '/api/owner/closing', cookies })).json();
  return app.inject({ method: 'PUT', url: '/api/owner/closing/shelf-check', cookies, payload: { sessionId: closing.sessionId, itemId: closing.items[0].id, observation } });
};
it('marks a closed demo item as a demo stall item for the buyer page', async () => {
  const [code] = await codes();
  expect((await app.inject(`/api/i/${code}`)).json()).toMatchObject({ availability: 'available', demoStall: true });
  await closeStall(noon);
  expect((await app.inject(`/api/i/${code}`)).json()).toMatchObject({ availability: 'closed', demoStall: true });
});
it('publishes the idle window the web page quotes', async () => {
  expect((await page()).reset.idleMinutes).toBe(20);
});
it('says whether the demo stall is open, so the page can keep its reset link out of the way', async () => {
  expect((await page()).open).toBe(true);
  await closeStall(noon);
  expect((await page()).open).toBe(false);
});
it('the repair timer resets a stall that has been closed for the whole window, and not before', async () => {
  await closeStall(noon);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await restartAt(noon);
  const before = await codes();
  now = later(noon, demoIdleResetMs - 30_000); await vi.advanceTimersByTimeAsync(30_000);
  await app.close(); await restartAt(now);
  expect(await codes()).toEqual(before);
  await restartAt(later(noon, demoIdleResetMs - 30_000));
  now = later(noon, demoIdleResetMs); await vi.advanceTimersByTimeAsync(30_000);
  await vi.waitFor(async () => expect(await lastReset()).toEqual(now));
  expect((await codes()).some(code => before.includes(code))).toBe(false);
  expect((await db.query("select * from trading_sessions where stall_id=$1 and status='open'", [demoId])).rowCount).toBe(1);
});
it('restarts the window at every item the owner flags in the closing report', async () => {
  await closeStall(noon);
  const before = await codes();
  await restartAt(later(noon, minutes(15)));
  expect((await shelfCheck('present')).statusCode).toBe(200);
  await restartAt(later(noon, minutes(34)));
  expect(await codes()).toEqual(before);
  await restartAt(later(noon, minutes(35)));
  expect(await lastReset()).toEqual(now);
  expect(await codes()).not.toEqual(before);
});
it('resets an open stall once no item that takes offers is available, and not while one is', async () => {
  await restartAt(noon);
  const before = await codes();
  await db.query("update items set status='sold',sold_at=$2 where stall_id=$1 and mode='haggle' and illustration<>'lamp'", [demoId, noon]);
  await restartAt(later(noon, minutes(30)));
  expect(await codes()).toEqual(before);
  await db.query("update items set status='sold',sold_at=$2 where stall_id=$1 and mode='haggle'", [demoId, later(noon, minutes(30))]);
  await restartAt(later(noon, minutes(49)));
  expect(await codes()).toEqual(before);
  await restartAt(later(noon, minutes(50)));
  expect(await lastReset()).toEqual(now);
  expect(await codes()).not.toEqual(before);
});
it('keeps resetting an item held by a payment for later, and resets once the payment is gone', async () => {
  await restartAt(noon);
  const { id } = await checkout('checking');
  await db.query('update checkouts set created_at=$2 where id=$1', [id, noon]);
  await closeStall(noon);
  const before = await codes();
  await restartAt(later(noon, minutes(30)));
  expect(await codes()).toEqual(before);
  expect((await reset()).statusCode).toBe(409);
  await db.query("update checkouts set state='failed' where id=$1", [id]);
  await restartAt(later(noon, minutes(31)));
  expect(await lastReset()).toEqual(now);
  expect(await codes()).not.toEqual(before);
});
it('counts a payment as activity, so a sale in the last minutes of the window is not cut across', async () => {
  await restartAt(noon);
  const { id } = await checkout('paid');
  await db.query('update checkouts set created_at=$2 where id=$1', [id, later(noon, minutes(15))]);
  await closeStall(noon);
  const before = await codes();
  await restartAt(later(noon, minutes(34)));
  expect(await codes()).toEqual(before);
  await restartAt(later(noon, minutes(35)));
  expect(await codes()).not.toEqual(before);
});
// created_at comes from the database clock, so it is moved onto the test's clock.
async function addItem(at: Date) {
  const { id, code } = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies, payload: { name: 'Brass desk lamp', notes: 'Tested, it works. Scuff on the base.', mode: 'fixed', askingPence: 2800 } })).json();
  await db.query('update items set created_at=$2 where id=$1', [id, at]);
  return code as string;
}
it('counts new stock as activity, so an owner adding an item to a closed stall is not cut across', async () => {
  await closeStall(noon);
  await restartAt(later(noon, minutes(15)));
  const code = await addItem(now);
  // /demo lists the last session's stock, and this item joins a session only when the stall opens, so its tag is what shows it.
  const tag = async () => (await app.inject(`/api/i/${code}`)).json().availability;
  await restartAt(later(noon, minutes(34)));
  expect(await tag()).toBe('closed');
  await restartAt(later(noon, minutes(35)));
  expect(await lastReset()).toEqual(now);
  expect(await tag()).toBe('removed');
});
it('keeps the window on an open stall with no item that takes offers when fixed-price stock is added', async () => {
  await restartAt(noon);
  await db.query("update items set status='sold',sold_at=$2 where stall_id=$1 and mode='haggle'", [demoId, noon]);
  await restartAt(later(noon, minutes(15)));
  const code = await addItem(now);
  await restartAt(later(noon, minutes(19)));
  expect(await codes()).toContain(code);
  await restartAt(later(noon, minutes(20)));
  expect(await lastReset()).toEqual(now);
  expect(await codes()).not.toContain(code);
});
it('leaves the ended session readable, and its flags usable, after the reset', async () => {
  await closeStall(noon);
  const ended = (await app.inject({ url: '/api/owner/closing', cookies })).json().closing;
  await restartAt(later(noon, demoIdleResetMs));
  expect(await lastReset()).toEqual(now);
  const after = (await app.inject({ url: '/api/owner/closing', cookies })).json().closing;
  expect(after).toMatchObject({ sessionId: ended.sessionId, sessionStatus: 'closed' });
  expect(after.items.map((item: { id: string }) => item.id).sort()).toEqual(ended.items.map((item: { id: string }) => item.id).sort());
  expect((await shelfCheck('present')).statusCode).toBe(200);
  expect((await db.query("select * from trading_sessions where stall_id=$1 and status='open'", [demoId])).rowCount).toBe(1);
});
it('the main stall never resets itself', async () => {
  const main = (await db.query('select id from stalls where is_demo=false')).rows[0].id;
  await db.query("insert into trading_sessions(stall_id,opened_at,status,cutoff_at,closed_at) values ($1,$2,'closed',$2,$2)", [main, noon]);
  await restartAt(later(noon, minutes(60)));
  expect((await db.query("select count(*)::int as count from trading_sessions where stall_id=$1", [main])).rows[0].count).toBe(1);
});
it('refuses a reset once the stall has had 120 in an hour, and allows one when the hour has passed', async () => {
  for (let count = 0; count < 120; count++) expect((await reset()).statusCode).toBe(200);
  const codes = async () => (await db.query('select count(*)::int as count from items where stall_id=$1', [demoId])).rows[0].count;
  const before = await codes();
  const refused = await reset();
  expect(refused.statusCode).toBe(429);
  expect(refused.json()).toEqual({ error: 'This stall has been reset many times this hour. Try again later.' });
  expect(await codes()).toBe(before);
  now = new Date(now.getTime() + 3_600_001);
  expect((await reset()).statusCode).toBe(200);
});
it('spends no reset allowance on a reset that is refused', async () => {
  await checkout('checking');
  for (let count = 0; count < 121; count++) expect((await reset()).statusCode).toBe(409);
  await db.query("update checkouts set state='expired' where stall_id=$1", [demoId]);
  expect((await reset()).statusCode).toBe(200);
});
const closingPage = async () => (await app.inject({ url: '/api/owner/closing', cookies })).json();
it('shows no closing report for a reset-closed empty session while the stall is open, and records who closed it', async () => {
  expect((await reset()).statusCode).toBe(200);
  expect((await reset()).statusCode).toBe(200);
  const closed = (await db.query("select closed_by from trading_sessions where stall_id=$1 and status='closed'", [demoId])).rows;
  expect(closed.length).toBeGreaterThan(0);
  expect(closed.every(row => row.closed_by === 'demo_reset')).toBe(true);
  expect(await closingPage()).toMatchObject({ closing: null, stallOpen: true });
  // The page must not have written a closing record for stock the reset already replaced.
  expect((await db.query('select 1 from closings')).rowCount).toBe(0);
});
it('treats a session closed before closed_by was recorded by its activity alone', async () => {
  expect((await reset()).statusCode).toBe(200);
  expect((await reset()).statusCode).toBe(200);
  await db.query("update trading_sessions set closed_by=null where status='closed'");
  expect(await closingPage()).toMatchObject({ closing: null, stallOpen: true });
});
it('reports a reset-closed session that recorded a sale, as an earlier session', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { session } = await checkout('paid');
  expect((await reset()).statusCode).toBe(200);
  const page = await closingPage();
  expect(page.stallOpen).toBe(true);
  expect(page.closing).toMatchObject({ sessionId: session.id, sessionStatus: 'closed' });
  expect(page.closing.earlierClosedAt).toBe(now.toISOString());
});
for (const state of ['cancelled', 'expired']) {
  it(`skips a reset-closed session whose only checkout was ${state} without a capture`, async () => {
    expect((await reset()).statusCode).toBe(200);
    await checkout(state);
    expect((await reset()).statusCode).toBe(200);
    expect(await closingPage()).toMatchObject({ closing: null, stallOpen: true });
  });
  it(`reports a reset-closed session whose only checkout was ${state} without a capture but needs review`, async () => {
    expect((await reset()).statusCode).toBe(200);
    const { session } = await checkout(state, true);
    expect((await reset()).statusCode).toBe(200);
    expect(await closingPage()).toMatchObject({ stallOpen: true, closing: { sessionId: session.id } });
  });
}
it('skips an empty reset-closed session in favour of the latest one with activity', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { session } = await checkout('paid');
  expect((await reset()).statusCode).toBe(200);
  expect((await reset()).statusCode).toBe(200);
  expect((await closingPage()).closing).toMatchObject({ sessionId: session.id });
});
it('reports a session the owner closed with Close stall even when it recorded nothing', async () => {
  expect((await reset()).statusCode).toBe(200);
  const closed = await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies });
  expect(closed.statusCode).toBe(200);
  const page = await closingPage();
  expect(page.stallOpen).toBe(false);
  expect(page.closing).toMatchObject({ sessionId: closed.json().sessionId, earlierClosedAt: null });
  expect(page.closing.items.length).toBeGreaterThan(0);
  // A reset after the stallholder's close keeps the owner as the one who closed it.
  expect((await reset()).statusCode).toBe(200);
  expect(await closingPage()).toMatchObject({ stallOpen: true, closing: { sessionId: closed.json().sessionId } });
});
it('asks for no shelf check of stock a reset replaced, and still shows the sale', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { id, item, session } = await checkout('paid', false, await stocked('fixed'));
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAP-RESET',$1,1000,'GBP','COMPLETED')", [id]);
  expect((await reset()).statusCode).toBe(200);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: session.id, restocked: true, status: 'final', recordedSalesPence: 1000, paidCheckouts: 1, items: [{ id: item.id, paid: true }] });
  expect(held(closing)).toEqual([{ key: 'paid', label: 'Paid', items: [item.id] }]);
});
it('keeps the report of a session the owner closed after a later reset, with an item the owner flagged', async () => {
  expect((await reset()).statusCode).toBe(200);
  const closed = (await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies })).json();
  const [answered, ...rest] = closed.items as Array<{ id: string }>;
  const put = (itemId: string, observation: string) => app.inject({ method: 'PUT', url: '/api/owner/closing/shelf-check', cookies, payload: { sessionId: closed.sessionId, itemId, observation } });
  expect((await put(answered!.id, 'absent')).statusCode).toBe(200);
  expect((await reset()).statusCode).toBe(200);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: closed.sessionId, restocked: false, status: 'final' });
  expect(Object.keys(summaryInput(closing))).toEqual(['reportStatus', 'recordedSales', 'refunded', 'paidCheckouts', 'itemsSold', 'itemsInReport', 'groupsWithItems', 'groups', 'removed']);
  expect(closing.groups.map((group: { key: string; label: string }) => [group.key, group.label])).toEqual([
    ['paidAbsent', 'Sold, gone with the buyer'], ['takenAbsent', 'Taken free, gone with the taker'],
    ['freeAbsent', 'Gone from the shelf, free item, nothing to pay'], ['unsoldPresent', 'Unsold, still at the stall'],
    ['unpaidAbsent', 'Not on the shelf, no confirmed payment. This record cannot say what happened.'], ['unresolved', 'Payment unresolved']]);
  expect(closing.items).toHaveLength(rest.length + 1);
  expect(closing.items.find((item: { id: string }) => item.id === answered!.id)).toMatchObject({ observation: 'absent' });
  expect(closing.items.filter((item: { observation: string }) => item.observation === 'unknown')).toHaveLength(rest.length);
});
it('reports a reset session of stock the owner removed before the reset', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { id, item, session } = await checkout('paid', false, await stocked('fixed'));
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAP-REMOVED',$1,1000,'GBP','COMPLETED')", [id]);
  const other = (await db.query("select id from items where stall_id=$1 and id<>$2 and status='available' limit 1", [demoId, item.id])).rows[0];
  expect((await app.inject({ method: 'POST', url: `/api/owner/items/${other.id}/remove`, cookies, payload: { reason: 'Chipped' } })).statusCode).toBe(200);
  expect((await reset()).statusCode).toBe(200);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: session.id, restocked: true, status: 'final', recordedSalesPence: 1000, removed: [] });
  expect(held(closing)).toEqual([{ key: 'paid', label: 'Paid', items: [item.id] }]);
});
it('lists a free item taken with a tip and message in a reset session, with no question for the owner', async () => {
  expect((await reset()).statusCode).toBe(200);
  const session = (await db.query("select id from trading_sessions where stall_id=$1 and status='open'", [demoId])).rows[0];
  const item = await stocked('free');
  const buyer = (await db.query('insert into buyer_sessions(token_hash) values ($1) returning id', [randomUUID()])).rows[0];
  await db.query('insert into free_takes (item_id,stall_id,trading_session_id,buyer_session_id,message,taken_at) values ($1,$2,$3,$4,$5,$6)', [item.id, demoId, session.id, buyer.id, 'Thanks!', now]);
  const tip = (await db.query(`insert into checkouts(stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline,kind)
    values ($1,$2,$3,'paid',200,$4,$5,$6,$7,'tip') returning id`, [demoId, session.id, buyer.id, randomUUID(), randomUUID(), randomUUID(), new Date(now.getTime() + 300_000)])).rows[0].id;
  await db.query('insert into checkout_lines(checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,200,200)', [tip, item.id, item.code, item.name]);
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAP-TIP',$1,200,'GBP','COMPLETED')", [tip]);
  expect((await reset()).statusCode).toBe(200);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: session.id, restocked: true, status: 'final', itemsTaken: 1, tipsPence: 200, tipCount: 1,
    items: [{ id: item.id, name: item.name, code: item.code, taken: true, tipPence: 200, message: 'Thanks!' }] });
  expect(held(closing)).toEqual([{ key: 'taken', label: 'Taken free', items: [item.id] }]);
});
it('lists a payment needing review in a reset session, and stays provisional only for that payment', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { item, session } = await checkout('checking', true, await stocked('fixed'));
  expect((await reset()).statusCode).toBe(200);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: session.id, restocked: true, status: 'provisional', items: [{ id: item.id, unresolved: true }] });
  expect(held(closing)).toEqual([{ key: 'unresolved', label: 'Payment unresolved', items: [item.id] }]);
});
it('lists no unpaid item in a reset session, even one the owner already answered', async () => {
  expect((await reset()).statusCode).toBe(200);
  const { id, item, session } = await checkout('paid', false, await stocked('fixed'));
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAP-UNSURE',$1,1000,'GBP','COMPLETED')", [id]);
  expect((await reset()).statusCode).toBe(200);
  await closingPage();
  const others = (await db.query(`select sc.item_id from shelf_checks sc join closings c on c.id=sc.closing_id where c.trading_session_id=$1 and sc.item_id<>$2 order by sc.item_id limit 2`, [session.id, item.id])).rows;
  await db.query("update shelf_checks set observation='unknown',observed_at=$2 where item_id=$1", [others[0].item_id, now]);
  await db.query("update shelf_checks set observation='present',observed_at=$2 where item_id=$1", [others[1].item_id, now]);
  const { closing } = await closingPage();
  expect(closing).toMatchObject({ sessionId: session.id, restocked: true, status: 'final', items: [{ id: item.id }], removed: [] });
  expect(held(closing)).toEqual([{ key: 'paid', label: 'Paid', items: [item.id] }]);
  expect(summaryInput(closing)).not.toHaveProperty('itemsInReport');
});

it('offers the repository link only when configured', async () => {
  expect((await page()).repoUrl).toBeNull();
  await app.close();
  app = buildApp({ ...config, demoRepoUrl: 'https://example.test/repo' }, { db, now: () => now });
  expect((await page()).repoUrl).toBe('https://example.test/repo');
});
it('marks no item as having a New from price without retail lookups', async () => {
  expect((await reset()).statusCode).toBe(200);
  expect((await page()).items.every((item: { newFrom: boolean }) => item.newFrom === false)).toBe(true);
});
it('marks only items with saved references after a reset and exposes their New from price to buyers', async () => {
  await app.close();
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const id = url.pathname.split('/').at(-1);
    return Response.json({ id, title: 'Retail item', offers: [{ url: 'https://shop.example/item', domain: 'shop.example', price: { price: 35, currency: 'GBP' }, availability: 'InStock', condition: 'new' }] });
  });
  app = buildApp({ ...config, channel3ApiKey: 'test' }, { db, now: () => now, fetcher });
  expect((await reset()).statusCode).toBe(200);
  const items = (await page()).items as Array<{ name: string; code: string; newFrom: boolean }>;
  expect(items.filter(item => item.newFrom).map(item => item.name)).toEqual(['Round wall mirror', 'Wooden stool']);
  expect(items.filter(item => !['Round wall mirror', 'Wooden stool'].includes(item.name)).every(item => item.newFrom === false)).toBe(true);
  for (const item of items.filter(item => item.newFrom)) {
    expect((await app.inject(`/api/i/${item.code}`)).json().retailReference).toMatchObject({ pricePence: 3500, retailer: 'shop.example' });
  }
});

// The Overview's Sold and Taken free tiles once counted every sold item the stall had ever had. A sale refunded in full keeps its checkout
// flagged, so a reset keeps that item sold, and closing then reopening keeps an earlier session's sales on the stall too.
describe('the Overview tiles count the trading session as the live feed does', () => {
  const post = (url: string) => app.inject({ method: 'POST', url, cookies, payload: {} });
  const get = async (url: string) => (await app.inject({ url, cookies })).json();
  const later = (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000); };
  async function overview() {
    const data = await get('/api/owner/items') as { items: Array<{ status: string }>; takenPence: number; itemsSold: number; itemsTaken: number };
    return { recordedPence: data.takenPence, sold: data.itemsSold, taken: data.itemsTaken, forSale: data.items.filter(item => item.status !== 'sold' && item.status !== 'removed').length };
  }
  async function feed() {
    const data = await get('/api/owner/feed');
    return { recordedPence: data.recordedSalesPence, sold: data.itemsSold, taken: data.itemsTaken, forSale: data.unsoldRecords };
  }
  // A completed sale as the payment path leaves it: paid checkout, completed capture, item sold, and the feed's sale event.
  async function sell(name: string, pence: number) {
    const item = (await db.query("select * from items where stall_id=$1 and name=$2 and status='available'", [demoId, name])).rows[0];
    const session = (await db.query("select id from trading_sessions where stall_id=$1 and status='open'", [demoId])).rows[0];
    const buyer = (await db.query('insert into buyer_sessions(token_hash) values ($1) returning id', [randomUUID()])).rows[0];
    const id = (await db.query(`insert into checkouts(stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline,paypal_order_id)
      values ($1,$2,$3,'paid',$4,$5,$6,$7,$8,$9) returning id`, [demoId, session.id, buyer.id, pence, randomUUID(), randomUUID(), randomUUID(), new Date(now.getTime() + 300_000), `ORDER-${randomUUID()}`])).rows[0].id;
    await db.query('insert into checkout_lines(checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$6)', [id, item.id, item.code, item.name, item.asking_pence, pence]);
    const captureId = `CAPTURE-${randomUUID()}`;
    await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status,captured_at,observed_at) values ($1,$2,$3,'GBP','COMPLETED',$4,$4)", [captureId, id, pence, now]);
    await db.query("update items set status='sold',sold_checkout_id=$1,sold_at=$2 where id=$3", [id, now, item.id]);
    await db.query("insert into events(stall_id,trading_session_id,type,payload,business_key,created_at) values ($1,$2,'sale',$3,$4,$5)", [demoId, session.id, JSON.stringify({ captureId }), `sale:${id}`, now]);
    return { id, captureId };
  }
  // What a completed refund webhook does: record it and flag the checkout for review.
  async function refundInFull(sale: { id: string; captureId: string }, pence: number) {
    await db.query("insert into refunds(paypal_refund_id,paypal_capture_id,amount_pence,status,observed_at) values ($1,$2,$3,'COMPLETED',$4)", [`REFUND-${randomUUID()}`, sale.captureId, pence, now]);
    await db.query("update checkouts set review_required=true,review_reason='Payment refunded. Collection withdrawn.' where id=$1", [sale.id]);
  }

  it('leaves out an item sold and refunded in an earlier session, which every reset keeps as sold', async () => {
    await post('/api/owner/demo/reset');
    const can = await sell('Watering can', 1000);
    later(3); await refundInFull(can, 1000);
    later(240); await post('/api/owner/demo/reset');
    later(60); await post('/api/owner/demo/reset');
    expect((await db.query("select count(*)::integer as count from items where stall_id=$1 and status='sold'", [demoId])).rows[0].count).toBe(1);
    expect(await overview()).toEqual({ recordedPence: 0, sold: 0, taken: 0, forSale: 14 });
    expect(await feed()).toEqual(await overview());
    later(24); await sell('Brass desk lamp', 2200);
    expect(await overview()).toEqual({ recordedPence: 2200, sold: 1, taken: 0, forSale: 13 });
    expect(await feed()).toEqual(await overview());
    later(1);
    expect((await post('/api/owner/stall/close')).json().itemsSold).toBe(1);
  });
  it('keeps the closed session\'s sales on a closed stall, a day later too, and starts again from none on reopening', async () => {
    later(1); await post('/api/owner/demo/reset');
    later(1); await sell('Brass desk lamp', 2200);
    later(5); expect((await post('/api/owner/stall/close')).json().itemsSold).toBe(1);
    // The service's 30 second repair loop closes a closing session with no payment in progress. Done by hand here.
    later(1); await db.query("update trading_sessions set status='closed',closed_at=$2 where stall_id=$1 and status='closing'", [demoId, now]);
    expect(await overview()).toEqual({ recordedPence: 2200, sold: 1, taken: 0, forSale: 13 });
    // The feed counts a closed session's stock at its closing time, which this test's injected clock puts before the seeded rows were written.
    expect(await feed()).toMatchObject({ recordedPence: 2200, sold: 1, taken: 0 });
    // The Overview shows the latest session as the feed and the closing report do, so a day later it still shows that session.
    later(24 * 60);
    expect(await overview()).toEqual({ recordedPence: 2200, sold: 1, taken: 0, forSale: 13 });
    expect(await feed()).toMatchObject({ recordedPence: 2200, sold: 1, taken: 0 });
    later(1); expect((await post('/api/owner/stall/open')).statusCode).toBe(201);
    later(1);
    expect(await overview()).toEqual({ recordedPence: 0, sold: 0, taken: 0, forSale: 13 });
    expect(await feed()).toEqual(await overview());
  });
});
