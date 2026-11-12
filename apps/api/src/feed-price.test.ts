import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { testDatabase } from '../test/database.js';

const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173' };
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let stallId: string;
let sessionId: string;
let sequence = 0;
const feed = async () => (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
const ledger = async () => (await app.inject({ url: '/api/owner/ledger/data', cookies: owner })).json();
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 10, minutes)).toISOString();

async function addItem(name: string, askingPence: number, code: string, mode = 'haggle') {
  return (await db.query<{ id: string }>("insert into items (stall_id,code,name,notes,mode,asking_pence) values ($1,$2,$3,'Tested, works. Notes',$4,$5) returning id", [stallId, code, name, mode, askingPence])).rows[0]!.id;
}
// One buyer haggles over rounds of offers. The last offer becomes the card the buyer pays on.
async function haggle(itemId: string, askingPence: number, offers: Array<{ offered: number; outcome: string; at: string }>, card?: { amount: number }) {
  sequence += 1;
  const buyer = (await db.query<{ id: string }>('insert into buyer_sessions (token_hash) values ($1) returning id', [`hash-${sequence}`])).rows[0]!.id;
  let cardId: string | null = null;
  for (const [index, offer] of offers.entries()) {
    const message = (await db.query<{ id: string }>("insert into chat_messages (buyer_session_id,item_id,role,content) values ($1,$2,'user','Would you take less?') returning id", [buyer, itemId])).rows[0]!.id;
    const row = (await db.query<{ id: string }>('insert into offers (item_id,buyer_session_id,message_id,round,amount_pence,outcome,created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id', [itemId, buyer, message, index + 1, offer.offered, offer.outcome, offer.at])).rows[0]!.id;
    const item = (await db.query<{ code: string; name: string }>('select code,name from items where id=$1', [itemId])).rows[0]!;
    await db.query("insert into events (stall_id,trading_session_id,type,payload,business_key,created_at) values ($1,$2,'offer_refused',$3,$4,$5)", [stallId, sessionId, JSON.stringify({ itemName: item.name, code: item.code, offeredPence: offer.offered, reason: 'not_agreed' }), `offer:${row}`, offer.at]);
    if (index === offers.length - 1 && card) {
      cardId = (await db.query<{ id: string }>("insert into offer_cards (offer_id,item_id,buyer_session_id,amount_pence,price_version,expires_at,status,agreed_at) values ($1,$2,$3,$4,1,now(),'agreed',now()) returning id", [row, itemId, buyer, card.amount])).rows[0]!.id;
    }
  }
  return { buyer, cardId, askingPence };
}
async function pay(itemId: string, amountPence: number, minutes: number, extra: { cardId?: string | null; kind?: string; askingPence?: number } = {}) {
  sequence += 1;
  const buyer = (await db.query<{ id: string }>('insert into buyer_sessions (token_hash) values ($1) returning id', [`pay-${sequence}`])).rows[0]!.id;
  const item = (await db.query<{ code: string; name: string; asking_pence: number }>('select code,name,asking_pence from items where id=$1', [itemId])).rows[0]!;
  const kind = extra.kind ?? 'sale';
  const checkout = (await db.query<{ id: string }>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,paypal_order_id,reservation_deadline,kind,offer_card_id,created_at)
    values ($1,$2,$3,'paid',$4,$5,gen_random_uuid(),gen_random_uuid(),$6,now(),$7,$8,$9) returning id`, [stallId, sessionId, buyer, amountPence, `key-${sequence}`, `ORDER${sequence}`, kind, extra.cardId ?? null, at(minutes)])).rows[0]!.id;
  await db.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$6)', [checkout, itemId, item.code, item.name, extra.askingPence ?? item.asking_pence, amountPence]);
  await db.query("insert into captures (paypal_capture_id,checkout_id,amount_pence,currency,status,captured_at,webhook_verified_at) values ($1,$2,$3,'GBP','COMPLETED',$4,$4)", [`CAPTURE${sequence}`, checkout, amountPence, at(minutes)]);
  await db.query("insert into events (stall_id,trading_session_id,type,payload,business_key,created_at) values ($1,$2,$3,$4,$5,$6)", [stallId, sessionId, kind, JSON.stringify({ captureId: `CAPTURE${sequence}` }), `${kind}:${checkout}`, at(minutes)]);
}
const line = async (code: string) => (await feed()).sales.find((sale: { code: string }) => sale.code === code);

beforeEach(async () => {
  await db.query('truncate paypal_order_reads, charity_donations, closings, offers, offer_cards, chat_messages, item_floors, refunds, captures, checkout_lines, events, checkouts, items, trading_sessions, buyer_sessions, ai_usage cascade');
  app = buildApp(config, { db, now: () => new Date('2026-11-07T12:00:00Z') });
  owner = { stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } })).cookies[0]!.value };
  stallId = (await db.query<{ id: string }>('select id from stalls where is_demo=false')).rows[0]!.id;
  sessionId = (await db.query<{ id: string }>("insert into trading_sessions (stall_id,opened_at,status) values ($1,$2,'open') returning id", [stallId, at(0)])).rows[0]!.id;
});
afterEach(async () => app.close());

describe('how each sale price was agreed', () => {
  it('gives a one-round offer sale its asking price, the offer and the agreed price', async () => {
    const mirror = await addItem('Round wall mirror', 1800, 'M38J');
    const { cardId } = await haggle(mirror, 1800, [{ offered: 1000, outcome: 'counter', at: at(1) }], { amount: 1600 });
    await pay(mirror, 1600, 5, { cardId });
    expect(await line('M38J')).toMatchObject({ amountPence: 1600, price: { source: 'offer', askingPence: 1800, offeredPence: 1000, droppedFromPence: null } });
  });

  it('shows the last offer of a two-round haggle, the one the agreed card answered', async () => {
    const mirror = await addItem('Round wall mirror', 1800, 'M38J');
    const { cardId } = await haggle(mirror, 1800, [{ offered: 1000, outcome: 'counter', at: at(1) }, { offered: 1500, outcome: 'accept', at: at(2) }], { amount: 1500 });
    await pay(mirror, 1500, 5, { cardId });
    expect((await line('M38J')).price).toEqual({ source: 'offer', askingPence: 1800, offeredPence: 1500, droppedFromPence: null });
  });

  it('gives a pay what you want sale its suggestion, a fixed sale a listed price and leaves a tip without a price line', async () => {
    const poster = await addItem('Poster', 500, 'PWYZ', 'pwyw'); const kettle = await addItem('Kettle', 1200, 'FXKT', 'fixed'); const clock = await addItem('Clock', 100, 'FRKE', 'free');
    await pay(poster, 325, 1); await pay(kettle, 1200, 2); await pay(clock, 100, 3, { kind: 'tip' });
    expect((await line('PWYZ')).price).toEqual({ source: 'pwyw', askingPence: 500, offeredPence: null, droppedFromPence: null });
    expect((await line('FXKT')).price).toEqual({ source: 'listed', askingPence: 1200, offeredPence: null, droppedFromPence: null });
    expect((await line('FRKE')).price).toBeNull();
  });

  it('names the price before a price drop only when the sale was at the dropped price', async () => {
    const kettle = await addItem('Kettle', 1000, 'DRPP', 'fixed'); const lamp = await addItem('Lamp', 2000, 'KMPP', 'fixed');
    await db.query("insert into events (stall_id,trading_session_id,type,payload,business_key,created_at) values ($1,$2,'price_drop',$3,'drop-1',$4),($1,$2,'price_drop',$5,'drop-2',$4)", [stallId, sessionId, JSON.stringify({ itemId: kettle, name: 'Kettle', code: 'DRPP', seeded: false, oldPence: 1000, newPence: 900, reason: 'Quiet' }), at(2),
      JSON.stringify({ itemId: lamp, name: 'Lamp', code: 'KMPP', seeded: false, oldPence: 2500, newPence: 2200, reason: 'Quiet' })]);
    await pay(kettle, 900, 5, { askingPence: 900 }); await pay(lamp, 2000, 6, { askingPence: 2000 });
    expect((await line('DRPP')).price.droppedFromPence).toBe(1000);
    expect((await line('KMPP')).price.droppedFromPence).toBeNull();
  });

  it('names the price before a drop made in an earlier session', async () => {
    const kettle = await addItem('Kettle', 900, 'DRPP', 'fixed');
    const earlier = (await db.query<{ id: string }>("insert into trading_sessions (stall_id,opened_at,closed_at,status) values ($1,'2026-11-06T09:00:00Z','2026-11-06T17:00:00Z','closed') returning id", [stallId])).rows[0]!.id;
    await db.query("insert into events (stall_id,trading_session_id,type,payload,business_key,created_at) values ($1,$2,'price_drop',$3,'drop-earlier','2026-11-06T12:00:00Z')", [stallId, earlier, JSON.stringify({ itemId: kettle, name: 'Kettle', code: 'DRPP', seeded: false, oldPence: 1000, newPence: 900, reason: 'Quiet' })]);
    await pay(kettle, 900, 5);
    expect((await line('DRPP')).price.droppedFromPence).toBe(1000);
  });

  it('marks a refused offer that later became a sale and leaves one with no sale unchanged', async () => {
    const mirror = await addItem('Round wall mirror', 1800, 'M38J'); const lamp = await addItem('Brass lamp', 2500, 'VPAP');
    const { cardId } = await haggle(mirror, 1800, [{ offered: 1000, outcome: 'counter', at: at(1) }], { amount: 1600 });
    await haggle(lamp, 2500, [{ offered: 1000, outcome: 'counter', at: at(1) }]);
    await pay(mirror, 1600, 5, { cardId });
    const { minorActivity } = await feed();
    expect(minorActivity.find((entry: { code: string }) => entry.code === 'M38J')).toMatchObject({ offeredPence: 1000, counterPence: 1600, becameSalePence: 1600 });
    expect(minorActivity.find((entry: { code: string }) => entry.code === 'VPAP').becameSalePence).toBeNull();
  });

  it('keeps the floor out of the response and gives each sale exactly these keys', async () => {
    const mirror = await addItem('Round wall mirror', 1800, 'M38J');
    await db.query('insert into item_floors values ($1,1337)', [mirror]);
    const { cardId } = await haggle(mirror, 1800, [{ offered: 1000, outcome: 'counter', at: at(1) }], { amount: 1600 });
    await pay(mirror, 1600, 5, { cardId });
    const response = await app.inject({ url: '/api/owner/feed', cookies: owner });
    expect(response.body).not.toMatch(/floor/i);
    expect(response.body).not.toContain('1337');
    const [sale] = response.json().sales;
    expect(Object.keys(sale).sort()).toEqual(['amountPence', 'checkoutId', 'code', 'id', 'kind', 'name', 'price', 'refundedPence', 'seeded', 'time', 'webhookVerifiedAt']);
    expect(Object.keys(sale.price).sort()).toEqual(['askingPence', 'droppedFromPence', 'offeredPence', 'source']);
  });

  it('agrees with the ledger grid on the price source, asking price and amount', async () => {
    const mirror = await addItem('Round wall mirror', 1800, 'M38J'); const poster = await addItem('Poster', 500, 'PWYZ', 'pwyw'); const kettle = await addItem('Kettle', 1200, 'FXKT', 'fixed');
    const { cardId } = await haggle(mirror, 1800, [{ offered: 1000, outcome: 'counter', at: at(1) }], { amount: 1600 });
    await pay(mirror, 1600, 5, { cardId }); await pay(poster, 325, 6); await pay(kettle, 1200, 7);
    const source = { offer: 'Agreed offer', pwyw: "Buyer's amount", listed: 'Listed price' };
    const rows = (await ledger()).ledger as Array<{ code: string; priceSource: string; asking: number; amount: number }>;
    const sales = (await feed()).sales as Array<{ code: string; amountPence: number; price: { source: keyof typeof source; askingPence: number } }>;
    expect(sales).toHaveLength(3);
    for (const sale of sales) {
      const row = rows.find(entry => entry.code === sale.code)!;
      expect({ priceSource: source[sale.price.source], asking: sale.price.askingPence / 100, amount: sale.amountPence / 100 }).toEqual({ priceSource: row.priceSource, asking: row.asking, amount: row.amount });
    }
  });
});
