import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { PAY_WHAT_YOU_WANT_MAX_PENCE, validateOffer } from './pricing.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'https://stall.example' };
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let evidence: Record<string, unknown>;
let created: Array<{ purchase_units: Array<{ custom_id: string; amount: { value: string } }> }>;
const form = { name: 'Seed tins', notes: 'Clean. Four tins.', mode: 'pwyw', askingPence: 500 };
// The same item with no expected amount, which the owner may leave out.
const bare = { name: form.name, notes: form.notes, mode: form.mode };
const add = (payload: object = form) => app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload });
const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/owner/items/${id}`, cookies: owner, payload });
const buyer = async (code: string) => ({ stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value });
const pay = (code: string, cookies: Record<string, string>, payload: object = {}) => app.inject({ method: 'POST', url: `/api/i/${code}/checkout`, cookies, payload });
const capture = (id: string, cookies: Record<string, string>) => app.inject({ method: 'POST', url: `/api/checkouts/${id}/capture`, cookies, payload: {} });
const completed = (id: string, value: string) => ({ id: 'ORDER1', status: 'APPROVED', purchase_units: [{ custom_id: id, payments: { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: { value, currency_code: 'GBP' } }] } }] });
beforeEach(async () => {
  await db.query('truncate item_floors, items, buyer_sessions, trading_sessions cascade');
  created = []; evidence = {};
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (String(url).endsWith('/capture')) return Response.json(evidence);
    created.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'ORDER1' });
  });
  app = buildApp(config, { db, fetcher });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
});
afterEach(async () => { await app.close(); });

it('creates and edits pay-what-you-want items with an optional minimum, validated in pence', async () => {
  const plain = await add(); expect(plain.statusCode).toBe(201);
  expect(plain.json()).toMatchObject({ mode: 'pwyw', askingPence: 500, minimumPence: null });
  const withMinimum = (await add({ ...form, minimumPence: 200 })).json();
  expect(withMinimum).toMatchObject({ mode: 'pwyw', askingPence: 500, minimumPence: 200, floorPence: null });
  expect((await db.query('select minimum_pence from items where id=$1', [withMinimum.id])).rows).toEqual([{ minimum_pence: 200 }]);
  expect((await db.query('select * from item_floors where item_id=$1', [withMinimum.id])).rowCount).toBe(0);
  expect((await add({ ...form, minimumPence: 501 })).json().error).toBe('Set a minimum no higher than the expected amount.');
  // The request schema coerces 0 to null for this field, so a minimum of zero means no minimum.
  expect((await add({ ...form, minimumPence: 0 })).json()).toMatchObject({ mode: 'pwyw', minimumPence: null });
  expect((await add({ ...form, askingPence: PAY_WHAT_YOU_WANT_MAX_PENCE + 1 })).statusCode).toBe(400);
  expect((await add({ ...form, askingPence: PAY_WHAT_YOU_WANT_MAX_PENCE })).statusCode).toBe(201);
  expect((await add({ ...form, askingPence: 1.5 })).statusCode).toBe(400);
  expect((await add({ ...form, mode: 'gift' })).statusCode).toBe(400);
  expect((await patch(withMinimum.id, { minimumPence: 300 })).json()).toMatchObject({ minimumPence: 300, priceVersion: 2 });
  expect((await patch(withMinimum.id, { minimumPence: null })).json()).toMatchObject({ minimumPence: null, priceVersion: 3 });
  expect((await patch(withMinimum.id, { askingPence: 800 })).json()).toMatchObject({ askingPence: 800, priceVersion: 4 });
  expect((await patch(withMinimum.id, { minimumPence: 900 })).statusCode).toBe(400);
  expect((await patch(withMinimum.id, { minimumPence: 700 })).statusCode).toBe(200);
  expect((await patch(withMinimum.id, { askingPence: 600 })).json().error).toBe('Set a minimum no higher than the expected amount.');
  expect((await patch(withMinimum.id, { mode: 'fixed' })).json()).toMatchObject({ mode: 'fixed', minimumPence: null });
});

it('changes the mode of an item the previous build saved with a hidden suggestion', async () => {
  const item = (await add()).json();
  await db.query('update items set suggestion_hidden=true where id=$1', [item.id]);
  const changed = await patch(item.id, { mode: 'fixed' });
  expect(changed.statusCode).toBe(200);
  expect(changed.json()).toMatchObject({ mode: 'fixed', askingPence: 500 });
});

it('shows the minimum to buyers as a public field, and no floor', async () => {
  const item = (await add({ ...form, minimumPence: 200 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const page = await app.inject(`/api/i/${item.code}`);
  expect(page.json().item).toMatchObject({ mode: 'pwyw', askingPence: null, minimumPence: 200 });
  expect(page.json().chatAvailable).toBe(false);
  expect(page.body).not.toContain('floor');
  expect((await app.inject('/api/stall')).json().items).toEqual([expect.objectContaining({ minimumPence: 200 })]);
});

it("keeps the owner's expected amount out of every buyer response, while the owner still sees, edits and clears it", async () => {
  const item = (await add({ ...form, minimumPence: 200 })).json();
  expect(item).toMatchObject({ mode: 'pwyw', askingPence: 500, minimumPence: 200 });
  expect(item).not.toHaveProperty('suggestionHidden');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const page = await app.inject(`/api/i/${item.code}`);
  expect(page.json().item).toMatchObject({ mode: 'pwyw', askingPence: null, minimumPence: 200 });
  expect((await app.inject('/api/stall')).json().items).toEqual([expect.objectContaining({ askingPence: null, minimumPence: 200 })]);
  expect(page.body).not.toContain('500');
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json().items).toEqual([expect.objectContaining({ askingPence: 500 })]);
  expect((await patch(item.id, { askingPence: 600 })).json()).toMatchObject({ askingPence: 600 });
  expect((await patch(item.id, { askingPence: null })).json()).toMatchObject({ mode: 'pwyw', askingPence: null, minimumPence: 200 });
  expect((await patch(item.id, { notes: 'Clean. Four tins with lids.' })).json()).toMatchObject({ askingPence: null });
  // A fixed or haggle item still needs its price, so an item with no figure cannot become one without it.
  expect((await patch(item.id, { mode: 'fixed' })).json().error).toBe('Set an asking price.');
  expect((await patch(item.id, { mode: 'fixed', askingPence: 900 })).json()).toMatchObject({ mode: 'fixed', askingPence: 900 });
  expect((await app.inject(`/api/i/${item.code}`)).json().item.askingPence).toBe(900);
  expect((await patch(item.id, { askingPence: null })).json().error).toBe('Set an asking price.');
});

it('creates a pay-what-you-want item with no expected amount, and refuses a fixed or haggle item without a price', async () => {
  const saved = await add(bare);
  expect(saved.statusCode).toBe(201);
  expect(saved.json()).toMatchObject({ mode: 'pwyw', askingPence: null, minimumPence: null });
  // As for the minimum, the request schema coerces 0 to null, so a figure of zero means no figure.
  expect((await add({ ...form, askingPence: 0 })).json()).toMatchObject({ mode: 'pwyw', askingPence: null });
  // With no figure to cap it, a minimum stands on its own.
  expect((await add({ ...bare, minimumPence: 300 })).json()).toMatchObject({ askingPence: null, minimumPence: 300 });
  expect((await add({ ...bare, mode: 'fixed' })).json().error).toBe('Set an asking price.');
  expect((await add({ ...bare, mode: 'haggle', floorPence: 100 })).json().error).toBe('Set an asking price.');
  expect((await db.query('select count(*)::integer as count from items')).rows).toEqual([{ count: 3 }]);
});

it('keeps a minimum payable when the owner leaves the expected amount empty', async () => {
  const minimumPence = PAY_WHAT_YOU_WANT_MAX_PENCE + 1;
  expect((await add({ ...bare, minimumPence })).statusCode).toBe(400);
  const item = (await add({ ...bare, minimumPence: PAY_WHAT_YOU_WANT_MAX_PENCE })).json();
  expect(item).toMatchObject({ askingPence: null, minimumPence: PAY_WHAT_YOU_WANT_MAX_PENCE });
  expect((await patch(item.id, { minimumPence })).statusCode).toBe(400);
  expect((await db.query('select minimum_pence from items where id=$1', [item.id])).rows).toEqual([{ minimum_pence: PAY_WHAT_YOU_WANT_MAX_PENCE }]);
});

it('shows no earlier price once a dropped item becomes pay what you want', async () => {
  const item = (await add({ ...form, mode: 'fixed', askingPence: 400 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const { stall_id, id } = (await db.query("select stall_id,id from trading_sessions where status='open'")).rows[0];
  await db.query("insert into events (stall_id,trading_session_id,type,payload,business_key) values ($1,$2,'price_drop',$3,'drop-1')", [stall_id, id, JSON.stringify({ itemId: item.id, name: item.name, code: item.code, seeded: false, oldPence: 900, newPence: 400, reason: 'Quiet' })]);
  expect((await app.inject(`/api/i/${item.code}`)).json()).toMatchObject({ item: { askingPence: 400 }, reducedFromPence: 900 });
  await patch(item.id, { mode: 'pwyw' });
  const page = await app.inject(`/api/i/${item.code}`);
  expect(page.json()).toMatchObject({ item: { askingPence: null }, reducedFromPence: null });
  expect(page.body).not.toContain('900');
  expect(page.body).not.toContain('400');
});

it('judges a buyer amount for an item with no expected amount by the same minimum and maximum, and records the sale with no figure', async () => {
  const item = (await add({ ...bare, minimumPence: 250 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  const low = await pay(item.code, cookies, { amountPence: 249 });
  expect(low.json().error).toBe('The least you can pay for this item is £2.50.');
  expect(created).toHaveLength(0);
  const checkout = await pay(item.code, cookies, { amountPence: 600 });
  expect(checkout.json()).toMatchObject({ state: 'awaiting_approval', totalPence: 600 });
  expect(created[0]!.purchase_units[0]!.amount.value).toBe('6.00');
  expect((await db.query('select asking_pence,amount_pence from checkout_lines where checkout_id=$1', [checkout.json().checkoutId])).rows).toEqual([{ asking_pence: null, amount_pence: 600 }]);
  evidence = completed(checkout.json().checkoutId, '6.00');
  expect((await capture(checkout.json().checkoutId, cookies)).json()).toMatchObject({ state: 'paid', totalPence: 600 });
  const sale = (await app.inject({ url: '/api/owner/feed', cookies: owner })).json().sales[0];
  expect(sale).toMatchObject({ amountPence: 600, price: { source: 'pwyw', askingPence: null } });
  const ledger = (await app.inject({ url: '/api/owner/ledger/data', cookies: owner })).json();
  expect(ledger.ledger).toEqual([expect.objectContaining({ kind: 'Sale', priceSource: "Buyer's amount", asking: null, amount: 6, discount: 0 })]);
  expect(ledger.items).toEqual([expect.objectContaining({ mode: 'Pay what you want', asking: null, minimum: 2.5 })]);
});

it('never publishes a private floor when a haggle item becomes pay what you want', async () => {
  const item = (await add({ ...form, mode: 'haggle', askingPence: 2000, floorPence: 1500 })).json();
  const changed = await patch(item.id, { mode: 'pwyw' });
  expect(changed.json()).toMatchObject({ mode: 'pwyw', minimumPence: null, floorPence: null });
  expect((await db.query('select * from item_floors where item_id=$1', [item.id])).rowCount).toBe(0);
  expect((await app.inject(`/api/i/${item.code}`)).json().item.minimumPence).toBeNull();
  // Sent with the wrong field, a floor stays private rather than becoming a public minimum.
  const sent = await add({ ...form, floorPence: 200 });
  expect(sent.json()).toMatchObject({ minimumPence: null, floorPence: null });
});

it('refuses a checkout when the owner changes the mode after the request read it', async () => {
  const item = (await add()).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  const query = db.query.bind(db) as (sql: string, values?: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(db, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
    const result = await query(sql, values);
    if (sql.startsWith('select id,stall_id,mode from items')) {
      await query("update items set mode='haggle' where id=$1", [item.id]);
      await query('insert into item_floors values ($1,200)', [item.id]);
    }
    return result;
  }) as never);
  const late = await pay(item.code, cookies, { amountPence: 300 });
  spy.mockRestore();
  expect(late.statusCode).toBe(409);
  expect((await db.query('select * from checkouts')).rowCount).toBe(0);
  expect(created).toHaveLength(0);
});

it('judges every amount through validateOffer', () => {
  const item = { status: 'available', mode: 'pwyw', asking_pence: 500, floor_pence: null, minimum_pence: 200 as number | null };
  expect([100, 199, 200, 500, 501, 50_000, 50_001].map(amount => validateOffer(item, amount))).toEqual(['too_low', 'too_low', 'ok', 'ok', 'ok', 'ok', 'above_maximum']);
  expect(validateOffer({ ...item, minimum_pence: null }, 1)).toBe('ok');
  expect(validateOffer({ ...item, minimum_pence: null }, 0)).toBe('too_low');
  expect(validateOffer({ ...item, minimum_pence: null }, 2.5)).toBe('too_low');
  expect(validateOffer({ ...item, status: 'sold' }, 500)).toBe('unavailable');
});

it('reserves the amount the server accepted, charges it, and shows it on the feed and closing report', async () => {
  const item = (await add({ ...form, minimumPence: 200 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  const checkout = await pay(item.code, cookies, { amountPence: 1234 });
  expect(checkout.statusCode).toBe(200);
  expect(checkout.json()).toMatchObject({ state: 'awaiting_approval', totalPence: 1234 });
  expect(created[0]!.purchase_units[0]!.amount.value).toBe('12.34');
  expect((await db.query('select asking_pence, amount_pence from checkout_lines')).rows).toEqual([{ asking_pence: 500, amount_pence: 1234 }]);
  // A second press, even naming another amount, returns the reservation as it was accepted.
  expect((await pay(item.code, cookies, { amountPence: 300 })).json()).toMatchObject({ checkoutId: checkout.json().checkoutId, totalPence: 1234 });
  expect(created).toHaveLength(1);
  evidence = completed(checkout.json().checkoutId, '12.34');
  expect((await capture(checkout.json().checkoutId, cookies)).json()).toMatchObject({ state: 'paid', totalPence: 1234 });
  expect((await app.inject({ url: `/api/i/${item.code}`, cookies })).json().checkout).toMatchObject({ state: 'paid', totalPence: 1234 });
  const feed = (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
  expect(feed).toMatchObject({ recordedSalesPence: 1234, itemsSold: 1 });
  expect(feed.sales).toEqual([expect.objectContaining({ name: 'Seed tins', amountPence: 1234 })]);
  await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies: owner });
  expect((await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing).toMatchObject({ recordedSalesPence: 1234, paidCheckouts: 1, itemsSold: 1 });
});

it('sends a capture for any other amount to review instead of recording a sale', async () => {
  const item = (await add()).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  const checkout = (await pay(item.code, cookies, { amountPence: 800 })).json();
  evidence = completed(checkout.checkoutId, '5.00');
  expect((await capture(checkout.checkoutId, cookies)).json()).toMatchObject({ state: 'checking', reviewRequired: true });
  expect((await db.query('select status from items where id=$1', [item.id])).rows[0].status).toBe('available');
  expect((await db.query('select * from events')).rowCount).toBe(0);
});

it('refuses amounts below the minimum or above the maximum without reserving, states the limit, and accepts the edges', async () => {
  const item = (await add({ ...form, minimumPence: 250 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  const low = await pay(item.code, cookies, { amountPence: 249 });
  expect(low.statusCode).toBe(422);
  expect(low.json().error).toBe('The least you can pay for this item is £2.50.');
  const high = await pay(item.code, cookies, { amountPence: PAY_WHAT_YOU_WANT_MAX_PENCE + 1 });
  expect(high.statusCode).toBe(422); expect(high.json().error).toBe('The most you can pay for this item is £500.');
  expect((await db.query('select * from checkouts')).rowCount).toBe(0);
  expect((await db.query('select reserved_checkout_id from items where id=$1', [item.id])).rows[0].reserved_checkout_id).toBeNull();
  expect((await pay(item.code, cookies, { amountPence: 250 })).json().totalPence).toBe(250);
  await app.inject({ method: 'POST', url: `/api/checkouts/${(await db.query('select id from checkouts')).rows[0].id}/cancel`, cookies, payload: {} });
  expect((await pay(item.code, cookies, { amountPence: PAY_WHAT_YOU_WANT_MAX_PENCE })).json().totalPence).toBe(PAY_WHAT_YOU_WANT_MAX_PENCE);
});

it('takes any penny from an item with no minimum, and rejects malformed or missing amounts', async () => {
  const item = (await add()).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  for (const amountPence of [1.5, '300', null]) expect((await pay(item.code, cookies, { amountPence })).statusCode).toBe(400);
  for (const amountPence of [0, -5]) {
    const refused = await pay(item.code, cookies, { amountPence });
    expect(refused.statusCode).toBe(422); expect(refused.json().error).toBe('The least you can pay for this item is £0.01.');
  }
  expect((await pay(item.code, cookies)).json().error).toBe('Enter the amount you want to pay.');
  expect((await pay(item.code, cookies, { amountPence: 300, agreedPriceId: 'f4ad9a0e-0b6e-4a0b-9d2d-0e0f0a0b0c0d' })).statusCode).toBe(409);
  expect((await db.query('select * from checkouts')).rowCount).toBe(0);
  expect((await pay(item.code, cookies, { amountPence: 1 })).json().totalPence).toBe(1);
});

it('refuses an amount on fixed and haggle items', async () => {
  const fixed = (await add({ ...form, mode: 'fixed', askingPence: 1000 })).json();
  const haggle = (await add({ ...form, mode: 'haggle', askingPence: 2000, floorPence: 1500 })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  for (const item of [fixed, haggle]) {
    const cookies = await buyer(item.code);
    expect((await pay(item.code, cookies, { amountPence: 100 })).statusCode).toBe(400);
    expect((await pay(item.code, cookies, { amountPence: 100 })).json().error).toBe('Checkout takes no amount.');
  }
  expect((await db.query('select * from checkouts')).rowCount).toBe(0);
});

it('gives pay-what-you-want items no chat and no offers', async () => {
  const item = (await add()).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = await buyer(item.code);
  expect((await app.inject({ method: 'POST', url: `/api/i/${item.code}/chat`, cookies, payload: { offerPence: 300 } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: `/api/i/${item.code}/chat`, cookies, payload: { message: 'Does it work?' } })).statusCode).toBe(409);
  expect((await db.query('select * from offers')).rowCount).toBe(0);
});
