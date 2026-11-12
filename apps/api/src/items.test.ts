import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { respondToOffer } from './pricing.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'https://stall.example' };
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let demo: Record<string, string>;
const input = { name: 'Brass lamp', notes: 'Tested, it works. Small scuff on the base.', mode: 'haggle', askingPence: 2800, floorPence: 1739 };
beforeEach(async () => {
  app = buildApp(config, { db });
  const login = async (password: string) => ({ stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password } })).cookies[0]!.value });
  owner = await login('owner'); demo = await login('demo');
  await db.query('truncate item_floors, items, buyer_sessions, trading_sessions cascade');
});
afterEach(async () => { await app.close(); });
const add = (payload = input, cookies = owner) => app.inject({ method: 'POST', url: '/api/owner/items', cookies, payload });
const open = () => app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
it('refuses a new item once a stall has added 120 in an hour, per stall, and allows one when the hour has passed', async () => {
  await app.close();
  let time = new Date('2026-11-05T10:00:00Z');
  app = buildApp(config, { db, now: () => time });
  for (let count = 0; count < 120; count++) expect((await add()).statusCode).toBe(201);
  const refused = await add();
  expect(refused.statusCode).toBe(429);
  expect(refused.json()).toEqual({ error: 'Too many items have been added this hour. Try again later.' });
  expect((await db.query('select count(*)::int as count from items')).rows[0].count).toBe(120);
  expect((await add(input, demo)).statusCode).toBe(201);
  time = new Date(time.getTime() + 3_600_001);
  expect((await add()).statusCode).toBe(201);
});
it('lets the demo stall add items again after a reset, within the same hour', async () => {
  for (let count = 0; count < 120; count++) expect((await add(input, demo)).statusCode).toBe(201);
  expect((await add(input, demo)).statusCode).toBe(429);
  expect((await app.inject({ method: 'POST', url: '/api/owner/demo/reset', cookies: demo })).statusCode).toBe(200);
  expect((await add(input, demo)).statusCode).toBe(201);
});
it('validates floors, edits prices with versions, and keeps owner data stall-scoped', async () => {
  expect((await add({ ...input, floorPence: 2801 })).statusCode).toBe(400);
  expect((await add({ ...input, floorPence: 0 })).statusCode).toBe(400);
  expect((await add(input, {})).statusCode).toBe(401);
  const created = await add(); expect(created.statusCode).toBe(201);
  const item = created.json(); expect(item.floorPence).toBe(1739); expect(item.priceVersion).toBe(1);
  expect(item.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  expect((await app.inject({ url: '/api/owner/items', cookies: demo })).json().items).toEqual([]);
  const patch = (payload: object, cookies = owner) => app.inject({ method: 'PATCH', url: `/api/owner/items/${item.id}`, cookies, payload });
  expect((await patch({ floorPence: 1900 }, demo)).statusCode).toBe(404);
  expect((await patch({ floorPence: 1900 })).json()).toMatchObject({ floorPence: 1900, priceVersion: 2 });
  expect((await patch({ askingPence: 1800 })).statusCode).toBe(400);
  expect((await patch({ askingPence: 2500 })).json()).toMatchObject({ askingPence: 2500, priceVersion: 3 });
  expect((await patch({ notes: 'Updated notes' })).json().priceVersion).toBe(3);
  expect((await patch({ mode: 'fixed' })).json()).toMatchObject({ floorPence: null, priceVersion: 4 });
  expect((await db.query('select * from item_floors')).rowCount).toBe(0);
});
it('bumps the price version only when a full form save changes a price', async () => {
  const haggle = (await add()).json();
  const save = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/owner/items/${id}`, cookies: owner, payload });
  expect((await save(haggle.id, { ...input, notes: 'Typo fixed' })).json()).toMatchObject({ notes: 'Typo fixed', floorPence: 1739, priceVersion: 1 });
  expect((await save(haggle.id, { ...input, floorPence: 1800 })).json().priceVersion).toBe(2);
  expect((await save(haggle.id, { ...input, floorPence: 1800, askingPence: 3000 })).json().priceVersion).toBe(3);
  const fixedForm = { ...input, mode: 'fixed', floorPence: null };
  const fixed = (await add(fixedForm)).json();
  expect((await save(fixed.id, { ...fixedForm, notes: 'Typo fixed' })).json().priceVersion).toBe(1);
  expect((await save(fixed.id, input)).json()).toMatchObject({ mode: 'haggle', floorPence: 1739, priceVersion: 2 });
});
it('retains codes after removal, refuses code mutation and deletion, and records reasons', async () => {
  const item = (await add()).json();
  const remove = (reason: string) => app.inject({ method: 'POST', url: `/api/owner/items/${item.id}/remove`, cookies: owner, payload: { reason } });
  expect((await remove(' ')).statusCode).toBe(400);
  expect((await remove('Keeping it')).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json().items[0]).toMatchObject({ status: 'removed', removedReason: 'Keeping it' });
  expect((await app.inject(`/api/i/${item.code}`)).json().availability).toBe('removed');
  expect((await add()).json().code).not.toBe(item.code);
  await expect(db.query('update items set code=$1 where id=$2', ['AAAA', item.id])).rejects.toThrow('immutable');
  await expect(db.query('delete from items where id=$1', [item.id])).rejects.toThrow('removed');
});
it('allows one unclosed session, even for simultaneous opens, and exposes availability', async () => {
  const item = (await add()).json();
  const buyer = () => app.inject(`/api/i/${item.code}`);
  expect((await buyer()).json()).toMatchObject({ availability: 'closed', demoStall: false });
  expect((await Promise.all([open(), open()])).map(r => r.statusCode).sort()).toEqual([201, 409]);
  expect((await buyer()).json().availability).toBe('available');
  await db.query("update trading_sessions set status='closing'");
  expect((await open()).statusCode).toBe(409);
  expect((await buyer()).json().availability).toBe('closed');
  await db.query("update items set status='sold' where id=$1", [item.id]);
  expect((await buyer()).json().availability).toBe('sold');
  await db.query("update trading_sessions set status='closed'");
  expect((await open()).statusCode).toBe(201);
});
it('sets an opaque HTTP-only buyer cookie, persists only its hash and reuses it', async () => {
  const item = (await add()).json();
  const first = await app.inject(`/api/i/${item.code}`);
  const cookie = first.cookies[0]!;
  expect(cookie).toMatchObject({ name: 'stallkeeper_buyer', httpOnly: true, sameSite: 'Lax', path: '/api' });
  expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);
  const rows = (await db.query('select * from buyer_sessions')).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).toBe(createHash('sha256').update(cookie.value).digest('hex'));
  expect(JSON.stringify(rows)).not.toContain(cookie.value);
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies: { stallkeeper_buyer: cookie.value } })).cookies).toEqual([]);
  expect((await db.query('select * from buyer_sessions')).rowCount).toBe(1);
  expect((await app.inject('/api/i/ZZZZ')).statusCode).toBe(404);
  expect(first.headers['cache-control']).toBe('no-store');
});
it('decodes every PNG from the real tags route to the exact URL, with four white modules and no floor or price in URLs', async () => {
  for (let i = 0; i < 9; i++) await add({ ...input, name: `Item ${i}` });
  const response = await app.inject({ url: '/api/owner/tags', cookies: owner });
  const tags = response.json().tags;
  expect(tags).toHaveLength(9);
  for (const tag of tags) {
    const png = PNG.sync.read(Buffer.from(tag.qrPng.split(',')[1], 'base64'));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(`https://stall.example/i/${tag.code}`);
    expect(decoded?.data).not.toMatch(/2800|28\.00|1739|17\.39/);
    // The route renders each module at six pixels, including all four quiet modules.
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      if (x < 24 || y < 24 || x >= png.width - 24 || y >= png.height - 24) expect(png.data[(y * png.width + x) * 4]).toBe(255);
    }
    const buyer = await app.inject(`/api/i/${tag.code}`);
    expect(buyer.body).not.toMatch(/floor|priceVersion|1739|17\.39/);
    expect(buyer.json().item).toMatchObject({ name: tag.name, notes: input.notes, askingPence: 2800 });
  }
  const { tags: withoutPng } = response.json();
  for (const tag of withoutPng) delete tag.qrPng;
  expect(JSON.stringify(withoutPng)).not.toMatch(/floor|priceVersion|1739|17\.39/);
  expect((await app.inject('/api/stall')).body).not.toMatch(/floor|priceVersion|1739|17\.39/);
  expect((await app.inject({ url: '/api/owner/tags', cookies: demo })).json().tags).toEqual([]);
  expect((await app.inject('/api/owner/tags')).statusCode).toBe(401);
});
it('previews the counter-offer ladder to owners from the same code that issues counters', async () => {
  const ladder = (payload: object, cookies = owner) => app.inject({ method: 'POST', url: '/api/owner/ladder', payload, cookies });
  const preview = await ladder({ askingPence: 2850, floorPence: 1739 });
  expect(preview.json()).toEqual({ counterOffersPence: [2450, 2200, 2000] });
  expect(preview.headers['cache-control']).toBe('no-store');
  // Each previewed amount is what a live round issues.
  const rounds = [1, 2, 3].map(round => respondToOffer({ status: 'available', asking_pence: 2850, floor_pence: 1739 }, 1739, round).amountPence);
  expect(preview.json().counterOffersPence).toEqual(rounds);
  expect((await ladder({ askingPence: 2850, floorPence: 3000 })).statusCode).toBe(400);
  expect((await ladder({ askingPence: 2850 })).statusCode).toBe(400);
  expect((await ladder({ askingPence: 2850, floorPence: 1739 }, {})).statusCode).toBe(401);
  expect((await ladder({ askingPence: 100, floorPence: 100 })).json().counterOffersPence).toEqual([100]);
});
it('keeps a previewed floor out of the request logs', async () => {
  await app.close();
  const lines: string[] = [];
  app = buildApp(config, { db, logger: { level: 'info', stream: { write: line => { lines.push(line); } } } });
  const response = await app.inject({ method: 'POST', url: '/api/owner/ladder', payload: { askingPence: 2850, floorPence: 1739 }, cookies: owner });
  expect(response.statusCode).toBe(200);
  const requests = lines.map(line => JSON.parse(line)).filter(entry => entry.req);
  expect(requests[0].req.url).toBe('/api/owner/ladder');
  expect(lines.join('')).not.toContain('1739');
});
it('lists available items first, then sold, then removed, each in the order they were added', async () => {
  const [old, sold] = [(await add({ ...input, name: 'Old lamp' })).json(), (await add({ ...input, name: 'Sold lamp' })).json()];
  await add({ ...input, name: 'Live lamp' });
  await add({ ...input, name: 'Later lamp' });
  await app.inject({ method: 'POST', url: `/api/owner/items/${old.id}/remove`, cookies: owner, payload: { reason: 'Kept it' } });
  await db.query("update items set status='sold' where id=$1", [sold.id]);
  const names = async () => (await app.inject({ url: '/api/owner/items', cookies: owner })).json().items.map((row: { name: string; status: string }) => `${row.name}:${row.status}`);
  expect(await names()).toEqual(['Live lamp:available', 'Later lamp:available', 'Sold lamp:sold', 'Old lamp:removed']);
});

it('reports what each sold item took and the session takings net of refunds on the owner list', async () => {
  const item = (await add({ ...input, floorPence: null, mode: 'fixed', askingPence: 2400 })).json();
  await open();
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json()).toMatchObject({ takenPence: 0, items: [{ soldPence: null }] });
  await db.query("insert into buyer_sessions (token_hash) values ('home-test')");
  const checkout = (await db.query<{ id: string }>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline)
    select i.stall_id,t.id,b.id,'paid',2400,i.id::text,gen_random_uuid(),gen_random_uuid(),now() from items i join trading_sessions t on t.stall_id=i.stall_id cross join buyer_sessions b returning id`)).rows[0]!;
  await db.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) select $1,id,code,name,asking_pence,2400 from items', [checkout.id]);
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status) values ('CAP-HOME',$1,2400,'GBP','COMPLETED')", [checkout.id]);
  await db.query("update items set status='sold' where id=$1", [item.id]);
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json()).toMatchObject({ takenPence: 2400, items: [{ status: 'sold', soldPence: 2400 }] });
});

it('counts the whole session in the takings, across midnight and once closed, whatever day it closed, as the feed does', async () => {
  await add({ ...input, floorPence: null, mode: 'fixed', askingPence: 2400 });
  await open();
  await db.query("insert into buyer_sessions (token_hash) values ('home-old')");
  const checkout = (await db.query<{ id: string }>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline)
    select i.stall_id,t.id,b.id,'paid',2400,i.id::text,gen_random_uuid(),gen_random_uuid(),now() from items i join trading_sessions t on t.stall_id=i.stall_id cross join buyer_sessions b returning id`)).rows[0]!;
  await db.query("insert into captures(paypal_capture_id,checkout_id,amount_pence,currency,status,captured_at,observed_at) values ('CAP-OLD',$1,2400,'GBP','COMPLETED',now() - interval '2 days',now())", [checkout.id]);
  await db.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) select $1,id,code,name,asking_pence,2400 from items', [checkout.id]);
  await db.query("insert into events(stall_id,trading_session_id,type,payload,business_key) select stall_id,trading_session_id,'sale',$2,$3 from checkouts where id=$1", [checkout.id, JSON.stringify({ captureId: 'CAP-OLD' }), `sale:${checkout.id}`]);
  await db.query("update trading_sessions set opened_at=now() - interval '2 days'");
  const home = async () => (await app.inject({ url: '/api/owner/items', cookies: owner })).json();
  const feed = async () => { const { recordedSalesPence, itemsSold, itemsTaken } = (await app.inject({ url: '/api/owner/feed', cookies: owner })).json(); return { takenPence: recordedSalesPence, itemsSold, itemsTaken }; };
  expect(await home()).toMatchObject({ sessionStatus: 'open', takenPence: 2400, itemsSold: 1, itemsTaken: 0 });
  expect(await home()).toMatchObject(await feed());
  await db.query("update trading_sessions set status='closed', closed_at=now()");
  expect(await home()).toMatchObject({ sessionStatus: 'closed', takenPence: 2400, itemsSold: 1, itemsTaken: 0 });
  await db.query("update trading_sessions set closed_at=now() - interval '2 days'");
  expect(await home()).toMatchObject({ sessionStatus: 'closed', takenPence: 2400, itemsSold: 1, itemsTaken: 0 });
  expect(await home()).toMatchObject(await feed());
});

it('counts nothing sold or taken free on a stall that has never opened, even with an item already marked sold', async () => {
  const item = (await add()).json();
  await db.query("update items set status='sold' where id=$1", [item.id]);
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json()).toMatchObject({ sessionStatus: 'closed', takenPence: 0, itemsSold: 0, itemsTaken: 0 });
});

it('answers a tag code carrying a NUL byte as an unknown tag, without starting a buyer session', async () => {
  await db.query('truncate buyer_sessions cascade');
  const response = await app.inject('/api/i/%00');
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: 'That tag is not on this stall.' });
  expect((await db.query('select count(*)::int as count from buyer_sessions')).rows[0].count).toBe(0);
});
