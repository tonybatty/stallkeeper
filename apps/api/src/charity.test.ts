import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';
import { buyerLine, parseDonationAmount, pledgePence } from './charity.js';
import { repairClosings } from './closing.js';

const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', webhookId: 'test', publicBaseUrl: 'http://localhost:5173', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false };
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let itemCode: string;
let sequence: number;
let model: MockLanguageModelV4;
let modelReply: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const orders = new Map<string, string>();
const answer = { finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] };
const send = (method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, payload?: object, cookies = owner) => app.inject({ method, url, cookies, ...(payload ? { payload } : {}) });
const read = async () => (await send('GET', '/api/owner/closing')).json().closing;
const setCharity = (name = 'Garden Rescue', percent = 10) => send('PUT', '/api/owner/stall/charity', { name, percent });
async function webhook(orderId: string, type: 'COMPLETED' | 'REFUNDED') {
  return app.inject({ method: 'POST', url: '/api/webhooks/paypal', headers: {
    'paypal-auth-algo': 'test', 'paypal-cert-url': 'test', 'paypal-transmission-id': 'test', 'paypal-transmission-sig': 'test', 'paypal-transmission-time': 'test',
  }, payload: { id: `EVENT-${orderId}-${type}`, event_type: `PAYMENT.CAPTURE.${type}`, resource: {
    id: type === 'REFUNDED' ? `REF-${orderId}` : `CAP-${orderId}`, status: 'COMPLETED', amount: { value: type === 'REFUNDED' ? '4.00' : '28.00', currency_code: 'GBP' },
    supplementary_data: { related_ids: { order_id: orderId, capture_id: `CAP-${orderId}` } },
  } } });
}
// One £28 sale, so a 10% pledge is £2.80, and £2.40 once £4 is refunded.
async function sell() {
  const first = await app.inject(`/api/i/${itemCode}`);
  const cookies = { stallkeeper_buyer: first.cookies[0]!.value };
  const checkout = (await send('POST', `/api/i/${itemCode}/checkout`, {}, cookies)).json();
  expect((await send('POST', `/api/checkouts/${checkout.checkoutId}/capture`, undefined, cookies)).json().state).toBe('paid');
  return checkout as { paypalOrderId: string };
}
beforeEach(async () => {
  await db.query('truncate items,buyer_sessions,trading_sessions,webhook_inbox,ai_usage cascade');
  await db.query('update stalls set charity_name=null,charity_percent=null where not is_demo');
  sequence = 0; orders.clear();
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (path.endsWith('/verify-webhook-signature')) return Response.json({ verification_status: 'SUCCESS' });
    if (path.endsWith('/capture')) {
      const id = path.split('/').at(-2)!;
      return Response.json({ id, purchase_units: [{ custom_id: orders.get(id), payments: { captures: [{ id: `CAP-${id}`, status: 'COMPLETED', amount: { value: '28.00', currency_code: 'GBP' } }] } }] });
    }
    const id = `ORDER${++sequence}`;
    orders.set(id, JSON.parse(String(init?.body)).purchase_units[0].custom_id);
    return Response.json({ id });
  });
  modelReply = 'Yes, it works.';
  model = new MockLanguageModelV4({ doGenerate: async () => ({ ...answer, content: [{ type: 'text' as const, text: modelReply }] }) });
  app = buildApp(config, { db, fetcher, model });
  owner = { stallkeeper_owner: (await send('POST', '/api/owner/login', { password: 'owner' }, {})).cookies[0]!.value };
  itemCode = (await send('POST', '/api/owner/items', { name: 'Lamp', notes: 'Tested', mode: 'haggle', askingPence: 2800, floorPence: 1800 })).json().code;
  expect((await send('POST', '/api/owner/stall/open')).statusCode).toBe(201);
});
afterEach(async () => { await app.close(); });

describe('pledge calculation', () => {
  it('takes a whole-number percentage of net sales and rounds down to the penny', () => {
    expect(pledgePence(2800, 10)).toBe(280);
    expect(pledgePence(2400, 10)).toBe(240);
    expect(pledgePence(2799, 10)).toBe(279);
    expect(pledgePence(1, 99)).toBe(0);
    expect(pledgePence(2800, 100)).toBe(2800);
    expect(pledgePence(0, 50)).toBe(0);
    expect(pledgePence(-100, 50)).toBe(0);
  });
  it('words the buyer line from the owner\'s stated name and percentage only', () => {
    expect(buyerLine({ name: 'Garden Rescue', percent: 10 })).toBe("10% of today's takings go to Garden Rescue.");
  });
  it('reads the amount the Donate button reports as pence, and refuses anything else', () => {
    expect(parseDonationAmount('2.80')).toBe(280);
    expect(parseDonationAmount('3')).toBe(300);
    expect(parseDonationAmount('0.5')).toBe(50);
    for (const bad of ['0', '0.00', '-1', '1,00', '1.234', 'abc', '', '12345678.00']) expect(parseDonationAmount(bad)).toBeNull();
  });
});

describe('owner pledge', () => {
  it('saves a pledge, reads it back and clears it', async () => {
    expect((await send('GET', '/api/owner/stall/charity')).json()).toEqual({ charity: null, donateButton: false, sessionFixed: false });
    expect((await setCharity('  Garden Rescue ', 25)).json()).toEqual({ charity: { name: 'Garden Rescue', percent: 25, seeded: false }, donateButton: false, sessionFixed: false });
    expect((await send('GET', '/api/owner/stall/charity')).json().charity).toMatchObject({ name: 'Garden Rescue', percent: 25 });
    expect((await send('DELETE', '/api/owner/stall/charity')).json()).toEqual({ charity: null, donateButton: false, sessionFixed: false });
    expect((await db.query('select charity_name,charity_percent from stalls where not is_demo')).rows[0]).toEqual({ charity_name: null, charity_percent: null });
  });
  it.each([[0], [101], [10.5], [-5]])('refuses a percentage of %s', async percent => {
    expect((await setCharity('Garden Rescue', percent)).statusCode).toBe(400);
  });
  it.each([[''], ['   '], ['Bad\u0007name'], ['x'.repeat(81)]])('refuses the name %j', async name => {
    expect((await setCharity(name, 10)).statusCode).toBe(400);
  });
  it('refuses a request with no login, and keeps each stall\'s pledge to itself', async () => {
    expect((await send('PUT', '/api/owner/stall/charity', { name: 'A', percent: 5 }, {})).statusCode).toBe(401);
    await setCharity();
    const demo = { stallkeeper_owner: (await send('POST', '/api/owner/login', { password: 'demo' }, {})).cookies[0]!.value };
    expect((await send('GET', '/api/owner/stall/charity', undefined, demo)).json().charity).toBeNull();
  });
});

describe('buyer line', () => {
  it('shows one fixed line on the item page once the owner sets a pledge, and nothing before', async () => {
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity).toBeNull();
    await setCharity('Garden Rescue', 10);
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity).toEqual({ line: "10% of today's takings go to Garden Rescue.", seeded: false });
  });
  it('keeps the open session\'s line after its first recorded sale, and shows the saved pledge once no session is open', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    await setCharity('Other Cause', 5);
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity.line).toBe("10% of today's takings go to Garden Rescue.");
    await send('DELETE', '/api/owner/stall/charity');
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity.line).toBe("10% of today's takings go to Garden Rescue.");
    await setCharity('Other Cause', 5);
    await send('POST', '/api/owner/stall/close');
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity.line).toBe("5% of today's takings go to Other Cause.");
  });
  it('shows no line for the rest of a session that had its first sale with no pledge', async () => {
    await sell();
    await setCharity('Garden Rescue', 10);
    expect((await app.inject(`/api/i/${itemCode}`)).json().charity).toBeNull();
  });
  it('carries no amount, floor or donation detail', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    const body = JSON.stringify((await app.inject(`/api/i/${itemCode}`)).json().charity);
    expect(body).not.toMatch(/pledgePence|donation|2\.80|280/);
  });
});

describe('AI stallholder', () => {
  const ask = async () => {
    const first = await app.inject(`/api/i/${itemCode}`);
    return send('POST', `/api/i/${itemCode}/chat`, { message: 'Does any money go to charity?' }, { stallkeeper_buyer: first.cookies[0]!.value });
  };
  it('is given the owner\'s pledge sentence, and a rule to repeat only that', async () => {
    await setCharity('Garden Rescue', 10);
    expect((await ask()).statusCode).toBe(200);
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain('charityPledge');
    expect(prompt).toContain("10% of today's takings go to Garden Rescue.");
    expect(prompt).toMatch(/word for word/);
    expect(prompt).not.toMatch(/280|2\.80/);
  });
  it('holds to the session\'s pledge after an edit that waits for the next session', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    await setCharity('Other Cause', 5);
    itemCode = (await send('POST', '/api/owner/items', { name: 'Mirror', notes: 'Tested', mode: 'haggle', askingPence: 2800, floorPence: 1800 })).json().code;
    modelReply = "5% of today's takings go to Other Cause.";
    const { reply } = (await ask()).json();
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("10% of today's takings go to Garden Rescue.");
    expect(prompt).not.toContain('Other Cause');
    expect(reply).toContain("10% of today's takings go to Garden Rescue.");
    expect(reply).not.toContain('Other Cause');
  });
  it('has no pledge to mention when the owner has not stated one', async () => {
    expect((await ask()).statusCode).toBe(200);
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain('Garden Rescue');
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toMatch(/"charityPledge"/);
  });
  it.each([
    ["10% of today's takings go to Garden Rescue."], ['10 percent goes to charity.'], ['It is 12.50% copper.'], ['It is 100% brass, the owner says.'],
  ])('keeps the reply "%s"', async text => {
    await setCharity('Garden Rescue', 10);
    modelReply = text;
    expect((await ask()).json().reply).toBe(text);
  });
  it.each([
    ["50% of today's takings go to Garden Rescue."], ['Fifty percent goes to charity.'], ['50-percent goes to charity.'], ['We give to charity. 25 per cent of it.'], ['50% goes to Garden Rescue.'], ['10% goes to charity, or 20% on Sundays.'],
  ])('replaces the misstated pledge "%s" with stall copy and the owner\'s line', async text => {
    await setCharity('Garden Rescue', 10);
    modelReply = text;
    const { reply } = (await ask()).json();
    expect(reply).toContain('The asking price is £28.');
    expect(reply).toContain("10% of today's takings go to Garden Rescue.");
    expect(reply).not.toContain(text);
  });
  const stockWool = async () => { itemCode = (await send('POST', '/api/owner/items', { name: 'Jumper', notes: 'Worn twice. 100% wool.', mode: 'haggle', askingPence: 2800, floorPence: 1800 })).json().code; };
  it.each([["It's 100% wool, so good value for the money."], ["I can't go to 20% off, but the owner says it works."]])('keeps "%s" with and without a pledge', async text => {
    await stockWool();
    modelReply = text;
    expect((await ask()).json().reply).toBe(text);
    await setCharity('Garden Rescue', 10);
    expect((await ask()).json().reply).toBe(text);
  });
  it.each([
    ['Mind', "It's 100% wool, if you don't mind a small darn."], ['Mind', 'Mindful work, 100% wool.'], ['Art', 'It came as part of a set, 100% wool.'],
  ])('does not take a word in "%2$s" for the charity %1$s', async (name, text) => {
    await setCharity(name, 10);
    modelReply = text;
    expect((await ask()).json().reply).toBe(text);
  });
  it.each([['Mind', '50% goes to Mind.'], ['(Re)Build-It', '50% goes to (Re)Build-It.'], ['St. Luke\'s', '50% is for St. Luke\'s.']])('still reads the whole name of %s', async (name, text) => {
    await setCharity(name, 10);
    modelReply = text;
    expect((await ask()).json().reply).toContain(`10% of today's takings go to ${name}.`);
  });
  it('does not read a discount beside the owner\'s line as a second pledge', async () => {
    await setCharity('Garden Rescue', 10);
    modelReply = "I can't do 20% off. 10% of today's takings go to Garden Rescue.";
    expect((await ask()).json().reply).toBe(modelReply);
  });
  it('replaces a wrong percentage of the takings even with no charity named', async () => {
    await setCharity('Garden Rescue', 10);
    modelReply = 'Yes, 50% of the takings go there.';
    expect((await ask()).json().reply).toContain("10% of today's takings go to Garden Rescue.");
  });
  it('does not let an item\'s percentage stand for the pledge once the reply names charity', async () => {
    await stockWool();
    await setCharity('Garden Rescue', 10);
    modelReply = '100% goes to charity.';
    expect((await ask()).json().reply).toContain("10% of today's takings go to Garden Rescue.");
  });
  it.each([['Tools for Self Reliance'], ['Pounds for Paws'], ['£1 Club'], ['2.50 Club'], ['You Own It']])('keeps the owner\'s line word for word for the charity %s', async name => {
    await setCharity(name, 10);
    modelReply = `10% of today's takings go to ${name}.`;
    expect((await ask()).json().reply).toBe(modelReply);
  });
  it.each([
    ["10% of today's takings go to Pounds for Paws. It's yours for 5 pounds."], ['Pounds for Paws gets a share, and it is yours for 5 pounds.'],
  ])('still checks the words around the owner\'s line in "%s"', async text => {
    await setCharity('Pounds for Paws', 10);
    modelReply = text;
    expect((await ask()).json().reply).toContain('The asking price is £28.');
  });
  it('does not let the owner\'s line carry a second percentage', async () => {
    await setCharity('Garden Rescue', 10);
    modelReply = "10% of today's takings go to Garden Rescue, or 50% on Sundays.";
    expect((await ask()).json().reply).not.toContain('50%');
  });
  it('gives a decimal in the item\'s name no price exemption', async () => {
    itemCode = (await send('POST', '/api/owner/items', { name: 'Brass weight 12.50', notes: 'Tested', mode: 'haggle', askingPence: 2800, floorPence: 1800 })).json().code;
    modelReply = 'I can do 12.50.';
    expect((await ask()).json().reply).toContain('The asking price is £28.');
  });
  it('replaces a stated pledge when the owner has none', async () => {
    modelReply = '10% goes to charity.';
    const { reply } = (await ask()).json();
    expect(reply).toContain('The asking price is £28.');
    expect(reply).not.toContain('10%');
  });
  it('does not read a percentage in the charity\'s name as the pledge', async () => {
    await setCharity('100% Wildlife', 10);
    modelReply = "10% of today's takings go to 100% Wildlife.";
    expect((await ask()).json().reply).toBe(modelReply);
  });
});

describe('closing report', () => {
  it('has no charity block without a pledge', async () => {
    await sell();
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toBeNull();
  });
  it('works the pledge out from recorded sales after refunds and states the basis', async () => {
    await setCharity('Garden Rescue', 10);
    const sale = await sell();
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Garden Rescue', percent: 10, basisPence: 2800, pledgePence: 280, donations: [] });
    expect((await webhook(sale.paypalOrderId, 'REFUNDED')).statusCode).toBe(200);
    const report = await read();
    expect(report).toMatchObject({ recordedSalesPence: 2400, refundedPence: 400 });
    expect(report.charity).toMatchObject({ basisPence: 2400, pledgePence: 240 });
  });
  it('pledges nothing while there are no recorded sales', async () => {
    await setCharity('Garden Rescue', 10);
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ basisPence: 0, pledgePence: 0 });
  });
  it('keeps the pledge a session traded under when the owner edits or removes it afterwards', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    const closed = (await send('POST', '/api/owner/stall/close')).json();
    await setCharity('Other Cause', 5);
    expect((await read()).charity).toMatchObject({ name: 'Garden Rescue', percent: 10, pledgePence: 280 });
    await send('DELETE', '/api/owner/stall/charity');
    expect((await read()).charity).toMatchObject({ name: 'Garden Rescue', percent: 10, pledgePence: 280 });
    const stored = (await db.query('select totals from closings where trading_session_id=$1', [closed.sessionId])).rows[0].totals;
    expect(stored.charity).toMatchObject({ name: 'Garden Rescue', percent: 10, pledgePence: 280 });
  });
  it('takes the stall\'s pledge into the next session when it opens', async () => {
    await setCharity('Garden Rescue', 10);
    await send('POST', '/api/owner/stall/close');
    await setCharity('Other Cause', 5);
    await repairClosings(db, new Date());
    expect((await send('POST', '/api/owner/stall/open')).statusCode).toBe(201);
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Other Cause', percent: 5 });
  });
  it('follows an edit or removal made before the session\'s first recorded sale', async () => {
    await setCharity('Garden Rescue', 10);
    await setCharity('Other Cause', 5);
    await send('DELETE', '/api/owner/stall/charity');
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toBeNull();
  });
  it('fixes the session\'s pledge at its first recorded sale and saves later edits for the next session', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    expect((await send('GET', '/api/owner/stall/charity')).json().sessionFixed).toBe(true);
    expect((await setCharity('Other Cause', 5)).json()).toEqual({ charity: { name: 'Other Cause', percent: 5, seeded: false }, donateButton: false, sessionFixed: true });
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Garden Rescue', percent: 10, pledgePence: 280 });
    expect((await send('GET', '/api/owner/stall/charity')).json()).toMatchObject({ charity: { name: 'Other Cause' }, sessionFixed: false });
    await repairClosings(db, new Date());
    expect((await send('POST', '/api/owner/stall/open')).statusCode).toBe(201);
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Other Cause', percent: 5 });
  });
  it('keeps the pledge when the owner removes it after the first recorded sale', async () => {
    await setCharity('Garden Rescue', 10);
    await sell();
    expect((await send('DELETE', '/api/owner/stall/charity')).json()).toEqual({ charity: null, donateButton: false, sessionFixed: true });
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Garden Rescue', percent: 10, basisPence: 2800, pledgePence: 280 });
  });
  it('stays fixed after the only sale is refunded', async () => {
    await setCharity('Garden Rescue', 10);
    const sale = await sell();
    expect((await webhook(sale.paypalOrderId, 'REFUNDED')).statusCode).toBe(200);
    await setCharity('Other Cause', 5);
    expect((await send('POST', '/api/owner/stall/close')).json().charity).toMatchObject({ name: 'Garden Rescue', percent: 10, basisPence: 2400, pledgePence: 240 });
  });
});

describe('donations', () => {
  const donate = (sessionId: string, overrides: Record<string, string> = {}) => send('POST', '/api/owner/closing/donation', { sessionId, transactionId: 'TX1234567', status: 'Completed', amount: '2.80', currency: 'GBP', ...overrides });
  async function closeWithSale() {
    await setCharity('Garden Rescue', 10);
    await sell();
    return (await send('POST', '/api/owner/stall/close')).json();
  }
  it('records a completed donation beside the sales and leaves every sales figure and capture untouched', async () => {
    const before = await closeWithSale();
    const captures = (await db.query('select * from captures order by paypal_capture_id')).rows;
    const refunds = (await db.query('select count(*)::int as n from refunds')).rows[0].n;
    const response = await donate(before.sessionId);
    expect(response.statusCode).toBe(200);
    expect(response.json().donations).toEqual([expect.objectContaining({ transactionId: 'TX1234567', amountPence: 280, currency: 'GBP' })]);
    const after = await read();
    expect(after.charity.donations).toHaveLength(1);
    for (const key of ['recordedSalesPence', 'refundedPence', 'paidCheckouts', 'itemsSold']) expect(after[key]).toBe(before[key]);
    expect(after.charity).toMatchObject({ basisPence: 2800, pledgePence: 280 });
    expect((await db.query('select * from captures order by paypal_capture_id')).rows).toEqual(captures);
    expect((await db.query('select count(*)::int as n from refunds')).rows[0].n).toBe(refunds);
  });
  it('records the same transaction once', async () => {
    const report = await closeWithSale();
    await donate(report.sessionId); await donate(report.sessionId);
    expect((await db.query('select count(*)::int as n from charity_donations')).rows[0].n).toBe(1);
  });
  it.each([
    ['not completed', { status: 'Pending' }], ['a zero amount', { amount: '0.00' }], ['an unreadable amount', { amount: 'abc' }],
  ])('leaves the report unchanged for a donation that is %s', async (_name, overrides) => {
    const report = await closeWithSale();
    const response = await donate(report.sessionId, overrides);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('The donation was not recorded. Your report is unchanged.');
    expect((await read()).charity.donations).toEqual([]);
  });
  it('refuses a transaction ID that is not alphanumeric', async () => {
    const report = await closeWithSale();
    expect((await donate(report.sessionId, { transactionId: "x'; drop table items; --" })).statusCode).toBe(400);
  });
  it('keeps a recorded donation on the report after the pledge is removed', async () => {
    const report = await closeWithSale();
    await donate(report.sessionId);
    await send('DELETE', '/api/owner/stall/charity');
    expect((await read()).charity).toMatchObject({ name: 'Garden Rescue', pledgePence: 280, donations: [expect.objectContaining({ transactionId: 'TX1234567' })] });
  });
  it('records a donation that completes after the pledge is removed', async () => {
    const report = await closeWithSale();
    await send('DELETE', '/api/owner/stall/charity');
    expect((await donate(report.sessionId)).statusCode).toBe(200);
    expect((await read()).charity.donations).toEqual([expect.objectContaining({ transactionId: 'TX1234567', amountPence: 280 })]);
  });
  it('refuses another stall\'s session, an open session and a session that never carried a pledge', async () => {
    const open = (await db.query<{ id: string }>("select id from trading_sessions where status='open' and stall_id=(select id from stalls where not is_demo)")).rows[0]!;
    await setCharity();
    expect((await donate(open.id)).statusCode).toBe(409);
    const report = await closeWithSale();
    const demo = { stallkeeper_owner: (await send('POST', '/api/owner/login', { password: 'demo' }, {})).cookies[0]!.value };
    const other = await send('POST', '/api/owner/closing/donation', { sessionId: report.sessionId, transactionId: 'TX7654321', status: 'Completed', amount: '1.00', currency: 'GBP' }, demo);
    expect(other.statusCode).toBe(409);
    await send('DELETE', '/api/owner/stall/charity');
    await repairClosings(db, new Date());
    expect((await send('POST', '/api/owner/stall/open')).statusCode).toBe(201);
    const unpledged = (await send('POST', '/api/owner/stall/close')).json();
    expect((await donate(unpledged.sessionId)).statusCode).toBe(409);
    expect((await db.query('select count(*)::int as n from charity_donations')).rows[0].n).toBe(0);
  });
  it('records at most 20 donations an hour for each stall, and a repeated transaction spends none of them', async () => {
    let time = new Date();
    await app.close();
    app = buildApp(config, { db, fetcher, model, now: () => time });
    const demo = { stallkeeper_owner: (await send('POST', '/api/owner/login', { password: 'demo' }, {})).cookies[0]!.value };
    owner = { stallkeeper_owner: (await send('POST', '/api/owner/login', { password: 'owner' }, {})).cookies[0]!.value };
    const report = await closeWithSale();
    const id = (n: number) => `TX${String(n).padStart(6, '0')}`;
    expect((await donate(report.sessionId, { transactionId: id(1) })).statusCode).toBe(200);
    for (let n = 1; n <= 20; n++) expect((await donate(report.sessionId, { transactionId: id(n) })).statusCode).toBe(200);
    const refused = await donate(report.sessionId, { transactionId: id(21) });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('Too many donations have been recorded this hour. Try again later. Your report is unchanged.');
    expect((await db.query('select count(*)::int as n from charity_donations')).rows[0].n).toBe(20);
    // The demo stall keeps its own allowance.
    await send('PUT', '/api/owner/stall/charity', { name: 'Garden Rescue', percent: 10 }, demo);
    if ((await send('POST', '/api/owner/stall/close', undefined, demo)).statusCode === 409) {
      await send('POST', '/api/owner/stall/open', undefined, demo);
      await send('POST', '/api/owner/stall/close', undefined, demo);
    }
    const demoSession = (await send('GET', '/api/owner/closing', undefined, demo)).json().closing.sessionId;
    expect((await send('POST', '/api/owner/closing/donation', { sessionId: demoSession, transactionId: 'TXDEMO01', status: 'Completed', amount: '1.00', currency: 'GBP' }, demo)).statusCode).toBe(200);
    time = new Date(time.getTime() + 3_600_001);
    expect((await donate(report.sessionId, { transactionId: id(21) })).statusCode).toBe(200);
    await send('DELETE', '/api/owner/stall/charity', undefined, demo);
  });
  it('calls no Payouts endpoint through a sale, closing and donation, and the donation calls PayPal not at all', async () => {
    const report = await closeWithSale();
    const beforeDonation = fetcher.mock.calls.length;
    expect(beforeDonation).toBeGreaterThan(0);
    expect((await donate(report.sessionId)).statusCode).toBe(200);
    await read();
    expect(fetcher.mock.calls).toHaveLength(beforeDonation);
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter(url => /payouts/i.test(url))).toEqual([]);
  });
  it('is never read by the AI summary, so a donation changes no summary key', async () => {
    const report = await closeWithSale();
    const { summaryKey } = await import('./closing-summary.js');
    const before = summaryKey(await read());
    await donate(report.sessionId);
    expect(summaryKey(await read())).toBe(before);
  });
});
