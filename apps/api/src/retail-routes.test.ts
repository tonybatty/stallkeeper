import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { testDatabase } from '../test/database.js';
import fixture from '../test/fixtures/channel3-search.json' with { type: 'json' };
import { buildApp } from './app.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173', channel3ApiKey: 'c3-secret-key' };
const offer = (price: number, over: object = {}) => ({ url: 'https://buy.trychannel3.com/X', domain: 'shop.example.co.uk', price: { price, currency: 'GBP' }, availability: 'InStock', condition: 'new', ...over });
const answer = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] });
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let now: Date;
let channel3: (url: URL, init?: RequestInit) => Response | Promise<Response>;
let reply: string;
let model: MockLanguageModelV4;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const urls = () => fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname);
const lookup = (query = 'round wall mirror', cookies = owner) => app.inject({ method: 'POST', url: '/api/owner/retail/lookup', cookies, payload: { query } });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
const imageLookup = (payload: Buffer = jpeg, cookies = owner) => app.inject({ method: 'POST', url: '/api/owner/retail/image-lookup', cookies, headers: { 'content-type': 'image/jpeg' }, payload });
const input = { name: 'Round mirror', notes: 'Good used condition. 40 cm across.', mode: 'haggle', askingPence: 2800, floorPence: 1800 };
const add = (extra: object = {}) => app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { ...input, ...extra } });
const edit = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/owner/items/${id}`, cookies: owner, payload });
const product = (price: number, id = 'P1') => Response.json({ id, title: 'Mirror', offers: [offer(price)] });
function start(key: string | null = config.channel3ApiKey) {
  fetcher = vi.fn<typeof fetch>(async (input, init) => channel3(new URL(String(input)), init));
  model = new MockLanguageModelV4({ doGenerate: async () => answer(reply) });
  app = buildApp({ ...config, channel3ApiKey: key ?? undefined }, { db, model, fetcher, now: () => now });
}
beforeEach(async () => {
  await db.query('truncate items,buyer_sessions,trading_sessions,ai_usage cascade');
  now = new Date('2026-11-06T10:00:00Z'); reply = 'Read the offer card.';
  channel3 = url => url.pathname === '/v1/search' ? Response.json(fixture) : product(64);
  start();
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
});
afterEach(async () => { await app.close(); });

it('looks up comparable offers for a logged-in owner only', async () => {
  expect((await lookup('round wall mirror', {})).statusCode).toBe(401);
  const result = await lookup();
  expect(result.statusCode).toBe(200);
  expect(result.json().candidates[0]).toMatchObject({ productId: 'YvSMNI6', reference: { pricePence: 15000, condition: 'new' }, suggestion: { askingPence: 7500 } });
  expect((await app.inject({ method: 'POST', url: '/api/owner/retail/lookup', cookies: owner, payload: { query: ' ' } })).statusCode).toBe(400);
});

it('sends an owner photo to Channel3 image search and returns the same price evidence shape', async () => {
  channel3 = () => Response.json({ products: [{ id: 'PHOTO1', title: 'Brass desk lamp', offers: [offer(39), offer(22, { condition: 'used', url: 'https://buy.trychannel3.com/used' })] }], next_page_token: null });
  expect((await imageLookup(jpeg, {})).statusCode).toBe(401);
  const result = await imageLookup();
  expect(result.statusCode).toBe(200);
  expect(result.json().candidates[0]).toMatchObject({
    productId: 'PHOTO1', reference: { pricePence: 3900, condition: 'new' }, suggestion: { askingPence: 1950 }, missingWords: [],
    offers: [{ pricePence: 2200, condition: 'used' }, { pricePence: 3900, condition: 'new' }],
  });
  const request = fetcher.mock.calls.find(([input]) => new URL(String(input)).pathname === '/v1/image-search')!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({ base64_image: jpeg.toString('base64'), limit: 10, config: { country: 'GB', language: 'en', currency: 'GBP' } });
  expect(new Headers(request[1]?.headers).get('x-api-key')).toBe('c3-secret-key');
  expect(result.body).not.toContain('c3-secret-key');
});

it('rejects a non-JPEG image without calling Channel3', async () => {
  const failed = await imageLookup(Buffer.from('not a jpeg'));
  expect(failed.statusCode).toBe(400);
  expect(failed.json()).toEqual({ error: 'Choose a JPEG photo.' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps manual item creation working when image search fails', async () => {
  channel3 = () => new Response('invalid key c3-secret-key', { status: 401 });
  const failed = await imageLookup();
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('c3-secret-key');
  expect((await add()).statusCode).toBe(201);
});

it('returns listing details with the candidates from the one search call, and makes no other Channel3 call', async () => {
  const result = await lookup();
  expect(urls()).toEqual(['/v1/search']);
  expect(result.json().candidates[0].reference.description).toMatch(/^The Laura Ashley Overton Round Wall Mirror is an elegant home accessory/);
  expect(result.json().candidates[0].reference.facts).toEqual(['Brand: Laura Ashley', 'Materials: Glass, MDF', 'Ornate French Baroque style', 'Highly decorative carved-effect pediment', 'Slender circular frame with raised studs', 'Luxurious painted finish', 'Fitted with hanging keyhole plates', '2 year guarantee included']);
});

it('answers 503 and never echoes the key when Channel3 fails, so manual pricing stays open', async () => {
  channel3 = () => new Response('invalid key c3-secret-key', { status: 401 });
  const failed = await lookup();
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain('c3-secret-key');
  expect((await add()).statusCode).toBe(201);
  await app.close(); start(null);
  expect((await lookup()).statusCode).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});

it('limits lookups per stall', async () => {
  for (let i = 0; i < 30; i++) expect((await lookup()).statusCode).toBe(200);
  expect((await lookup()).statusCode).toBe(429);
});

it('counts a product lookup on save against the same allowance, and still saves the item once it is spent', async () => {
  const id = (await add()).json().id;
  for (let i = 0; i < 30; i++) expect((await edit(id, { retailProductId: 'P1' })).json().retailLookupFailed).toBe(false);
  expect((await lookup()).statusCode).toBe(429);
  const before = urls().length;
  channel3 = () => product(99);
  const edited = await edit(id, { retailProductId: 'P1', notes: 'Still saved' });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toMatchObject({ notes: 'Still saved', retailLookupFailed: true, retailReference: { pricePence: 6400 } });
  const created = await add({ retailProductId: 'P1' });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ retailReference: null, retailLookupFailed: true });
  expect(urls()).toHaveLength(before);
});

it('spends no lookup on an item that does not exist', async () => {
  const before = urls().length;
  expect((await edit('00000000-0000-4000-8000-000000000000', { retailProductId: 'P1' })).statusCode).toBe(404);
  expect(urls()).toHaveLength(before);
  for (let i = 0; i < 30; i++) expect((await lookup()).statusCode).toBe(200);
});

it('stores the price Channel3 returns for a product ID and ignores anything else the client sends', async () => {
  const created = (await add({ retailProductId: 'P1', retailReference: { pricePence: 1 }, retail_ref: { pricePence: 1 } })).json();
  expect(created.retailReference).toMatchObject({ productId: 'P1', pricePence: 6400, retailer: 'shop.example.co.uk', checkedAt: now.toISOString() });
  expect(created.retailLookupFailed).toBe(false);
  expect(urls()).toEqual(['/v1/products/P1']);
  const stored = (await db.query('select retail_ref from items where id=$1', [created.id])).rows[0].retail_ref;
  expect(stored.pricePence).toBe(6400);
  expect((await add({ retailProductId: "x'; drop table items;--" })).statusCode).toBe(400);
});

it('saves the item without a reference when the product cannot be read back', async () => {
  channel3 = () => new Response('down', { status: 503 });
  const created = await add({ retailProductId: 'P1' });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ retailReference: null, retailLookupFailed: true });
  channel3 = () => Response.json({ id: 'P1', title: 'Mirror', offers: [offer(64, { condition: 'used' })] });
  expect((await add({ retailProductId: 'P1' })).json()).toMatchObject({ retailReference: null, retailLookupFailed: true });
});

it('saves the item and reports the lookup as failed when Channel3 cannot find the product', async () => {
  channel3 = () => Response.json({ detail: 'Not found' }, { status: 404 });
  const created = await add({ retailProductId: 'P1' });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ retailReference: null, retailLookupFailed: true });
});

it('keeps a saved reference through a failed re-lookup, clears it on null, and never bumps the price version', async () => {
  const id = (await add({ retailProductId: 'P1' })).json().id;
  channel3 = () => product(70);
  const changed = (await edit(id, { retailProductId: 'P1' })).json();
  expect(changed).toMatchObject({ priceVersion: 1, retailReference: { pricePence: 7000 } });
  channel3 = () => new Response('down', { status: 500 });
  expect((await edit(id, { retailProductId: 'P1' })).json()).toMatchObject({ retailLookupFailed: true, retailReference: { pricePence: 7000 } });
  expect((await edit(id, { notes: 'New notes' })).json().retailReference.pricePence).toBe(7000);
  const cleared = (await edit(id, { retailProductId: null })).json();
  expect(cleared).toMatchObject({ retailReference: null, priceVersion: 1 });
  expect((await db.query('select retail_ref from items where id=$1', [id])).rows[0].retail_ref).toBeNull();
});

it('shows a buyer the snapshot with its date, and refreshes it first once it is old', async () => {
  const created = (await add({ retailProductId: 'P1' })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const before = urls().length;
  const first = (await app.inject(`/api/i/${created.code}`)).json();
  expect(first.retailReference).toEqual({ pricePence: 6400, retailer: 'shop.example.co.uk', url: 'https://buy.trychannel3.com/X', checkedAt: now.toISOString() });
  expect(urls()).toHaveLength(before);
  channel3 = () => product(72);
  now = new Date('2026-11-06T17:00:00Z');
  expect((await app.inject(`/api/i/${created.code}`)).json().retailReference).toMatchObject({ pricePence: 7200, checkedAt: now.toISOString() });
  expect(JSON.stringify(first)).not.toMatch(/floor|1800/);
});

it('never lets Channel3 break the item page', async () => {
  const created = (await add({ retailProductId: 'P1' })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  channel3 = () => { throw new Error('socket hang up'); };
  now = new Date('2026-11-07T10:00:00Z');
  const page = await app.inject(`/api/i/${created.code}`);
  expect(page.statusCode).toBe(200);
  expect(page.json().retailReference).toMatchObject({ pricePence: 6400 });
  now = new Date('2026-11-20T10:00:00Z');
  const old = await app.inject(`/api/i/${created.code}`);
  expect(old.statusCode).toBe(200);
  expect(old.json().retailReference).toBeNull();
});

it('carries no reference for an item without one', async () => {
  const created = (await add()).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  expect((await app.inject(`/api/i/${created.code}`)).json().retailReference).toBeNull();
  expect(urls()).toEqual([]);
});

async function chatAbout(message: string) {
  const created = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${created.code}`)).cookies[0]!.value };
  return (await app.inject({ method: 'POST', url: `/api/i/${created.code}/chat`, cookies, payload: { message } })).json();
}

it('gives the model the retail reference as wording, with no link and no title, and lets its figure through the amount check', async () => {
  reply = 'It is £28 here. A new one is £64 at shop.example.co.uk.';
  const result = await chatAbout('Is that a good price?');
  expect(result.reply).toBe(reply);
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  expect(prompt).toContain("New from GBP 64.00 at shop.example.co.uk (a retailer's listed price for a new one");
  expect(prompt).not.toMatch(/buy\.trychannel3|https:\/\/|Mirror"/);
  expect(prompt).not.toMatch(/floor|1800|18\.00/);
});

const listed = (over: object = {}) => Response.json({ id: 'P1', title: 'Mirror', offers: [offer(64)], brands: [{ name: 'Laura Ashley' }], materials: ['Glass'], key_features: ['Hanging keyhole plates'],
  description: 'A round wall mirror with a silver frame. Was £99, now on sale. Not suitable for bathrooms.', ...over });
async function chatOn(code: string, message: string) {
  const cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
  return (await app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies, payload: { message } })).json();
}
const listingIn = (call = 0) => {
  const system = model.doGenerateCalls[call]!.prompt.find(message => message.role === 'system')!.content as string;
  return JSON.parse(system.slice(system.indexOf('Stallholder facts: ') + 'Stallholder facts: '.length)) as { notes: string; retailReference: string; retailListingForNewOne?: { description: string; facts: string[] } };
};

// The owner picks the match, and its listing goes with the item to the AI stallholder as the retailer's words, never as the owner's notes.
it('gives the model the chosen listing as the retailer\'s details for a new one, apart from the notes, and never to a buyer page', async () => {
  channel3 = url => url.pathname === '/v1/search' ? Response.json(fixture) : listed();
  const created = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  expect(created.retailReference).toMatchObject({ description: 'A round wall mirror with a silver frame. Was £99, now on sale. Not suitable for bathrooms.', facts: ['Brand: Laura Ashley', 'Materials: Glass', 'Hanging keyhole plates'] });
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const page = await app.inject(`/api/i/${created.code}`);
  expect(page.body).not.toMatch(/Laura Ashley|silver frame|keyhole/);
  await chatOn(created.code, 'What is it made of?');
  const facts = listingIn();
  expect(facts.notes).toBe(input.notes);
  expect(facts.retailListingForNewOne).toEqual({ description: 'A round wall mirror with a silver frame. Was £99, now on sale. Not suitable for bathrooms.', facts: ['Brand: Laura Ashley', 'Materials: Glass', 'Hanging keyhole plates'] });
  const system = model.doGenerateCalls[0]!.prompt.find(message => message.role === 'system')!.content as string;
  expect(system).toContain('"The retailer\'s listing for a new one says"');
  expect(system).toContain('never as the condition of this item');
  expect(system).toContain('Where the notes and the listing disagree, the notes win.');
});

it('gives the model no listing for an item without a match, or once the owner removes it', async () => {
  channel3 = url => url.pathname === '/v1/search' ? Response.json(fixture) : listed();
  const plain = (await add()).json();
  const matched = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  expect((await edit(matched.id, { retailProductId: null })).json().retailReference).toBeNull();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await chatOn(plain.code, 'What is it made of?');
  await chatOn(matched.code, 'What is it made of?');
  expect(listingIn(0)).not.toHaveProperty('retailListingForNewOne');
  expect(listingIn(1)).not.toHaveProperty('retailListingForNewOne');
  expect(JSON.stringify(model.doGenerateCalls.map(call => call.prompt))).not.toMatch(/Laura Ashley|keyhole/);
});

it('keeps the listing details through the refresh of an old snapshot', async () => {
  channel3 = url => url.pathname === '/v1/search' ? Response.json(fixture) : listed();
  const created = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  now = new Date('2026-11-06T10:11:00Z');
  channel3 = () => listed({ key_features: ['Hanging keyhole plates', 'Bevelled edge'] });
  await chatOn(created.code, 'What is it made of?');
  expect(urls().filter(url => url === '/v1/products/P1')).toHaveLength(2);
  expect(listingIn().retailListingForNewOne?.facts).toEqual(['Brand: Laura Ashley', 'Materials: Glass', 'Hanging keyhole plates', 'Bevelled edge']);
});

it('sends no listing details once the price line is withheld because the product is gone', async () => {
  channel3 = url => url.pathname === '/v1/search' ? Response.json(fixture) : listed();
  const created = (await add({ retailProductId: 'P1' })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  now = new Date('2026-11-06T10:11:00Z');
  channel3 = () => new Response('gone', { status: 404 });
  await chatOn(created.code, 'What is it made of?');
  expect(listingIn().retailReference).toBe('No retail reference provided');
  expect(listingIn()).not.toHaveProperty('retailListingForNewOne');
});

// Nobody recorded whether a match saved before the doubtful flag was doubtful, so it gets no details until the owner picks it again.
it('keeps the price line and adds no listing details to a reference stored without the doubtful flag, through a refresh too', async () => {
  channel3 = () => listed();
  const created = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  await db.query("update items set retail_ref=retail_ref - 'doubtful' - 'description' - 'facts' where id=$1", [created.id]);
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await chatOn(created.code, 'What is it made of?');
  now = new Date('2026-11-06T10:11:00Z');
  await chatOn(created.code, 'Who makes it?');
  expect(urls().filter(url => url === '/v1/products/P1')).toHaveLength(2);
  for (const call of [0, 1]) {
    expect(listingIn(call).retailReference).toContain('New from GBP 64.00');
    expect(listingIn(call)).not.toHaveProperty('retailListingForNewOne');
  }
  const stored = (await db.query('select retail_ref from items where id=$1', [created.id])).rows[0].retail_ref;
  expect(stored).toMatchObject({ checkedAt: '2026-11-06T10:11:00.000Z', description: '', facts: [] });
  expect((await edit(created.id, { retailProductId: 'P1', retailDoubtful: false })).json().retailReference).toMatchObject({ doubtful: false, facts: ['Brand: Laura Ashley', 'Materials: Glass', 'Hanging keyhole plates'] });
});

it('keeps an owner re-save that lands while a buyer refresh is still waiting on Channel3', async () => {
  channel3 = () => listed();
  const created = (await add({ retailProductId: 'P1', retailDoubtful: false })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  now = new Date('2026-11-06T10:11:00Z');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  channel3 = async () => { if (calls++ === 0) await held; return listed(); };
  const page = app.inject(`/api/i/${created.code}`).then(response => response);
  await vi.waitFor(() => expect(calls).toBe(1));
  expect((await edit(created.id, { retailProductId: 'P1', retailDoubtful: true })).json().retailReference).toMatchObject({ doubtful: true, facts: [] });
  release();
  expect((await page).statusCode).toBe(200);
  expect(calls).toBe(2);
  const stored = (await db.query('select retail_ref from items where id=$1', [created.id])).rows[0].retail_ref;
  expect(stored).toMatchObject({ doubtful: true, description: '', facts: [] });
});

// A doubtful match may be a different kind of item, so it keeps its "New from" line and gives the AI stallholder nothing to quote.
it('stores and sends no listing details for a match the lookup flagged as doubtful, through a refresh too', async () => {
  const flagged = (await lookup('round wall teapot')).json().candidates[0];
  expect(flagged).toMatchObject({ missingWords: ['teapot'], suggestion: null, reference: { pricePence: 15000, description: '', facts: [], doubtful: true } });
  channel3 = () => listed();
  const created = (await add({ retailProductId: 'P1', retailDoubtful: true })).json();
  expect(created.retailReference).toMatchObject({ pricePence: 6400, description: '', facts: [], doubtful: true });
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await chatOn(created.code, 'What is it made of?');
  now = new Date('2026-11-06T10:11:00Z');
  await chatOn(created.code, 'Who makes it?');
  expect(urls().filter(url => url === '/v1/products/P1')).toHaveLength(2);
  for (const call of [0, 1]) {
    expect(listingIn(call).retailReference).toContain('New from GBP 64.00');
    expect(listingIn(call)).not.toHaveProperty('retailListingForNewOne');
  }
  expect(JSON.stringify(model.doGenerateCalls.map(call => call.prompt))).not.toMatch(/Laura Ashley|silver frame|keyhole/);
  expect((await edit(created.id, { retailProductId: 'P1', retailDoubtful: false })).json().retailReference).toMatchObject({ doubtful: false, facts: ['Brand: Laura Ashley', 'Materials: Glass', 'Hanging keyhole plates'] });
});

// A form loaded before the doubtful flag existed, or a direct API call, sends the product ID alone. It cannot vouch for the match, so it gets the price line only.
it('treats a save that names a product without saying whether the match is doubtful as doubtful', async () => {
  channel3 = () => listed();
  const created = (await add({ retailProductId: 'P1' })).json();
  expect(created.retailReference).toMatchObject({ pricePence: 6400, description: '', facts: [], doubtful: true });
  const edited = (await edit(created.id, { retailProductId: 'P1' })).json();
  expect(edited.retailReference).toMatchObject({ pricePence: 6400, description: '', facts: [], doubtful: true });
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await chatOn(created.code, 'What is it made of?');
  expect(listingIn().retailReference).toContain('New from GBP 64.00');
  expect(listingIn()).not.toHaveProperty('retailListingForNewOne');
});

it('lets a reply repeat the listing\'s own wording when it attributes it to the retailer', async () => {
  channel3 = () => listed({ key_features: ['Tool-free assembly'] });
  reply = "The retailer's listing for a new one says it has tool-free assembly. The stallholder's notes don't say if the fixings are included.";
  expect((await chatAbout('Is it hard to put up?')).reply).toBe(reply);
});

it('lets a reply use a word from the retail reference, such as the retailer name', async () => {
  channel3 = () => Response.json({ id: 'P1', title: 'Mirror', offers: [offer(64, { domain: 'tools.example.co.uk' })] });
  reply = 'A new one is £64 at tools.example.co.uk.';
  expect((await chatAbout('Is that a good price?')).reply).toBe(reply);
});

it('still replaces an amount that is neither the reference nor anything else allowed', async () => {
  reply = 'A new one is £84 at shop.example.co.uk.';
  const result = await chatAbout('Is that a good price?');
  expect(result.reply).not.toContain('£84');
  expect(result.reply).toContain('£28');
});

it('tells the model there is no reference when the snapshot is gone', async () => {
  channel3 = () => new Response('down', { status: 500 });
  const created = (await add({ retailProductId: 'P1' })).json();
  expect(created.retailLookupFailed).toBe(true);
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${created.code}`)).cookies[0]!.value };
  await app.inject({ method: 'POST', url: `/api/i/${created.code}/chat`, cookies, payload: { message: 'Hello' } });
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('No retail reference provided');
});

// The demo stall carries a saved reference on two seeded items, looked up after each reset.
describe('demo stall references', () => {
  const resetDemo = async () => {
    await db.query('update stalls set demo_reset_at=null');
    const demo = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
    return app.inject({ method: 'POST', url: '/api/owner/demo/reset', cookies: demo });
  };
  const references = async () => (await db.query<{ name: string; retail_ref: { productId: string; pricePence: number; doubtful: boolean; facts: string[] } | null }>("select name,retail_ref from items where seeded and status='available' and retail_ref is not null order by name")).rows;

  it('saves a reference on two seeded items and shows it on their buyer pages with the check date', async () => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(35)], key_features: ['Hand finished'] });
    expect((await resetDemo()).statusCode).toBe(200);
    const saved = await references();
    expect(saved.map(item => item.name)).toEqual(['Round wall mirror', 'Wooden stool']);
    expect(saved.map(item => item.retail_ref!.productId)).toEqual(['w33nMA4', 'CGSjnDZ']);
    // The seeded matches were picked by hand, so the seed vouches for them and their listing details reach the AI stallholder.
    expect(saved.map(item => item.retail_ref!.doubtful)).toEqual([false, false]);
    expect(saved.map(item => item.retail_ref!.facts)).toEqual([['Hand finished'], ['Hand finished']]);
    expect(urls().sort()).toEqual(['/v1/products/CGSjnDZ', '/v1/products/w33nMA4']);
    const code = (await db.query<{ code: string }>("select code from items where name='Round wall mirror' and status='available'")).rows[0]!.code;
    expect((await app.inject(`/api/i/${code}`)).json().retailReference).toMatchObject({ pricePence: 3500, retailer: 'shop.example.co.uk', checkedAt: now.toISOString() });
  });

  it('still resets when Channel3 is unreachable, and the items carry no reference', async () => {
    channel3 = () => new Response('down', { status: 500 });
    expect((await resetDemo()).statusCode).toBe(200);
    expect(await references()).toEqual([]);
    expect((await db.query("select count(*)::int as count from items where seeded and status='available'")).rows[0]!.count).toBe(14);
  });

  it('leaves out a product that no longer has a new GBP offer', async () => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: url.pathname.endsWith('CGSjnDZ') ? [offer(35, { condition: 'used' })] : [offer(35)] });
    expect((await resetDemo()).statusCode).toBe(200);
    expect((await references()).map(item => item.name)).toEqual(['Round wall mirror']);
  });

  const sell = (code: string) => db.query("update items set status='sold',sold_at=now() where code=$1", [code]);
  const codeOf = async (name: string) => (await db.query<{ code: string }>("select code from items where name=$1 and status<>'removed'", [name])).rows[0]!.code;

  it('keeps the saved reference and its date on a sold item, with no Channel3 request', async () => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(35)] });
    await resetDemo();
    const code = await codeOf('Round wall mirror');
    await sell(code);
    now = new Date('2026-11-08T10:00:00Z');
    const before = urls().length;
    const page = (await app.inject(`/api/i/${code}`)).json();
    expect(page).toMatchObject({ availability: 'sold', retailReference: { pricePence: 3500, retailer: 'shop.example.co.uk', url: 'https://buy.trychannel3.com/X', checkedAt: '2026-11-06T10:00:00.000Z' } });
    expect(urls()).toHaveLength(before);
    expect(JSON.stringify(page)).not.toMatch(/floor|1200/);
  });

  it('still refreshes an available item, and shows no reference on a removed one', async () => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(35)] });
    await resetDemo();
    const code = await codeOf('Round wall mirror');
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(40)] });
    now = new Date('2026-11-06T18:00:00Z');
    expect((await app.inject(`/api/i/${code}`)).json().retailReference).toMatchObject({ pricePence: 4000 });
    await db.query("update items set status='removed',removed_at=now() where code=$1", [code]);
    expect((await app.inject(`/api/i/${code}`)).json().retailReference).toBeNull();
  });

  const demoStall = async () => (await db.query<{ id: string }>('select id from stalls where is_demo=true')).rows[0]!.id;
  const reserve = async (code: string) => {
    const stallId = await demoStall();
    const session = (await db.query("select id from trading_sessions where stall_id=$1 and status='open'", [stallId])).rows[0];
    const buyer = (await db.query('insert into buyer_sessions(token_hash) values ($1) returning id', [randomUUID()])).rows[0];
    const id = (await db.query(`insert into checkouts(stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline)
      values ($1,$2,$3,'creating',1000,$4,$5,$6,$7) returning id`, [stallId, session.id, buyer.id, randomUUID(), randomUUID(), randomUUID(), new Date(now.getTime() + 300_000)])).rows[0].id;
    await db.query('update items set reserved_checkout_id=$1 where code=$2', [id, code]);
  };
  const closeStall = async () => db.query("update trading_sessions set status='closed',closed_at=now() where stall_id=$1 and status<>'closed'", [await demoStall()]);

  it.each([
    ['reserved', (code: string) => reserve(code)],
    ['closed', () => closeStall()],
  ])('keeps the saved reference on an unsold %s item on its page, with no Channel3 request', async (state, change) => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(35)] });
    await resetDemo();
    const code = await codeOf('Round wall mirror');
    now = new Date('2026-11-06T18:00:00Z');
    await change(code);
    const before = urls().length;
    const page = (await app.inject(`/api/i/${code}`)).json();
    expect(page).toMatchObject({ availability: state, retailReference: { pricePence: 3500, retailer: 'shop.example.co.uk', checkedAt: '2026-11-06T10:00:00.000Z' } });
    expect(urls()).toHaveLength(before);
    expect(JSON.stringify(page)).not.toMatch(/floor/i);
  });

  it('keeps a reference item on the shelf after the first two Start here sales', async () => {
    channel3 = url => Response.json({ id: url.pathname.split('/').pop(), title: 'Seeded match', offers: [offer(35)] });
    await resetDemo();
    const haggle = async () => (await app.inject('/api/demo')).json().items.filter((item: { mode: string; availability: string }) => item.mode === 'haggle' && item.availability === 'available') as Array<{ code: string; name: string }>;
    for (let sale = 0; sale < 2; sale++) {
      const [first] = await haggle();
      const ref = (await db.query('select retail_ref from items where code=$1', [first!.code])).rows[0].retail_ref;
      expect(ref).toBeNull();
      await sell(first!.code);
    }
    const left = await haggle();
    const withRef = (await db.query("select count(*)::int as count from items where code = any($1) and retail_ref is not null", [left.map(item => item.code)])).rows[0].count;
    expect(withRef).toBeGreaterThan(0);
  });

  it('looks nothing up when no Channel3 key is set', async () => {
    await app.close(); start(null);
    expect((await resetDemo()).statusCode).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await references()).toEqual([]);
  });
});
