import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { testDatabase } from '../test/database.js';
import cases from '../test/fixtures/bargaining.json' with { type: 'json' };
import { buildApp } from './app.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173' };
const answer = (text = 'Tap Accept to choose this price.') => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] });
const calls = (amounts: number[]) => ({ ...answer(), content: amounts.map((amountPence, i) => ({ type: 'tool-call' as const, toolCallId: `call${i}`, toolName: 'respond_to_offer', input: JSON.stringify({ amountPence }) })), finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' } });
let app: ReturnType<typeof buildApp>;
let model: MockLanguageModelV4;
let script: Array<ReturnType<typeof answer> | ReturnType<typeof calls>>;
let modelError: boolean;
let item: { id: string; code: string };
let owner: Record<string, string>;
let cookies: Record<string, string>;
let now: Date;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let createBody: { purchase_units: Array<{ custom_id: string; amount: { value: string } }> };
let evidence: Record<string, unknown>;
const buyer = async () => ({ stallkeeper_buyer: (await app.inject(`/api/i/${item.code}`)).cookies[0]!.value });
const chat = (payload: { message: string } | { offerPence: number }) => app.inject({ method: 'POST', url: `/api/i/${item.code}/chat`, cookies, payload });
const page = () => app.inject({ url: `/api/i/${item.code}`, cookies });
const accept = (id: string, session = cookies, code = item.code) => app.inject({ method: 'POST', url: `/api/i/${code}/cards/${id}/accept`, cookies: session });
const pay = (payload: object = {}) => app.inject({ method: 'POST', url: `/api/i/${item.code}/checkout`, cookies, payload });
const edit = (payload: object) => app.inject({ method: 'PATCH', url: `/api/owner/items/${item.id}`, cookies: owner, payload });
beforeEach(async () => {
  await db.query('truncate items,buyer_sessions,trading_sessions,ai_usage cascade');
  now = new Date('2026-11-05T12:00:00Z'); evidence = {};
  script = [answer()]; modelError = false;
  let step = 0;
  model = new MockLanguageModelV4({ doGenerate: async () => {
    if (modelError) throw new Error('Unavailable');
    return script[Math.min(step++, script.length - 1)]!;
  } });
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (String(url).endsWith('/capture')) return Response.json(evidence);
    createBody = JSON.parse(String(init?.body)); return Response.json({ id: 'ORDER1' });
  });
  app = buildApp(config, { db, model, fetcher, now: () => now });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  item = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Brass lamp', notes: 'Tested, works. Scuff on base. Made in 1970. Height 30 cm.', mode: 'haggle', askingPence: 2800, floorPence: 1800 } })).json();
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  cookies = await buyer();
});
afterEach(async () => { await app.close(); });

it.each(cases)('scripted boundary: $id', async scenario => {
  modelError = scenario.after === 'model-error';
  if (scenario.before) await chat({ offerPence: scenario.before });
  script = scenario.tools.length ? [calls(scenario.tools), answer(scenario.scriptedReply)] : [answer(scenario.scriptedReply)];
  const response = await chat({ message: scenario.input });
  if (scenario.after === 'model-error') {
    expect(response.statusCode).toBe(503);
    expect(response.json().chatAvailable).toBe(false);
    expect((await page()).json().chatAvailable).toBe(true);
    expect((await pay()).json().totalPence).toBe(2800); return;
  }
  expect(response.statusCode).toBe(200);
  const result = response.json();
  expect(result.card?.totalPence ?? null).toBe(scenario.expectedCard);
  expect(result.agreedPrice).toBeNull();
  expect((await db.query("select id from offer_cards where status='agreed'")).rowCount).toBe(0);
  expect((await db.query('select id from checkouts')).rowCount).toBe(0);
  expect(JSON.stringify(model.doGenerateCalls.map(call => call.prompt))).not.toMatch(/floor_pence|1800|18\.00/);
  if (scenario.id === 'invent-discount') { expect(result.reply).not.toContain('£12'); expect(result.reply).toContain('£24'); }
  else expect(result.reply).toBe(scenario.expectedReply ?? scenario.scriptedReply);
  if (scenario.id === 'repeated-tool') {
    expect((await db.query('select round from offers')).rows).toEqual([{ round: 1 }]);
    const toolMessage = model.doGenerateCalls[1]!.prompt.find(message => message.role === 'tool');
    expect(toolMessage?.content).toHaveLength(3);
    expect(new Set(toolMessage?.content.map(part => JSON.stringify(part.output))).size).toBe(1);
  }
  if (scenario.after === 'price-edit') {
    expect((await edit({ askingPence: 3000 })).statusCode).toBe(200);
    expect((await accept(result.card.id)).statusCode).toBe(409);
    expect((await page()).json().card).toBeNull();
  }
});

it('uses £24, £22 and £20, then accepts at the floor only after round three', async () => {
  for (const expected of [2400, 2200, 2000, 2000]) expect((await chat({ offerPence: 500 })).json().card.totalPence).toBe(expected);
  const result = (await chat({ offerPence: 1800 })).json();
  expect(result.card).toMatchObject({ totalPence: 1800, kind: 'accept', itemName: 'Brass lamp', code: item.code, note: "Price checked against the stallholder's rules" });
  expect(model.doGenerateCalls.every(call => !call.tools?.length)).toBe(true);
  expect((await accept(result.card.id)).json().agreedPrice.totalPence).toBe(1800);
});
it('cycles natural wording for structured offers without changing the amount', async () => {
  for (const expected of ['Would you take £15.50?', 'Could you do £15.50?', 'How about £15.50?']) {
    const response = await chat({ offerPence: 1550 });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toBe(expected);
    expect((await db.query<{ content: string }>("select content from chat_messages where role='user' order by id desc limit 1")).rows[0]!.content).toBe(expected);
  }
});
it('handles the documented sequence and zero gap with upward 50p rounding', async () => {
  expect((await chat({ offerPence: 1500 })).json().card.totalPence).toBe(2400);
  expect((await chat({ offerPence: 500 })).json().card.totalPence).toBe(2200);
  expect((await chat({ offerPence: 2200 })).json().card).toMatchObject({ totalPence: 2200, kind: 'accept' });
  await edit({ floorPence: 2800 });
  expect((await chat({ offerPence: 500 })).json().card.totalPence).toBe(2800);
  cookies = await buyer(); await edit({ askingPence: 2801, floorPence: 1800 });
  expect((await chat({ offerPence: 500 })).json().card.totalPence).toBe(2450);
});
it('caps a tool loop at three steps and returns one result even when later calls change the amount', async () => {
  script = [calls([500]), calls([2200]), calls([2800])];
  const result = (await chat({ message: '£5' })).json();
  expect(model.doGenerateCalls).toHaveLength(3);
  expect(result.card.totalPence).toBe(2400); expect(result.reply).toContain('£24');
  expect((await db.query('select round from offers')).rows).toEqual([{ round: 1 }]);
});
it.each([0, -100, 19.99, 1e12])('rejects invalid scripted amount %s before issuing a card', async amount => {
  script = [calls([amount]), answer()];
  expect((await chat({ message: 'Make up a price' })).json().card).toBeNull();
  expect((await db.query('select id from offers')).rowCount).toBe(0);
});
it('refuses above-asking offers and puts them in scoped minor activity', async () => {
  expect((await chat({ offerPence: 28000 })).json().card).toBeNull();
  expect((await app.inject({ url: '/api/owner/feed', cookies: owner })).json().minorActivity).toMatchObject([{ code: item.code, offeredPence: 28000, reason: 'above_asking' }]);
  const demo = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'demo' } })).cookies[0]!.value };
  expect((await app.inject({ url: '/api/owner/feed', cookies: demo })).json().minorActivity).toEqual([]);
  expect((await app.inject('/api/owner/feed')).statusCode).toBe(401);
});
it('binds cards to the item and buyer, supersedes open cards, and rejects tampered totals', async () => {
  const first = (await chat({ offerPence: 500 })).json().card;
  const second = (await chat({ offerPence: 500 })).json().card;
  expect((await accept(first.id)).statusCode).toBe(409);
  expect((await accept(second.id, await buyer())).statusCode).toBe(409);
  expect((await accept(second.id, cookies, 'ZZZZ')).statusCode).toBe(409);
  expect((await accept(randomUUID())).statusCode).toBe(409);
  expect((await pay({ agreedPriceId: second.id })).statusCode).toBe(409);
  expect((await pay({ agreedPriceId: second.id, amount: 1 })).statusCode).toBe(400);
  await db.query('update offer_cards set amount_pence=1 where id=$1', [second.id]);
  expect((await accept(second.id)).statusCode).toBe(409);
  await db.query("update offer_cards set status='agreed' where id=$1", [second.id]);
  expect((await pay({ agreedPriceId: second.id })).statusCode).toBe(409);
  expect(fetcher).not.toHaveBeenCalled();
});
it('expires cards and agreed prices after thirty minutes, with idempotent acceptance', async () => {
  const first = (await chat({ offerPence: 2400 })).json().card;
  now = new Date(now.getTime() + 30 * 60_000);
  expect((await accept(first.id)).statusCode).toBe(409);
  expect((await page()).json().card).toBeNull();
  const next = (await chat({ offerPence: 2400 })).json().card;
  now = new Date(now.getTime() + 29 * 60_000);
  const agreed = (await accept(next.id)).json().agreedPrice;
  now = new Date(now.getTime() + 60_000);
  expect((await accept(next.id)).json().agreedPrice.expiresAt).toBe(agreed.expiresAt);
  expect((await page()).json().agreedPrice.id).toBe(agreed.id);
  now = new Date(agreed.expiresAt);
  expect((await page()).json().agreedPrice).toBeNull();
  expect((await pay({ agreedPriceId: agreed.id })).statusCode).toBe(409);
});
it('keeps a reservation and captured total unchanged through a price edit, invalidating other agreements', async () => {
  const card = (await chat({ offerPence: 2400 })).json().card;
  await accept(card.id);
  const firstBuyer = cookies;
  cookies = await buyer();
  const otherCard = (await chat({ offerPence: 2500 })).json().card;
  await accept(otherCard.id);
  cookies = firstBuyer;
  const checkout = (await pay({ agreedPriceId: card.id })).json();
  expect(checkout.totalPence).toBe(2400); expect(createBody.purchase_units[0]!.amount.value).toBe('24.00');
  await edit({ askingPence: 3500, floorPence: 3000 });
  expect((await pay({ agreedPriceId: card.id })).json().totalPence).toBe(2400);
  expect((await db.query('select status from offer_cards where id=$1', [otherCard.id])).rows[0].status).toBe('superseded');
  evidence = { id: 'ORDER1', purchase_units: [{ custom_id: checkout.checkoutId, payments: { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: { value: '24.00', currency_code: 'GBP' } }] } }] };
  expect((await app.inject({ method: 'POST', url: `/api/checkouts/${checkout.checkoutId}/capture`, cookies })).json()).toMatchObject({ state: 'paid', totalPence: 2400 });
});
it('does not reserve on acceptance and prevents a stale agreement after cancelling an edited reservation', async () => {
  const card = (await chat({ offerPence: 2400 })).json().card; await accept(card.id);
  expect((await page()).json().availability).toBe('available');
  const c = (await pay({ agreedPriceId: card.id })).json();
  await edit({ floorPence: 2600 });
  await app.inject({ method: 'POST', url: `/api/checkouts/${c.checkoutId}/cancel`, cookies });
  expect((await pay({ agreedPriceId: card.id })).statusCode).toBe(409);
});
it.each(['£19', 'GBP 19', '19 pounds', 'nineteen pounds', '£19.999', '1900p', '1,900 pence', 'nineteen hundred pence', '19.50'])('replaces unissued amount notation %s', async amount => {
  script = [answer(`I can do ${amount}.`)];
  const result = (await chat({ message: 'How much?' })).json();
  expect(result.reply).toContain('£28'); expect(result.reply).not.toBe(`I can do ${amount}.`); expect(result.card).toBeNull();
});
it('permits asking, buyer-written, server-issued and retail amounts, but never agrees through prose', async () => {
  await db.query('update items set retail_ref=$1 where id=$2', [JSON.stringify({ productId: 'P1', title: 'Lamp', pricePence: 6400, currency: 'GBP', condition: 'new', retailer: 'shop.example.co.uk', url: 'https://buy.example.com/P1', checkedAt: now.toISOString(), offers: [] }), item.id]);
  await chat({ offerPence: 500 });
  script = [answer('New £64, asking £28, your £5 offer, and I can do £24.')];
  const result = (await chat({ message: 'Can you recap the prices?' })).json();
  expect(result.reply).toBe('New £64, asking £28, your £5 offer, and I can do £24.');
  expect(result.agreedPrice).toBeNull();
});
it('issues no card for an above-asking offer and keeps the held counter live', async () => {
  const held = (await chat({ offerPence: 500 })).json().card;
  script = [answer('That is above the asking price. It has been refused for review.')];
  expect((await chat({ offerPence: 28000 })).json().card).toMatchObject({ id: held.id, totalPence: 2400 });
  expect((await db.query('select id from offer_cards')).rowCount).toBe(1);
  expect((await page()).json().card.id).toBe(held.id);
  expect((await accept(held.id)).json().agreedPrice.totalPence).toBe(2400);
});
it('rechecks availability inside a tool call after an owner changes the price while the model runs', async () => {
  await app.close();
  model = new MockLanguageModelV4({ doGenerate: async () => {
    await edit({ askingPence: 3500, floorPence: 3000 });
    return calls([2500]);
  } });
  app = buildApp(config, { db, model, fetcher, now: () => now });
  const result = (await chat({ message: '£25' })).json();
  expect(result.card.totalPence).toBe(3300);
  expect((await accept(result.card.id)).json().agreedPrice.totalPence).toBe(3300);
});
const buyPaid = async () => {
  const c = (await pay()).json();
  evidence = { id: 'ORDER1', purchase_units: [{ custom_id: c.checkoutId, payments: { captures: [{ id: 'CAPTURE1', status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' } }] } }] };
  expect((await app.inject({ method: 'POST', url: `/api/checkouts/${c.checkoutId}/capture`, cookies })).json().state).toBe('paid');
};
const agree = async () => {
  const open = (await chat({ offerPence: 2600 })).json().card;
  const agreed = (await accept(open.id)).json().agreedPrice;
  const next = (await chat({ offerPence: 2700 })).json().card;
  return { agreed, next };
};
it('drops cards and agreed prices once another buyer has bought the item', async () => {
  const { agreed } = await agree();
  const first = cookies;
  cookies = await buyer(); await buyPaid();
  cookies = first;
  expect((await page()).json()).toMatchObject({ availability: 'sold', card: null, agreedPrice: null });
  expect((await pay({ agreedPriceId: agreed.id })).statusCode).toBe(409);
});
it.each([
  ['removed', 'removed', async () => { expect((await app.inject({ method: 'POST', url: `/api/owner/items/${item.id}/remove`, cookies: owner, payload: { reason: 'Broken' } })).statusCode).toBeLessThan(300); }],
  ['closing', 'closed', async () => { await db.query("update trading_sessions set status='closing'"); }],
])('drops cards and agreed prices when the item or stall is %s', async (_name, availability, end) => {
  await agree();
  await end();
  expect((await page()).json()).toMatchObject({ availability, card: null, agreedPrice: null });
});
it('keeps an agreed price visible while another buyer only holds a reservation that can lapse', async () => {
  const { agreed } = await agree();
  const first = cookies;
  cookies = await buyer(); await pay();
  cookies = first;
  expect((await page()).json()).toMatchObject({ availability: 'reserved', agreedPrice: { id: agreed.id, totalPence: 2600 } });
  now = new Date(now.getTime() + 6 * 60_000);
  expect((await page()).json()).toMatchObject({ availability: 'available', agreedPrice: { id: agreed.id } });
});
it('keeps a card issued before a model failure for the buyer to find', async () => {
  modelError = true;
  expect((await chat({ offerPence: 2600 })).statusCode).toBe(503);
  expect((await page()).json().card).toMatchObject({ totalPence: 2600, kind: 'accept' });
});
it('releases a lapsed reservation when a card is tapped, with no page load first', async () => {
  const card = (await chat({ offerPence: 2600 })).json().card;
  const first = cookies;
  cookies = await buyer(); await pay();
  cookies = first;
  now = new Date(now.getTime() + 6 * 60_000);
  expect((await accept(card.id)).json().agreedPrice.totalPence).toBe(2600);
});
it('refuses a tap while another buyer holds a live reservation', async () => {
  const card = (await chat({ offerPence: 2600 })).json().card;
  const first = cookies;
  cookies = await buyer(); await pay();
  cookies = first;
  expect((await accept(card.id)).statusCode).toBe(409);
});
it.each([
  ['Is it 30 cm tall?', '£30'], ['Is it from 1970?', '£1970'], ['Is 50p enough?', '£50'],
])('does not treat the number in "%s" as permission to say %s', async (message, amount) => {
  script = [answer(`You can have it for ${amount}.`)];
  const { reply } = (await chat({ message })).json();
  expect(reply).not.toContain(amount); expect(reply).toContain('£28');
});
it.each([
  ['£15', '£15'], ['15', '£15'], ['Would you take 15?', '£15'], ['I offer 15.50', '£15.50'], ['How about 19.50?', '£19.50'], ['Is 50p enough?', '50p'], ['£1,200 maybe', '£1,200'],
])('lets a reply repeat the amount the buyer wrote in "%s"', async (message, amount) => {
  script = [answer(`I can't do ${amount}.`)];
  expect((await chat({ message })).json().reply).toBe(`I can't do ${amount}.`);
});
it('lets a reply repeat any earlier offer amount for this buyer and item, and nothing nobody offered', async () => {
  await chat({ offerPence: 500 });
  await chat({ offerPence: 500 });
  script = [answer('The first offer was £24 and the offer now is £22.')];
  expect((await chat({ message: 'What was the first offer?' })).json().reply).toBe('The first offer was £24 and the offer now is £22.');
  script = [answer('I could do £21 for you.')];
  expect((await chat({ message: 'Anything lower?' })).json().reply).not.toContain('£21');
  const other = await buyer();
  script = [answer('The offer was £24.')];
  const asked = await app.inject({ method: 'POST', url: `/api/i/${item.code}/chat`, cookies: other, payload: { message: 'What was the offer?' } });
  expect(asked.json().reply).not.toContain('£24');
  await edit({ floorPence: 2000 });
  script = [answer('The offer is £22.')];
  expect((await chat({ message: 'What is the offer now?' })).json().reply).not.toContain('£22');
});
it('allows the agreed amount in a reply until it expires', async () => {
  const card = (await chat({ offerPence: 2400 })).json().card;
  await accept(card.id);
  model.doGenerate = async () => answer('Your agreed price is £23.50.');
  await db.query('update offer_cards set amount_pence=2350');
  expect((await chat({ message: 'What did we agree?' })).json().reply).toBe('Your agreed price is £23.50.');
  now = new Date(now.getTime() + 31 * 60_000);
  expect((await chat({ message: 'What did we agree?' })).json().reply).not.toContain('£23.50');
});
it('words the fallback from the live card, not one an owner edit cancelled mid-reply', async () => {
  await app.close();
  let step = 0;
  model = new MockLanguageModelV4({ doGenerate: async () => {
    if (step++ === 0) return calls([500]);
    await edit({ floorPence: 2000 });
    return answer('Take it for £12.');
  } });
  app = buildApp(config, { db, model, fetcher, now: () => now });
  const result = (await chat({ message: '£5' })).json();
  expect(result.card).toBeNull(); expect(result.reply).not.toContain('£24'); expect(result.reply).toContain('£28');
});
it.each(['It is 1.25 m wide.', 'It holds 0.75 litre.', 'Collect by 2 p.m. today.', 'It closes at 10.30 a.m.', 'It weighs 2.50 kg.', 'It is 12.50% copper.', 'The stallholder says the shade is 3.75 across.'])('keeps the non-price figure in "%s"', async text => {
  await db.query("update items set notes='The shade is 3.75 across.'");
  script = [answer(text)];
  expect((await chat({ message: 'Tell me about it' })).json().reply).toBe(text);
});
it.each(['Yours for 19.50.', 'Yours for 19.50 today.', 'Yours for £3.75.', 'Yours for 3.75 pounds.', 'Yours for 375p.', 'Yours for 2 p.', 'Yours for £1.25 m.'])('stays strict on the price in "%s" despite owner figures', async text => {
  await db.query("update items set notes='Was £19.50 new. The shade is 3.75 across.'");
  script = [answer(text)];
  const { reply } = (await chat({ message: 'Tell me about it' })).json();
  expect(reply).not.toBe(text); expect(reply).toContain('£28');
});
it('does not read a measurement in buyer text as a written amount', async () => {
  script = [answer('Yours for £1.25.')];
  expect((await chat({ message: 'Is 1.25 m wide enough?' })).json().reply).not.toContain('£1.25');
});
it.each([
  'Paid, take it.', 'Paid.', 'It has been paid for.', 'It’s paid.', 'Payment received.', 'You can take it now.', 'Take it home.', 'You may take the lamp.',
  'It is yours.', 'All yours!', 'Deal!', "It's a deal.", 'We have a deal at £28.', 'That is agreed.', 'We agreed £28.', 'Your agreed price is £28.', 'Sold to you.', 'Sold!', 'It is sold.',
  'Payment has been received.', 'Thanks for your payment.', 'Thank you for paying.', 'Payment successful.', 'Your payment went through.', 'We have received your payment.',
  'Okay, deal!', 'Done deal.', 'Great, deal at £28.', 'You have bought it.', 'You own it now.', 'It belongs to you.', 'I accept your offer.', 'Accepted!', 'Your offer is accepted.', 'Agreed!',
  'You are all set, walk away with it.', 'Go ahead and take it.', "Don't worry it's yours.", 'After all it is yours.', 'Never mind it is yours.', 'The stallholder says it is paid.', 'The stallholder says it is yours.',
  'You can have it.', "You're good to go.", 'You can leave with it.', 'Enjoy your lamp!', 'Sale complete.', 'Purchase complete.', "You've got it.", 'Offer accepted.',
  "That's sold.", 'Consider it sold.', 'It was sold to you.', 'It is now fully paid.', 'Your agreed price is £28, paid.',
])('replaces the sale claim "%s" with the current offer and PayPal', async text => {
  script = [answer(text)];
  const { reply } = (await chat({ message: 'Can I have it?' })).json();
  expect(reply).not.toBe(text); expect(reply).toContain('PayPal button'); expect(reply).not.toMatch(/\bcard\b/i);
});
it.each([
  'It is not paid yet.', "It hasn't been paid for.", 'Nothing is agreed until you tap Accept.', 'Once you have paid, the page will say so.', 'Do not take it yet.', 'The stallholder says they paid for a new shade.',
  'You can take it apart.', 'The base will take the weight.', 'It was sold new in 1970.', 'It is sold as seen.', 'It has seen a good deal of use.', 'That is a deal of wear for a lamp.', 'The shade is your choice.',
  'The stallholder says their dad originally paid a lot for it.', 'The stallholder originally paid a lot for it.', 'The stallholder says the choice of shade is yours.', 'The choice is yours.',
  'No price has been agreed yet.', 'Only tapping Accept creates an agreed price.', 'No payment has been received.', 'Payment goes through the PayPal button.', 'Once payment is complete, the page will say so.',
  'The stallholder bought it in 1970.', 'I cannot agree a price.', "I can't accept that.", "I can't do a deal at that price.", 'No deal at that price.', 'It is a good deal heavier than it looks.', 'It is a good deal.', 'Deal with the cable gently.',
  'The notes do not say what was paid.', 'Thanks for your offer.', 'Payment is by PayPal.', 'An offer above the asking price is never accepted.', 'Your offer has not been accepted.',
  'Take it to a repair shop if the cable frays.', 'It was sold for parts once.', 'Nothing has been paid.', 'You have not paid.', 'It has not been sold.', 'It is not yours yet.', 'Not paid yet. Tap Accept, then use the PayPal button.', 'PayPal is accepted here.',
])('keeps the ordinary answer "%s"', async text => {
  script = [answer(text)];
  expect((await chat({ message: 'Tell me about it' })).json().reply).toBe(text);
});
it('lets a reply name a live agreed price, but still not claim payment', async () => {
  await accept((await chat({ offerPence: 2400 })).json().card.id);
  model.doGenerate = async () => answer('Your agreed price is £24.');
  expect((await chat({ message: 'What did we agree?' })).json().reply).toBe('Your agreed price is £24.');
  model.doGenerate = async () => answer('Your agreed price is £24, paid.');
  expect((await chat({ message: 'Is it paid?' })).json().reply).toContain('PayPal button');
});
it('tells the live feed when a chat turn ends, whether it was answered or failed', async () => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/owner/feed/stream`, { headers: { cookie: `stallkeeper_owner=${encodeURIComponent(owner.stallkeeper_owner!)}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  const next = async () => new TextDecoder().decode((await reader.read()).value);
  const feed = async () => (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
  try {
    expect(await next()).toContain('event: update');
    let update = next();
    await chat({ message: 'Does it work?' });
    expect(await update).toContain('event: update');
    expect((await feed()).buyerQuestions[0].questions[0].text).toBe('Does it work?');
    expect((await app.inject({ url: '/api/owner/ledger/data', cookies: owner })).json().aiSpend.spentUsd).toBeGreaterThan(0);
    update = next();
    modelError = true;
    expect((await chat({ message: 'Is it heavy?' })).statusCode).toBe(503);
    expect(await update).toContain('event: update');
    expect((await feed()).buyerQuestions[0].questions[0].text).toBe('Is it heavy?');
    modelError = false;
    update = next();
    await chat({ offerPence: 28000 });
    expect(await update).toContain('event: update');
    expect((await feed()).minorActivity).toMatchObject([{ offeredPence: 28000 }]);
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
});

const wording = ["I've issued a counter-offer of £24.", 'The server has come back with £24.', 'The servers came back with £24.', 'My tool says £24.', 'I used the respond_to_offer tool.', "There's a card for £24."];
it.each(wording)('replaces system wording in "%s" with the stall copy', async text => {
  script = [calls([500]), answer(text)];
  expect((await chat({ message: '£5' })).json().reply).toBe("I can't agree to £5. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
});
it('lets a reply name an item the owner listed as cards', async () => {
  await edit({ name: 'Pokémon cards' });
  script = [answer('The stallholder says the cards are all mint.')];
  expect((await chat({ message: 'What condition are they in?' })).json().reply).toBe('The stallholder says the cards are all mint.');
});
it('lets a reply answer a buyer who asks to pay by card', async () => {
  script = [answer('The PayPal button lets you pay by card.')];
  expect((await chat({ message: 'Can I pay by card?' })).json().reply).toBe('The PayPal button lets you pay by card.');
});
it('lets a reply use a word the owner wrote, such as a tool in the item name', async () => {
  await edit({ name: 'Garden tool set' });
  script = [answer('The stallholder says this garden tool set is complete.')];
  expect((await chat({ message: 'What is it?' })).json().reply).toBe('The stallholder says this garden tool set is complete.');
});
it('matches the plural of a word the owner wrote', async () => {
  await edit({ name: 'Garden tool set' });
  script = [answer('The stallholder says these garden tools are complete.')];
  expect((await chat({ message: 'What is it?' })).json().reply).toBe('The stallholder says these garden tools are complete.');
});
it('lets a reply use a word from the stall name', async () => {
  const stall = (await db.query<{ id: string; name: string }>('select s.id,s.name from stalls s join items i on i.stall_id=s.id where i.id=$1', [item.id])).rows[0]!;
  onTestFinished(async () => { await db.query('update stalls set name=$2 where id=$1', [stall.id, stall.name]); });
  await db.query("update stalls set name='The Tool Shed' where id=$1", [stall.id]);
  script = [answer('This is the Tool Shed, and the owner says the lamp works.')];
  expect((await chat({ message: 'Whose stall is this?' })).json().reply).toBe('This is the Tool Shed, and the owner says the lamp works.');
});
it('lets a reply use a word from this buyer\'s messages about the item, in that turn or a later one', async () => {
  const notCovered = "The stallholder's notes don't cover whether you need a tool.";
  script = [answer(notCovered)];
  expect((await chat({ message: 'Do I need a tool to change the bulb?' })).json().reply).toBe(notCovered);
  expect((await chat({ message: 'And for the shade?' })).json().reply).toBe(notCovered);
  const other = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Oak stool', notes: 'Sturdy. Waxed.', mode: 'haggle', askingPence: 2800, floorPence: 1800 } })).json();
  const replaced = await app.inject({ method: 'POST', url: `/api/i/${other.code}/chat`, cookies, payload: { message: 'Is it heavy?' } });
  expect(replaced.json().reply).not.toContain('tool');
});
it.each([
  ['£5', "I can't agree to £5. I can do £24 for it. Tap Accept if that works for you. Not paid yet."],
  ['I could do £15, or maybe £5, or £22. You pick.', "I can't agree to that. I can do £24 for it. Tap Accept if that works for you. Not paid yet."],
])('words a replaced counter-offer reply as fixed copy for "%s"', async (message, expected) => {
  script = [calls(message === '£5' ? [500] : [700]), answer('Deal at £13!')];
  expect((await chat({ message })).json().reply).toBe(expected);
});
it('logs the check that replaced a reply by category, never the reply text or an amount the buyer wrote', async () => {
  await app.close();
  const lines: string[] = [];
  app = buildApp(config, { db, model, fetcher, now: () => now, logger: { level: 'info', stream: { write: line => { lines.push(line); } } } });
  script = [calls([500]), answer("I've issued a counter-offer of £13. Deal, it is yours.")];
  await chat({ message: 'My secret phrase is violet. I offer £5.' });
  const replaced = lines.map(line => JSON.parse(line)).find(entry => entry.msg === 'AI reply replaced by stall copy');
  expect(replaced.replacedBy).toEqual(['sale-claim', 'system-wording', 'unissued-amount']);
  const everything = lines.join('');
  expect(everything).not.toMatch(/violet|issued a counter|it is yours|£13/);
  lines.length = 0;
  script = [answer('The stallholder says it works.')];
  await chat({ message: 'Does it work?' });
  expect(lines.some(line => line.includes('replaced by stall copy'))).toBe(false);
});
it('never puts the floor in the prompt or a buyer payload while wording a counter-offer', async () => {
  script = [calls([500]), answer("The stallholder says it's tested and works, so I can do £24. Tap Accept if that works for you.")];
  const response = await chat({ message: '£5' });
  expect(response.json().reply).toBe("The stallholder says it's tested and works, so I can do £24. Tap Accept if that works for you.");
  expect(JSON.stringify(model.doGenerateCalls.map(call => call.prompt))).not.toMatch(/floor|1800|18\.00/i);
  expect(response.body).not.toMatch(/1800|18\.00|floor/i);
});
it('tells the model to keep a counter short, not repeat the notes, name no unasked price and avoid system wording, without a new tool', async () => {
  await chat({ message: '£5' });
  const system = JSON.stringify(model.doGenerateCalls[0]!.prompt.find(message => message.role === 'system')!.content);
  expect(system).toContain('When you counter an offer, keep it short');
  expect(system).toContain("The buyer can already read the stallholder's notes, so do not repeat them.");
  expect(system).toContain('Name a price only when the buyer asks about price, makes an offer, or you are answering an offer');
  expect(system).not.toContain('give one reason for the price');
  expect(system).toContain('Never refer to your offer or price as a card. Never use the words \\"server\\", \\"issued\\" or \\"tool\\"');
  expect(model.doGenerateCalls[0]!.tools?.map(tool => tool.name)).toEqual(['respond_to_offer']);
});

const markupReply = '<invoke name="respond_to_offer">\n<parameter name="amount_pence">2000</parameter>\n</invoke>\n_tool_result_placeholder';
const systemPrompt = (index = 0) => JSON.stringify(model.doGenerateCalls[index]!.prompt.find(message => message.role === 'system')!.content);
const everyPrompt = () => JSON.stringify(model.doGenerateCalls.map(call => call.prompt));
it('replaces a form offer reply that is only tool-call text with the fixed copy, keeping the card', async () => {
  script = [answer(markupReply)];
  const response = (await chat({ offerPence: 2000 })).json();
  expect(response.reply).toBe("I can't agree to £20. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
  expect(response.card).toMatchObject({ totalPence: 2400, kind: 'counter' });
  expect(JSON.stringify(response)).not.toMatch(/invoke|parameter|_tool_result_placeholder|respond_to_offer/);
  expect((await db.query("select content from chat_messages where role='assistant'")).rows).toEqual([{ content: response.reply }]);
  script = [answer('The stallholder says it works. Tap Accept if £24 works for you.')];
  await chat({ message: 'Does it work?' });
  expect(everyPrompt()).not.toMatch(/invoke|_tool_result_placeholder|amount_pence/);
  expect(JSON.stringify((await page()).json().messages)).not.toMatch(/invoke|_tool_result_placeholder/);
});
it('replaces a typed offer reply that is only tool-call text with the fixed copy, keeping the card', async () => {
  script = [calls([2000]), answer(markupReply)];
  const response = (await chat({ message: 'Would you take £20?' })).json();
  expect(response.reply).toBe("I can't agree to £20. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
  expect(response.card).toMatchObject({ totalPence: 2400, kind: 'counter' });
  expect((await db.query("select content from chat_messages where role='assistant'")).rows).toEqual([{ content: response.reply }]);
});
it('answers a form offer with the fixed copy and keeps the card when the model reply is blank', async () => {
  script = [answer('')];
  const response = await chat({ offerPence: 2000 });
  expect(response.statusCode).toBe(200);
  expect(response.json().reply).toBe("I can't agree to £20. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
  expect(response.json().card).toMatchObject({ totalPence: 2400, kind: 'counter' });
  expect((await db.query("select content from chat_messages where role='assistant'")).rows).toEqual([{ content: response.json().reply }]);
});
it('answers a form offer with the fixed copy and keeps the card when the model refuses with a blank reply', async () => {
  script = [{ ...answer(''), finishReason: { unified: 'content-filter' as const, raw: 'refusal' } }];
  const response = await chat({ offerPence: 2000 });
  expect(response.statusCode).toBe(200);
  expect(response.json().reply).toBe("I can't agree to £20. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
  expect(response.json().card).toMatchObject({ totalPence: 2400, kind: 'counter' });
  expect((await db.query("select content from chat_messages where role='assistant'")).rows).toEqual([{ content: response.json().reply }]);
});
it('answers a form offer with the fixed copy and records the turn when the model refuses with only tool-call text', async () => {
  for (const text of [markupReply, '<invoke name="respond_to_offer">', '_tool_result_placeholder', '<invoke', '{"amountPence": 2000}']) {
    cookies = await buyer(); script = [{ ...answer(text), finishReason: { unified: 'content-filter' as const, raw: 'refusal' } }];
    const response = await chat({ offerPence: 2000 });
    expect(response.statusCode, text).toBe(200);
    expect(response.json().reply, text).toBe("I can't agree to £20. I can do £24 for it. Tap Accept if that works for you. Not paid yet.");
    expect(response.json().card, text).toMatchObject({ totalPence: 2400, kind: 'counter' });
    expect((await db.query("select content from chat_messages where role='assistant' order by created_at desc limit 1")).rows, text).toEqual([{ content: response.json().reply }]);
  }
});
it('keeps a refusal with real words a failure, with or without tool-call text around them, and shows none of it', async () => {
  for (const text of ['I cannot help with that.', 'Sorry, I cannot help. <function_calls>', '<b>No</b>', '2000']) {
    cookies = await buyer(); script = [{ ...answer(text), finishReason: { unified: 'content-filter' as const, raw: 'refusal' } }];
    const response = await chat({ offerPence: 2000 });
    expect(response.statusCode, text).toBe(503);
    expect(JSON.stringify(response.json()), text).not.toContain(text);
  }
  expect((await db.query("select count(*)::int as replies from chat_messages where role='assistant'")).rows).toEqual([{ replies: 0 }]);
});
it('replaces a reply that is empty markup around a tool name, an XML-like tag or the argument name', async () => {
  for (const text of ['respond_to_offer', 'Sure. <function_calls>', '</invoke>', '{"amountPence": 2000}', 'Done <br/>']) {
    cookies = await buyer(); script = [answer(text)];
    const response = (await chat({ offerPence: 2000 })).json();
    expect(response.reply, text).toMatch(/^I can't agree to/);
  }
});
it('replaces a reply cut off inside a tag, or holding the placeholder without its underscore', async () => {
  for (const text of ['<invoke', 'Sure. <parameter name="', '</inv', 'tool_result_placeholder']) {
    cookies = await buyer(); script = [{ ...answer(text), finishReason: { unified: 'length' as const, raw: 'max_tokens' } }];
    const response = (await chat({ offerPence: 2000 })).json();
    expect(response.reply, text).toMatch(/^I can't agree to/);
  }
});
it('leaves a plain reply with a comparison sign alone', async () => {
  script = [answer('The stallholder says it is under 30 cm, so 5 < 30 is true.')];
  expect((await chat({ offerPence: 2000 })).json().reply).toBe('The stallholder says it is under 30 cm, so 5 < 30 is true.');
});
it('logs only the tag and tool names on the server when it replaces a reply, and nothing else from the reply', async () => {
  await app.close();
  const lines: string[] = [];
  app = buildApp(config, { db, model, fetcher, now: () => now, logger: { level: 'info', stream: { write: line => { lines.push(line); } } } });
  cookies = await buyer();
  const replacedLog = () => lines.map(line => JSON.parse(line)).findLast(entry => entry.msg === 'AI reply replaced by stall copy');
  script = [answer(markupReply)];
  await chat({ offerPence: 2000 });
  expect(replacedLog()).toMatchObject({ replacedBy: ['markup'], markupNames: ['invoke', 'respond_to_offer', 'parameter', 'amount_pence', '_tool_result_placeholder'] });
  for (const [reply, names] of [
    ['Your number is <b>07700 900123</b>, and the owner says it works.', ['b']],
    ['Call <a title="07700 900123">the owner</a>.', ['a']],
    ['Call me on <my number 07700 900123>.', ['my']],
  ] as const) {
    cookies = await buyer();
    script = [answer(reply)];
    expect((await chat({ offerPence: 2000 })).json().reply, reply).toMatch(/^I can't agree to/);
    expect(replacedLog()).toMatchObject({ replacedBy: ['markup'], markupNames: names });
  }
  expect(lines.join('')).not.toContain('07700');
});
it('does not mention calling a tool in the prompt for a form offer, and gives the model no tool', async () => {
  await chat({ offerPence: 2000 });
  const call = model.doGenerateCalls[0]!;
  expect(call.tools ?? []).toHaveLength(0);
  expect(systemPrompt()).not.toMatch(/respond_to_offer|\bcall\b/i);
  expect(systemPrompt()).toContain('Reply to the buyer in plain words about that result only');
  await chat({ message: 'Would you take £20?' });
  expect(systemPrompt(1)).toContain('call respond_to_offer');
  expect(model.doGenerateCalls[1]!.tools?.map(tool => tool.name)).toEqual(['respond_to_offer']);
});
it('asks for whole pounds without pence', async () => {
  await chat({ offerPence: 2000 });
  expect(systemPrompt()).toContain('£16, not £16.00');
});
it('does not replay or show a stored reply that holds tool-call markup, and keeps the rest of the chat', async () => {
  const session = (await db.query<{ id: string }>('select id from buyer_sessions')).rows[0]!.id;
  const store = async (question: string, reply: string) => {
    const { rows } = await db.query<{ id: string }>("insert into chat_messages (buyer_session_id,item_id,role,content) values ($1,$2,'user',$3) returning id", [session, item.id, question]);
    await db.query("insert into chat_messages (buyer_session_id,item_id,role,content,answers_id) values ($1,$2,'assistant',$3,$4)", [session, item.id, reply, rows[0]!.id]);
  };
  await store('Does it work?', 'The stallholder says it works.');
  await store('Would you take £20?', markupReply);
  const shown = (await page()).json().messages as Array<{ role: string; content: string }>;
  expect(shown.map(entry => entry.content)).toEqual(['Does it work?', 'The stallholder says it works.']);
  script = [answer('The stallholder says it has a scuff on the base.')];
  await chat({ message: 'Any marks?' });
  const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt.filter(message => message.role !== 'system'));
  expect(sent).toContain('The stallholder says it works.');
  expect(sent).not.toMatch(/invoke|_tool_result_placeholder|Would you take/);
});
