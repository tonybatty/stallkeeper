import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { buildApp } from './app.js';
import { allowedTools, toModelMessages } from './ledger-ai.js';
import { carryLastRead, runLedgerCheck, type PayPalCheck, type Toolkit } from './paypal-check.js';
import { testDatabase } from '../test/database.js';

const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173', aiLedgerDailyCapUsd: '1' };
const usage = { inputTokens: { total: 1000, noCache: 100, cacheRead: 800, cacheWrite: 100 }, outputTokens: { total: 100, text: 100, reasoning: undefined } };
const finish = { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage };
const textTurn = (text: string) => [{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't1' }, { type: 'text-delta' as const, id: 't1', delta: text.slice(0, 4) }, { type: 'text-delta' as const, id: 't1', delta: text.slice(4) }, { type: 'text-end' as const, id: 't1' }, finish];
const toolTurn = (name: string, input: string) => [{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-input-start' as const, id: 'c1', toolName: name }, { type: 'tool-input-delta' as const, id: 'c1', delta: input }, { type: 'tool-input-end' as const, id: 'c1' }, { type: 'tool-call' as const, toolCallId: 'c1', toolName: name, input }, { ...finish, finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' } }];

let app: ReturnType<typeof buildApp>;
let clock: Date;
let turn: ReturnType<typeof textTurn> | ReturnType<typeof toolTurn>;
let modelCalls: { prompt: unknown; tools?: unknown; maxOutputTokens?: number }[];
let owner: Record<string, string>;
let demo: Record<string, string>;
const login = async (password: string) => ({ stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password } })).cookies[0]!.value });
const data = (cookies = owner) => app.inject({ url: '/api/owner/ledger/data', cookies });
const ask = (payload: Record<string, unknown>, cookies = owner) => app.inject({ method: 'POST', url: '/api/owner/ledger/ai', cookies, payload });
const lines = (body: string) => body.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const question = { type: 'message', kind: 'input', role: 'user', content: [{ type: 'text', text: 'Is anything waiting on PayPal?' }], status: 'completed' };

async function stall(isDemo: boolean) { return (await db.query<{ id: string }>('select id from stalls where is_demo=$1', [isDemo])).rows[0]!.id; }
async function addItem(stallId: string, name: string, askingPence: number, code: string, mode = 'haggle') {
  return (await db.query<{ id: string }>("insert into items (stall_id,code,name,notes,mode,asking_pence) values ($1,$2,$3,'Tested, works. Private note about the bargain',$4,$5) returning id", [stallId, code, name, mode, askingPence])).rows[0]!.id;
}
async function openSession(stallId: string, opened: string, percent?: number) {
  return (await db.query<{ id: string }>("insert into trading_sessions (stall_id,opened_at,status,cutoff_at,closed_at,charity_name,charity_percent) values ($1,$2,'closed',$2,$2,$3,$4) returning id", [stallId, opened, percent ? 'Garden Rescue' : null, percent ?? null])).rows[0]!.id;
}
let sequence = 0;
async function sale(stallId: string, sessionId: string, itemId: string, amountPence: number, extra: { review?: boolean; state?: string; captureStatus?: string; verified?: boolean; orderId?: string; kind?: string } = {}) {
  sequence += 1;
  const buyer = (await db.query<{ id: string }>('insert into buyer_sessions (token_hash) values ($1) returning id', [`hash-${sequence}`])).rows[0]!.id;
  const item = (await db.query<{ code: string; name: string; asking_pence: number }>('select code,name,asking_pence from items where id=$1', [itemId])).rows[0]!;
  const checkout = (await db.query<{ id: string }>(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,paypal_order_id,reservation_deadline,review_required,kind)
    values ($1,$2,$3,$8,$4,$5,gen_random_uuid(),gen_random_uuid(),$6,now(),$7,$9) returning id`, [stallId, sessionId, buyer, amountPence, `key-${sequence}`, extra.orderId ?? `ORDER${sequence}`, extra.review ?? false, extra.state ?? 'paid', extra.kind ?? 'sale'])).rows[0]!.id;
  await db.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) values ($1,$2,$3,$4,$5,$6)', [checkout, itemId, item.code, item.name, item.asking_pence, amountPence]);
  const captureId = `CAPTURE${sequence}`;
  await db.query("insert into captures (paypal_capture_id,checkout_id,amount_pence,currency,status,captured_at,webhook_verified_at) values ($1,$2,$3,'GBP',$4,$5,$6)", [captureId, checkout, amountPence, extra.captureStatus ?? 'COMPLETED', clock, extra.verified === false ? null : clock]);
  return { checkout, captureId };
}

beforeEach(async () => {
  await db.query('truncate paypal_order_reads, charity_donations, closings, offers, offer_cards, chat_messages, item_floors, refunds, captures, checkout_lines, events, checkouts, items, trading_sessions, buyer_sessions, ai_usage cascade');
  clock = new Date('2026-11-07T12:00:00Z'); sequence = 0; modelCalls = []; turn = textTurn('Nothing is waiting.');
  const model = new MockLanguageModelV4({ doStream: async options => {
    modelCalls.push({ prompt: options.prompt, tools: options.tools, maxOutputTokens: options.maxOutputTokens });
    return { stream: convertArrayToReadableStream(turn) };
  } });
  app = buildApp(config, { db, model, now: () => clock });
  owner = await login('owner'); demo = await login('demo');
});
afterEach(async () => app.close());

describe('owner gate', () => {
  it('answers 401 to every ledger route when logged out', async () => {
    expect((await app.inject({ url: '/api/owner/ledger/data' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/owner/ledger/config' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/owner/ledger/ai', payload: { input: [] } })).statusCode).toBe(401);
    expect(modelCalls).toHaveLength(0);
  });
  it('keeps each stall to its own rows', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500);
    expect((await data()).json().ledger).toHaveLength(1);
    const other = (await data(demo)).json();
    expect(other.ledger).toEqual([]);
    expect(JSON.stringify(other)).not.toContain('Brass lamp');
  });
});

describe('what the page may see', () => {
  it('leaves floors, notes, chat and buyer ids out of the data', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    const lamp = await addItem(main, 'Brass lamp', 2500, 'BRSS');
    await db.query('insert into item_floors values ($1,1737)', [lamp]);
    const { checkout } = await sale(main, session, lamp, 2200);
    const buyer = (await db.query<{ buyer_session_id: string }>('select buyer_session_id from checkouts where id=$1', [checkout])).rows[0]!.buyer_session_id;
    const message = (await db.query<{ id: string }>("insert into chat_messages (buyer_session_id,item_id,role,content) values ($1,$2,'user','Does the chat text leak?') returning id", [buyer, lamp])).rows[0]!.id;
    const offer = (await db.query<{ id: string }>("insert into offers (item_id,buyer_session_id,message_id,round,amount_pence,outcome) values ($1,$2,$3,1,2000,'counter') returning id", [lamp, buyer, message])).rows[0]!.id;
    await db.query("insert into offer_cards (offer_id,item_id,buyer_session_id,amount_pence,price_version,expires_at,status,agreed_at) values ($1,$2,$3,2200,1,now(),'agreed',now())", [offer, lamp, buyer]);
    const body = (await data()).body;
    expect(body).not.toMatch(/floor/i);
    expect(body).not.toContain('17.37');
    expect(body).not.toContain('1737');
    expect(body).not.toContain('Private note');
    expect(body).not.toContain('chat text');
    expect(body).not.toContain(buyer);
    expect(body).not.toContain('hash-');
    expect(JSON.parse(body).offers[0]).toMatchObject({ item: 'Brass lamp', offered: 20, outcome: 'Countered', card: 22, cardStatus: 'Agreed', agreed: true });
  });
  it('sends no PayPal capture, refund, order or transaction id, even as a row id', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    const { captureId } = await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'ORDERPAID' });
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { review: true, captureStatus: 'PENDING', orderId: 'ORDERFLAGGED' });
    await db.query("insert into refunds values ('REFUND1',$1,700,'COMPLETED',$2)", [captureId, clock]);
    await db.query("insert into charity_donations values ('DONATE1',$1,300,'GBP',$2)", [session, clock]);
    const response = await data();
    expect(response.json().ledger).toHaveLength(4);
    for (const id of [captureId, 'ORDERPAID', 'ORDERFLAGGED', 'REFUND1', 'DONATE1']) expect(response.body).not.toContain(id);
  });
  it('keeps row ids the same between reads, so a live update changes rows rather than replacing them', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500);
    expect((await data()).json().ledger[0].id).toBe((await data()).json().ledger[0].id);
  });
  it('sends money as numbers in pounds and keeps the seeded mark', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    const lamp = await addItem(main, 'Brass lamp', 2500, 'BRSS');
    await db.query('update items set seeded=true where id=$1', [lamp]);
    await sale(main, session, lamp, 2200);
    const row = (await data()).json().ledger[0];
    expect(row).toMatchObject({ kind: 'Sale', asking: 25, amount: 22, recordedSales: 22, discount: 3, seeded: true, priceSource: 'Listed price', code: 'BRSS' });
    expect((await data()).json().items[0]).toMatchObject({ name: 'Brass lamp', asking: 25, seeded: true, status: 'Available' });
  });
});

describe('agreement with the closing report', () => {
  it('matches recorded sales through a partial refund and keeps a donation out of the sum', async () => {
    const main = await stall(false);
    await db.query("update stalls set charity_name='Garden Rescue',charity_percent=10 where id=$1", [main]);
    const session = await openSession(main, '2026-11-07T09:00:00Z', 10);
    const first = await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500);
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999);
    await db.query("insert into refunds values ('REFUND1',$1,700,'COMPLETED',$2)", [first.captureId, clock]);
    await db.query("insert into charity_donations values ('DONATE1',$1,300,'GBP',$2)", [session, clock]);
    const report = (await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing;
    const { ledger, sessions } = (await data()).json();
    expect(report.recordedSalesPence).toBe(3799);
    expect(sessions[0]).toMatchObject({ recordedSales: 37.99, sales: 2, pledged: report.charity.pledgePence / 100, donated: 3, charity: 'Garden Rescue', charityPercent: 10 });
    expect(ledger.map((row: { kind: string }) => row.kind).sort()).toEqual(['Donation', 'Refund', 'Sale', 'Sale']);
    const refund = ledger.find((row: { kind: string }) => row.kind === 'Refund');
    expect(refund).toMatchObject({ amount: -7, recordedSales: -7, item: 'Brass lamp' });
    const donation = ledger.find((row: { kind: string }) => row.kind === 'Donation');
    expect(donation).toMatchObject({ amount: 3, recordedSales: 0, status: 'Reported by Donate button' });
    const sum = ledger.reduce((total: number, row: { recordedSales: number }) => total + Math.round(row.recordedSales * 100), 0);
    expect(sum).toBe(report.recordedSalesPence);
  });
  it('leaves a fully refunded sale out of recorded sales and items sold', async () => {
    const main = await stall(false);
    const session = await openSession(main, '2026-11-07T09:00:00Z');
    const paid = await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500);
    await db.query("insert into refunds values ('REFUND1',$1,2500,'COMPLETED',$2)", [paid.captureId, new Date('2026-11-07T15:00:00Z')]);
    const report = (await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing;
    const { ledger, sessions } = (await data()).json();
    expect(report).toMatchObject({ recordedSalesPence: 0, paidCheckouts: 1, itemsSold: 0 });
    expect(sessions[0]).toMatchObject({ recordedSales: 0, sales: report.itemsSold });
    expect(ledger.find((row: { kind: string }) => row.kind === 'Sale')).toMatchObject({ recordedSales: 25, refundedInFull: true, hour: '12:00' });
    expect(ledger.find((row: { kind: string }) => row.kind === 'Refund')).toMatchObject({ recordedSales: -25, hour: '12:00', at: '2026-11-07T15:00:00.000Z' });
  });
  it('keeps a partly refunded sale as sold, and clears its review as the closing report does', async () => {
    const main = await stall(false);
    const session = await openSession(main, '2026-11-07T09:00:00Z');
    const paid = await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { review: true });
    await db.query("insert into refunds values ('REFUND1',$1,700,'COMPLETED',$2)", [paid.captureId, clock]);
    const report = (await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing;
    const { ledger, sessions } = (await data()).json();
    expect(report).toMatchObject({ recordedSalesPence: 1800, itemsSold: 1 });
    expect(sessions[0]).toMatchObject({ recordedSales: 18, sales: 1 });
    expect(ledger.find((row: { kind: string }) => row.kind === 'Sale')).toMatchObject({ refundedInFull: false });
    expect(ledger.find((row: { kind: string }) => row.kind === 'Sale').status).not.toBe('Needs review');
  });
  it('counts a tip in recorded sales but not as a sale, with no discount off the suggested tip', async () => {
    const main = await stall(false);
    const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Box of cookbooks', 500, 'FREE', 'free'), 200, { kind: 'tip' });
    const report = (await app.inject({ url: '/api/owner/closing', cookies: owner })).json().closing;
    const { ledger, sessions, items } = (await data()).json();
    expect(report).toMatchObject({ recordedSalesPence: 200, paidCheckouts: 0, itemsSold: 0, tipsPence: 200 });
    expect(sessions[0]).toMatchObject({ recordedSales: 2, sales: report.paidCheckouts });
    expect(ledger).toEqual([expect.objectContaining({ kind: 'Tip', mode: 'Free', priceSource: "Buyer's amount", amount: 2, recordedSales: 2, discount: 0 })]);
    expect(items[0]).toMatchObject({ mode: 'Free' });
  });
  it('carries every session\'s sale and offer, and lists only sessions that have a row, newest first', async () => {
    const main = await stall(false);
    const first = await openSession(main, '2026-11-06T09:00:00Z');
    const lamp = await addItem(main, 'Brass lamp', 2500, 'BRSS');
    const { checkout } = await sale(main, first, lamp, 2200);
    const buyer = (await db.query<{ buyer_session_id: string }>('select buyer_session_id from checkouts where id=$1', [checkout])).rows[0]!.buyer_session_id;
    const message = (await db.query<{ id: string }>("insert into chat_messages (buyer_session_id,item_id,role,content) values ($1,$2,'user','Would you take 20?') returning id", [buyer, lamp])).rows[0]!.id;
    await db.query("insert into offers (item_id,buyer_session_id,message_id,round,amount_pence,outcome,created_at) values ($1,$2,$3,1,2000,'counter','2026-11-06T10:00:00Z')", [lamp, buyer, message]);
    const second = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, second, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999);
    const emptyBeforeAll = await openSession(main, '2026-11-05T09:00:00Z');
    const emptyAfter = await openSession(main, '2026-11-07T11:00:00Z');
    const body = (await data()).json();
    expect(body).not.toHaveProperty('defaultSessionId');
    expect(body.ledger.map((row: { sessionId: string }) => row.sessionId)).toEqual([first, second]);
    expect(body.offers).toEqual([expect.objectContaining({ sessionId: first, item: 'Brass lamp' })]);
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([second, first]);
    expect(body.sessions.map((session: { id: string }) => session.id)).not.toContain(emptyAfter);
    expect(body.sessions.map((session: { id: string }) => session.id)).not.toContain(emptyBeforeAll);
  });
  it('lists a session whose only row is an offer, a payment to check or a tip', async () => {
    const main = await stall(false);
    const checking = await openSession(main, '2026-11-06T09:00:00Z');
    await sale(main, checking, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { state: 'checking', captureStatus: 'PENDING' });
    const tipped = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, tipped, await addItem(main, 'Box of cookbooks', 500, 'FREE', 'free'), 200, { kind: 'tip' });
    const body = (await data()).json();
    expect(body.ledger.find((row: { sessionId: string }) => row.sessionId === checking)).toMatchObject({ kind: 'Payment to check', recordedSales: 0 });
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([tipped, checking]);
  });
  it('keeps two sessions opened in the same minute apart, because every session filter and chart groups on the label', async () => {
    const main = await stall(false);
    const first = await openSession(main, '2026-11-07T09:00:05Z');
    await sale(main, first, await addItem(main, 'Brass lamp', 1000, 'BRSS'), 1000);
    const second = await openSession(main, '2026-11-07T09:00:40Z');
    await sale(main, second, await addItem(main, 'Carriage clock', 1400, 'CKCK'), 1400);
    const { sessions } = (await data()).json();
    expect(sessions.map((session: { label: string }) => session.label)).toEqual(['Sat 7 Nov, 09:00 (2)', 'Sat 7 Nov, 09:00']);
  });
  it('numbers a repeated label only among listed sessions, so an empty twin left out leaves no gap', async () => {
    const main = await stall(false);
    await openSession(main, '2026-11-07T09:00:05Z');
    const traded = await openSession(main, '2026-11-07T09:00:40Z');
    await sale(main, traded, await addItem(main, 'Brass lamp', 1000, 'BRSS'), 1000);
    const { sessions } = (await data()).json();
    expect(sessions).toEqual([expect.objectContaining({ id: traded, label: 'Sat 7 Nov, 09:00' })]);
  });
  it('has an empty report for a stall that never opened', async () => {
    expect((await data()).json()).toMatchObject({ sessions: [], ledger: [], offers: [] });
  });
});

describe('PayPal status per row', () => {
  it('shows a flagged payment as Needs review, even with no completed capture', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { review: true });
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { review: true, captureStatus: 'PENDING' });
    const { ledger, sessions } = (await data()).json();
    expect(ledger.map((row: { status: string }) => row.status)).toEqual(['Needs review', 'Needs review']);
    expect(ledger.find((row: { item: string }) => row.item === 'Carriage clock')).toMatchObject({ kind: 'Payment to check', recordedSales: 0, capture: 'No completed capture' });
    expect(sessions[0].recordedSales).toBe(25);
  });
  it('lists a payment PayPal is still settling, with no recorded sales, so nothing unresolved goes missing', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { state: 'checking', captureStatus: 'PENDING' });
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { state: 'capturing', captureStatus: 'PENDING' });
    await sale(main, session, await addItem(main, 'Tea set', 1500, 'TEAS'), 1500, { state: 'failed', captureStatus: 'PENDING' });
    await sale(main, session, await addItem(main, 'Mirror', 1200, 'MRRR'), 1200, { state: 'awaiting_approval', captureStatus: 'PENDING' });
    const { ledger, sessions } = (await data()).json();
    expect(ledger.map((row: { item: string }) => row.item)).toEqual(expect.arrayContaining(['Brass lamp', 'Carriage clock']));
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ kind: 'Payment to check', status: 'Capture pending', capture: 'No completed capture', recordedSales: 0 });
    expect(sessions[0]).toMatchObject({ recordedSales: 0, sales: 0 });
  });
  it('does not list a settling payment twice once its capture completes', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { state: 'checking' });
    expect((await data()).json().ledger.map((row: { kind: string }) => row.kind)).toEqual(['Sale']);
  });
  describe('what a stored PayPal check says about a row', () => {
    const order = (orderId: string, outcome: string) => ({ orderId, outcome, codes: '', inSession: true, unresolved: false, localNetPence: 0, paypalNetPence: 0, note: '' });
    const store = async (session: string, at: string, orders: ReturnType<typeof order>[]) => {
      const closing = (await db.query<{ id: string }>('insert into closings (trading_session_id) values ($1) returning id', [session])).rows[0]!.id;
      await db.query('update closings set paypal_check=$2 where id=$1', [closing, JSON.stringify({ checkedAt: at, orders, transactions: { status: 'unavailable', note: 'Not run.' } })]);
    };
    it('does not call an order with no capture on either side a difference', async () => {
      const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
      await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { review: true, captureStatus: 'PENDING', orderId: 'NONE' });
      await store(session, clock.toISOString(), [order('NONE', 'no_capture')]);
      expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'No capture at PayPal', status: 'Needs review' });
    });
    it('says a failed read did not read PayPal', async () => {
      const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
      await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'FAILED' });
      await store(session, clock.toISOString(), [order('FAILED', 'unreadable')]);
      expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'PayPal not read', status: 'Confirmed by PayPal' });
    });
    it('keeps the last verdict through a failed read, and takes a later verdict', async () => {
      const main = await stall(false); const first = await openSession(main, '2026-11-06T09:00:00Z'); const second = await openSession(main, '2026-11-07T09:00:00Z');
      const third = await openSession(main, '2026-11-08T09:00:00Z');
      await sale(main, first, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'READ' });
      await store(first, '2026-11-06T18:00:00.000Z', [order('READ', 'agrees')]);
      await store(second, '2026-11-07T18:00:00.000Z', [order('READ', 'unreadable')]);
      expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'PayPal agrees', status: 'PayPal agrees' });
      await store(third, '2026-11-08T18:00:00.000Z', [order('READ', 'differs')]);
      expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'PayPal differs', status: 'PayPal differs' });
    });
    it.each(['capture_not_recorded', 'capture_pending', 'no_capture'])('drops a %s read once the capture is recorded, on the sale and its refund', async outcome => {
      const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
      const { captureId } = await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'LANDED' });
      await db.query("insert into refunds values ('REFUND1',$1,700,'COMPLETED',$2)", [captureId, clock]);
      await store(session, clock.toISOString(), [order('LANDED', outcome)]);
      const { ledger } = (await data()).json();
      expect(ledger.find((row: { kind: string }) => row.kind === 'Sale')).toMatchObject({ capture: 'Capture recorded', paypalCheck: 'Not checked yet', status: 'Confirmed by PayPal' });
      expect(ledger.find((row: { kind: string }) => row.kind === 'Refund')).toMatchObject({ capture: 'Refund recorded', paypalCheck: 'Not checked yet', status: 'Refund recorded' });
    });
    it('flags a settling payment that PayPal shows as captured', async () => {
      const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
      await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { state: 'checking', captureStatus: 'PENDING', orderId: 'SETTLED' });
      await store(session, clock.toISOString(), [order('SETTLED', 'capture_not_recorded')]);
      expect((await data()).json().ledger[0]).toMatchObject({ kind: 'Payment to check', status: 'PayPal differs' });
    });
  });
  it('reads webhook state and the stored check, newest first', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'AGREES' });
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { orderId: 'DIFFERS' });
    await sale(main, session, await addItem(main, 'Tea set', 1500, 'TEAS'), 1500, { verified: false });
    await sale(main, session, await addItem(main, 'Mirror', 1200, 'MRRR'), 1200);
    await sale(main, session, await addItem(main, 'Film camera', 3900, 'FMCM'), 3900, { orderId: 'READ_EARLY', verified: false });
    const closing = (await db.query<{ id: string }>('insert into closings (trading_session_id) values ($1) returning id', [session])).rows[0]!.id;
    const order = (orderId: string, outcome: string) => ({ orderId, outcome, codes: '', inSession: true, unresolved: false, localNetPence: 0, paypalNetPence: 0, note: '' });
    await db.query('update closings set paypal_check=$2 where id=$1', [closing, JSON.stringify({ checkedAt: clock.toISOString(), orders: [order('AGREES', 'agrees'), order('DIFFERS', 'differs'), order('READ_EARLY', 'agrees')], transactions: { status: 'unavailable', note: 'PayPal refused transaction listing for this app, so this cross-check did not run.' } })]);
    const body = (await data()).json();
    const status = Object.fromEntries(body.ledger.map((row: { item: string; status: string }) => [row.item, row.status]));
    // PayPal's own read settles a row whose webhook has not arrived, so the check stamp cannot wait on an order PayPal agreed.
    expect(status).toEqual({ 'Brass lamp': 'PayPal agrees', 'Carriage clock': 'PayPal differs', 'Tea set': 'Waiting for PayPal to confirm', Mirror: 'Confirmed by PayPal', 'Film camera': 'PayPal agrees' });
    expect(body.ledger.find((row: { item: string }) => row.item === 'Film camera')).toMatchObject({ webhook: 'Waiting for PayPal to confirm', paypalCheck: 'PayPal agrees' });
    expect(body.ledger.find((row: { item: string }) => row.item === 'Mirror')).toMatchObject({ paypalCheck: 'Not checked yet', webhook: 'Confirmed by PayPal', capture: 'Capture recorded' });
    // A check stored before the wording changed still reads in the current wording.
    expect(body.paypalCheck.transactionList).toEqual({ ran: false, checkedAt: clock.toISOString(), note: "In the closing check on 7 Nov, 12:00, PayPal's transaction list was not read: PayPal refused it for this app." });
    expect(JSON.stringify(body)).not.toContain('Transaction Search');
  });
  it('says the transaction list has not been read before any check', async () => {
    expect((await data()).json().paypalCheck).toEqual({ checkedAt: null, transactionList: { ran: false, checkedAt: null, note: "PayPal's transaction list has not been read. The closing page's check reads it." } });
  });
  // An old closing check's line once read as current, dated by a ledger order read made days later.
  it('dates the transaction line by its own closing check, not by a later order read', async () => {
    const main = await stall(false);
    const store = async (opened: string, checkedAt: string, transactions: object) => {
      const closing = (await db.query<{ id: string }>('insert into closings (trading_session_id) values ($1) returning id', [await openSession(main, opened)])).rows[0]!.id;
      await db.query('update closings set paypal_check=$2 where id=$1', [closing, JSON.stringify({ checkedAt, orders: [], transactions })]);
    };
    await store('2026-11-07T09:00:00Z', '2026-11-07T19:13:49.000Z', { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal refused it for this app." });
    await db.query("insert into paypal_order_reads (stall_id,paypal_order_id,outcome,read_at) values ($1,'LATER','agrees','2026-11-12T03:26:34.488Z')", [main]);
    expect((await data()).json().paypalCheck).toEqual({ checkedAt: '2026-11-12T03:26:34.488Z',
      transactionList: { ran: false, checkedAt: '2026-11-07T19:13:49.000Z', note: "In the closing check on 7 Nov, 19:13, PayPal's transaction list was not read: PayPal refused it for this app." } });
    for (const stored of ["PayPal's transaction list was not read: PayPal could not list it just now.", 'PayPal could not list transactions just now, so this cross-check did not run.']) {
      await store('2026-11-08T09:00:00Z', '2026-11-08T10:42:00.000Z', { status: 'unavailable', note: stored });
      expect((await data()).json().paypalCheck.transactionList).toEqual({ ran: false, checkedAt: '2026-11-08T10:42:00.000Z', note: "In the closing check on 8 Nov, 10:42, PayPal's transaction list was not read: PayPal could not list it at the time." });
      await db.query("delete from closings where paypal_check->>'checkedAt'='2026-11-08T10:42:00.000Z'");
    }
    await store('2026-11-12T09:00:00Z', '2026-11-12T09:00:22.135Z', { status: 'ran', listed: 1, missing: 0, note: 'PayPal can take a few hours to list a new transaction, so a missing one is not a difference on its own.' });
    expect((await data()).json().paypalCheck).toEqual({ checkedAt: '2026-11-12T09:00:22.135Z',
      transactionList: { ran: true, checkedAt: '2026-11-12T09:00:22.135Z', note: "PayPal's transaction list was read in the closing check on 12 Nov, 09:00. PayPal can take a few hours to list a new transaction, so a missing one is not a difference on its own." } });
  });
});

describe('the ledger PayPal check', () => {
  const paypalOrder = (id: string, value: string) => JSON.stringify({ id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: `CAP-${id}`, status: 'COMPLETED', amount: { currency_code: 'GBP', value } }] } }] });
  const refused = JSON.stringify({ ok: false, status: 500, code: 'PAYPAL_API_HTTP_ERROR', message: 'Internal error.' });
  let answers: Record<string, string>;
  let built: number;
  let getOrder: ReturnType<typeof vi.fn>;
  const press = () => app.inject({ method: 'POST', url: '/api/owner/ledger/paypal-check', cookies: owner });
  const rows = async () => Object.fromEntries((await data()).json().ledger.filter((row: { kind: string }) => row.kind === 'Sale').map((row: { code: string; paypalCheck: string }) => [row.code, row.paypalCheck]));
  beforeEach(async () => {
    answers = {}; built = 0;
    getOrder = vi.fn(async (args: Record<string, unknown>) => answers[String(args.id)] ?? refused);
    await app.close();
    // Counting each build shows when a press never constructs the toolkit, and so never reaches PayPal.
    app = buildApp(config, { db, now: () => clock, toolkit: new Proxy({}, { get: (_target, name) => { if (name === 'get_order') { built += 1; return { execute: getOrder }; } return undefined; } }) as never });
    owner = await login('owner');
  });

  it('reads every captured order across closed sessions in one press, and stores what PayPal said', async () => {
    const main = await stall(false);
    const first = await openSession(main, '2026-11-05T09:00:00Z'); const second = await openSession(main, '2026-11-06T09:00:00Z');
    await sale(main, first, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'FIRST' });
    await sale(main, second, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { orderId: 'SECOND' });
    answers = { FIRST: paypalOrder('FIRST', '25.00'), SECOND: paypalOrder('SECOND', '19.99') };
    expect(await rows()).toEqual({ BRSS: 'Not checked yet', CKCK: 'Not checked yet' });
    const before = (await db.query('select (select count(*) from captures) as captures,(select count(*) from checkouts) as checkouts,(select string_agg(state,\',\') from checkouts) as states')).rows[0];
    const response = await press();
    expect(response.statusCode).toBe(200);
    expect(response.json().paypalCheck).toMatchObject({ sent: 2, read: 2, agree: 2, differ: 0, notRead: 0, left: 0, note: 'PayPal read 2 orders: 2 agree with the record.',
      orders: [{ codes: 'BRSS', outcome: 'agrees' }, { codes: 'CKCK', outcome: 'agrees' }] });
    expect(response.body).not.toContain('FIRST');
    expect(getOrder.mock.calls.map(call => call[0])).toEqual([{ id: 'FIRST' }, { id: 'SECOND' }]);
    expect(await rows()).toEqual({ BRSS: 'PayPal agrees', CKCK: 'PayPal agrees' });
    expect((await data()).json().paypalCheck.checkedAt).toBe(clock.toISOString());
    expect((await db.query('select (select count(*) from captures) as captures,(select count(*) from checkouts) as checkouts,(select string_agg(state,\',\') from checkouts) as states')).rows[0]).toEqual(before);
  });
  it('makes no PayPal call when nothing is left to read, and says so', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    expect((await press()).json().paypalCheck).toMatchObject({ sent: 0, note: 'There are no captured orders to read, so nothing was sent to PayPal.' });
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'DONE' });
    answers = { DONE: paypalOrder('DONE', '25.00') };
    await press();
    getOrder.mockClear(); built = 0;
    expect((await press()).json().paypalCheck).toMatchObject({ sent: 0, read: 0, note: 'Every captured order already has a PayPal read, so nothing was sent to PayPal.' });
    expect(built).toBe(0);
    expect(getOrder).not.toHaveBeenCalled();
  });
  it('leaves an order the closing check already read, and an unconfirmed payment, to the closing check', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'CLOSED' });
    await sale(main, session, await addItem(main, 'Tea set', 1500, 'TEAS'), 1500, { orderId: 'PENDING', state: 'checking', captureStatus: 'PENDING' });
    const closing = (await db.query<{ id: string }>('insert into closings (trading_session_id) values ($1) returning id', [session])).rows[0]!.id;
    await db.query('update closings set paypal_check=$2 where id=$1', [closing, JSON.stringify({ checkedAt: clock.toISOString(), orders: [{ orderId: 'CLOSED', outcome: 'agrees' }], transactions: { status: 'unavailable', note: 'Not run.' } })]);
    expect((await press()).json().paypalCheck).toMatchObject({ sent: 0 });
    expect(getOrder).not.toHaveBeenCalled();
  });
  it('stores a difference, so the row needs a look', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'OFF' });
    answers = { OFF: paypalOrder('OFF', '20.00') };
    expect((await press()).json().paypalCheck).toMatchObject({ read: 1, agree: 0, differ: 1, note: 'PayPal read 1 order: 0 agree with the record, 1 differs.' });
    expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'PayPal differs', status: 'PayPal differs' });
  });
  it('reads at most 40 orders a press, and the next press reads the rest', async () => {
    const tagChars = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    for (let index = 0; index < 41; index += 1) {
      const orderId = `MANY${String(index).padStart(2, '0')}`;
      answers[orderId] = paypalOrder(orderId, '1.00');
      clock = new Date(Date.parse('2026-11-07T10:00:00Z') + index * 60_000);
      await sale(main, session, await addItem(main, `Item ${index}`, 100, `MQ${tagChars[Math.floor(index / tagChars.length)]!}${tagChars[index % tagChars.length]!}`), 100, { orderId });
    }
    const first = (await press()).json().paypalCheck;
    expect(first).toMatchObject({ sent: 40, read: 40, agree: 40, left: 1 });
    expect(first.note).toContain('1 more order is left to read, because one check reads at most 40. Check again to read them.');
    expect(getOrder).toHaveBeenCalledTimes(40);
    expect(getOrder).not.toHaveBeenCalledWith({ id: 'MANY40' }, expect.anything());
    getOrder.mockClear();
    expect((await press()).json().paypalCheck).toMatchObject({ sent: 1, read: 1, left: 0 });
    expect(getOrder.mock.calls.map(call => call[0])).toEqual([{ id: 'MANY40' }]);
  });
  it('keeps earlier results when a PayPal read fails, and tries the unread order again next time', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'GOOD' });
    answers = { GOOD: paypalOrder('GOOD', '25.00') };
    await press();
    const stored = (await db.query('select * from paypal_order_reads')).rows;
    await sale(main, session, await addItem(main, 'Carriage clock', 1999, 'CKCK'), 1999, { orderId: 'DOWN' });
    clock = new Date('2026-11-07T13:00:00Z');
    expect((await press()).json().paypalCheck).toMatchObject({ sent: 1, read: 0, notRead: 1, note: 'PayPal could not be read just now. 1 order was not read this time, so earlier results stand.' });
    expect((await db.query('select * from paypal_order_reads')).rows).toEqual(stored);
    expect(await rows()).toEqual({ BRSS: 'PayPal agrees', CKCK: 'Not checked yet' });
    answers.DOWN = paypalOrder('DOWN', '19.99');
    getOrder.mockClear();
    await press();
    expect(getOrder.mock.calls.map(call => call[0])).toEqual([{ id: 'DOWN' }]);
    expect(await rows()).toEqual({ BRSS: 'PayPal agrees', CKCK: 'PayPal agrees' });
  });
  describe('a closing check that could not read an order', () => {
    let closing: string;
    const check = (checkedAt: string, outcome: string) => ({ checkedAt, localSalesPence: 2500, paypalSalesPence: null, totalsAgree: null, totalsNote: null, ordersSkipped: 0,
      orders: [{ orderId: 'SETTLING', codes: 'BRSS', inSession: true, unresolved: false, outcome, localNetPence: 2500, paypalNetPence: null, note: '' }],
      transactions: { status: 'unavailable', note: 'Not run.' } }) as PayPalCheck;
    const storeCheck = (stored: PayPalCheck) => db.query('update closings set paypal_check=$2 where id=$1', [closing, JSON.stringify(stored)]);
    beforeEach(async () => {
      const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
      await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'SETTLING' });
      closing = (await db.query<{ id: string }>('insert into closings (trading_session_id) values ($1) returning id', [session])).rows[0]!.id;
    });

    it('carries the time PayPal was last read, even when carried twice', () => {
      const first = check('2026-11-07T12:00:00.000Z', 'agrees');
      const second = carryLastRead(check('2026-11-07T13:00:00.000Z', 'unreadable'), first);
      const third = carryLastRead(check('2026-11-07T14:00:00.000Z', 'unreadable'), second);
      expect(second.orders[0]).toMatchObject({ outcome: 'unreadable', lastRead: 'agrees', lastReadAt: '2026-11-07T12:00:00.000Z' });
      expect(third.orders[0]).toMatchObject({ outcome: 'unreadable', lastRead: 'agrees', lastReadAt: '2026-11-07T12:00:00.000Z' });
    });
    it('keeps a newer ledger read over an older read the closing check carries', async () => {
      const first = check('2026-11-07T12:00:00.000Z', 'capture_pending');
      await storeCheck(first);
      answers = { SETTLING: paypalOrder('SETTLING', '25.00') };
      clock = new Date('2026-11-07T13:00:00Z');
      expect((await press()).json().paypalCheck).toMatchObject({ sent: 1, read: 1, agree: 1 });
      await storeCheck(carryLastRead(check('2026-11-07T14:00:00.000Z', 'unreadable'), first));
      clock = new Date('2026-11-07T15:00:00Z');
      expect(await rows()).toEqual({ BRSS: 'PayPal agrees' });
      getOrder.mockClear();
      expect((await press()).json().paypalCheck).toMatchObject({ sent: 0 });
      expect(getOrder).not.toHaveBeenCalled();
    });
    it('keeps a newer closing read it carries over an older ledger read', async () => {
      answers = { SETTLING: paypalOrder('SETTLING', '20.00') };
      clock = new Date('2026-11-07T12:00:00Z');
      expect((await press()).json().paypalCheck).toMatchObject({ read: 1, differ: 1 });
      const second = check('2026-11-07T13:00:00.000Z', 'agrees');
      await storeCheck(second);
      await storeCheck(carryLastRead(check('2026-11-07T14:00:00.000Z', 'unreadable'), second));
      expect((await data()).json().ledger[0]).toMatchObject({ paypalCheck: 'PayPal agrees', status: 'PayPal agrees' });
    });
    it('lets a carried read from an older stored check fill an order with no other read, but not beat a timed one', async () => {
      await storeCheck({ ...check('2026-11-07T14:00:00.000Z', 'unreadable'), orders: [{ ...check('', 'unreadable').orders[0]!, lastRead: 'agrees' }] });
      expect(await rows()).toEqual({ BRSS: 'PayPal agrees' });
      await db.query("insert into paypal_order_reads (stall_id,paypal_order_id,outcome,read_at) values ($1,'SETTLING','differs','2026-11-07T10:00:00Z')", [await stall(false)]);
      expect(await rows()).toEqual({ BRSS: 'PayPal differs' });
    });
  });
  it('starts no read once the press deadline has passed, and leaves those orders unread', async () => {
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500, { orderId: 'LATE' });
    answers = { LATE: paypalOrder('LATE', '25.00') };
    const toolkit = () => ({ get_order: { execute: getOrder }, list_transactions: { execute: vi.fn() } }) as unknown as Toolkit;
    const result = await runLedgerCheck(db, toolkit, { stallId: main, now: clock, deadlineMs: 0 });
    expect(result).toMatchObject({ sent: 1, read: 0, notRead: 1, note: 'PayPal could not be read just now. 1 order was not read this time, so earlier results stand.' });
    expect(getOrder).not.toHaveBeenCalled();
    expect(await rows()).toEqual({ BRSS: 'Not checked yet' });
  });
  it('answers 502 without touching the ledger when the toolkit cannot be built', async () => {
    await app.close();
    app = buildApp(config, { db, now: () => clock, toolkit: new Proxy({}, { get: () => { throw new Error('no credentials'); } }) as never });
    owner = await login('owner');
    const main = await stall(false); const session = await openSession(main, '2026-11-07T09:00:00Z');
    await sale(main, session, await addItem(main, 'Brass lamp', 2500, 'BRSS'), 2500);
    const response = await press();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'The PayPal check could not run just now. The ledger is unaffected.' });
    expect((await db.query('select count(*)::integer as n from paypal_order_reads')).rows[0]).toEqual({ n: 0 });
  });
  it('is for the logged-in owner only', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/owner/ledger/paypal-check' })).statusCode).toBe(401);
    expect(getOrder).not.toHaveBeenCalled();
  });
});

describe('licence key and config', () => {
  it('gives the key to owner sessions, the demo owner included, and keeps it out of public config', async () => {
    await app.close();
    app = buildApp({ ...config, agStudioLicenceKey: 'test-licence-key' }, { db, now: () => clock });
    owner = await login('owner'); demo = await login('demo');
    expect((await app.inject({ url: '/api/owner/ledger/config', cookies: owner })).json().licenceKey).toBe('test-licence-key');
    expect((await app.inject({ url: '/api/owner/ledger/config', cookies: demo })).json().licenceKey).toBe('test-licence-key');
    expect((await app.inject({ url: '/api/owner/ledger/config' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/config' })).body).not.toContain('test-licence-key');
    expect((await app.inject({ url: '/api/demo' })).body).not.toContain('test-licence-key');
  });
  it('works with no key and reports the clerk as off with no model', async () => {
    await app.close();
    app = buildApp(config, { db, now: () => clock });
    owner = await login('owner');
    expect((await app.inject({ url: '/api/owner/ledger/config', cookies: owner })).json()).toEqual({ licenceKey: null, aiEnabled: false });
    expect((await ask({ input: [question] })).statusCode).toBe(503);
  });
  it.each(['1,5', '-1'])('refuses to start on a ledger cap of %s', value => {
    expect(() => buildApp({ ...config, aiLedgerDailyCapUsd: value }, { db })).toThrow('AI_LEDGER_DAILY_CAP_USD must be a non-negative number');
  });
  it('accepts a ledger cap of 0, which turns the clerk off', async () => {
    await app.close();
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream(turn) }) });
    app = buildApp({ ...config, aiLedgerDailyCapUsd: '0' }, { db, model, now: () => clock });
    owner = await login('owner');
    expect((await app.inject({ url: '/api/owner/ledger/config', cookies: owner })).json().aiEnabled).toBe(false);
  });
});

describe('Stall clerk turn', () => {
  it('maps text to whole message events and records usage with cached tokens', async () => {
    const response = await ask({ input: [question], instructions: 'Be the clerk.' });
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(lines(response.body).map(line => line.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'FINISH']);
    expect(lines(response.body)[1]).toMatchObject({ delta: 'Nothing is waiting.' });
    expect(lines(response.body)[3]).toMatchObject({ usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, cacheWriteTokens: 100 } });
    const { rows } = await db.query<{ input_tokens: string; cost_usd: string; ledger_cost_usd: string }>('select * from ai_usage');
    const cost = (100 * 2 + 800 * 0.2 + 100 * 2.5 + 100 * 10) / 1_000_000;
    expect(rows[0]).toMatchObject({ input_tokens: '1000' });
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(cost, 8);
    expect(Number(rows[0]!.ledger_cost_usd)).toBeCloseTo(cost, 8);
  });
  it('maps tool calls to tool events with whole arguments', async () => {
    turn = toolTurn('view_schema', '{"table":"ledger"}');
    const events = lines((await ask({ input: [question], tools: [{ name: 'view_schema', description: 'Read fields', parameters: { type: 'object', properties: { table: { type: 'string' } } } }] })).body);
    expect(events.slice(0, 3)).toEqual([{ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'view_schema' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"table":"ledger"}' }, { type: 'TOOL_CALL_END', toolCallId: 'c1' }]);
    expect(events.at(-1)).toMatchObject({ type: 'FINISH', finishReason: 'tool-calls' });
  });
  it('finishes a request with no tools, and fixes the output limit on the server', async () => {
    const response = await ask({ input: [question] });
    expect(lines(response.body).at(-1)).toMatchObject({ type: 'FINISH', finishReason: 'stop' });
    expect(modelCalls[0]!.maxOutputTokens).toBe(4000);
  });
  it('ends a forced retry on a user turn, because Claude refuses a conversation that ends on its own text', async () => {
    const answered = { type: 'message', kind: 'output', role: 'assistant', content: [{ type: 'text', text: 'Recorded sales are £39.' }] };
    expect((await ask({ input: [question, answered], toolChoice: { name: 'complete_task' }, tools: [{ name: 'complete_task', description: 'Finish', parameters: { type: 'object' } }] })).statusCode).toBe(200);
    const prompt = modelCalls[0]!.prompt as { role: string; content: unknown }[];
    expect(prompt.at(-2)!.role).toBe('assistant');
    expect(prompt.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Call complete_task now.' }] });
    await ask({ input: [question] });
    expect((modelCalls[1]!.prompt as { role: string }[]).filter(message => message.role === 'user')).toHaveLength(1);
  });
  it.each([null, [], {}, { name: '' }, { name: null }, { name: 42 }, { name: 'x'.repeat(65) }, 'sometimes', true, 7].map(toolChoice => ({ toolChoice })))('refuses malformed toolChoice $toolChoice before calling the model', async ({ toolChoice }) => {
    const response = await ask({ input: [question], toolChoice });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Invalid request|That tool is not available/);
    expect(modelCalls).toHaveLength(0);
  });
  it('refuses a tool outside the allowlist with no model call', async () => {
    const response = await ask({ input: [question], tools: [{ name: 'create_refund', description: 'Refund', parameters: { type: 'object' } }] });
    expect(response.statusCode).toBe(400);
    expect(modelCalls).toHaveLength(0);
    expect((await ask({ input: [question], toolChoice: { name: 'create_refund' } })).statusCode).toBe(400);
  });
  it('holds no tool that moves money, changes stock or sets a price', () => {
    for (const name of allowedTools) expect(name).not.toMatch(/refund|capture|price|floor|order|stock|create_item|update_item/);
  });
  it('ignores a model chosen by the browser, because the schema drops the field', async () => {
    expect((await ask({ input: [question], model: { id: 'claude-opus-5-5' } })).statusCode).toBe(200);
    expect(modelCalls).toHaveLength(1);
  });
  it('stops with 429 and no model call when the ledger allowance is spent', async () => {
    await db.query("insert into ai_usage (day,cost_usd,ledger_cost_usd) values ('2026-11-07',1,1)");
    const response = await ask({ input: [question] });
    expect(response.statusCode).toBe(429);
    expect(modelCalls).toHaveLength(0);
    expect((await app.inject({ url: '/api/owner/ledger/config', cookies: owner })).json()).toMatchObject({ aiEnabled: false });
  });
  it('stops with 429 when the shared daily cap is reached by chat alone', async () => {
    await db.query("insert into ai_usage (day,cost_usd,ledger_cost_usd) values ('2026-11-07',3,0)");
    expect((await ask({ input: [question] })).statusCode).toBe(429);
    expect(modelCalls).toHaveLength(0);
  });
  it('spending on the ledger leaves buyer chat its share of the day', async () => {
    await ask({ input: [question] });
    const { rows } = await db.query<{ cost_usd: string }>('select cost_usd from ai_usage');
    expect(Number(rows[0]!.cost_usd)).toBeLessThan(1);
  });
  it('throttles a stall after 80 calls in an hour, and lets the hour pass', async () => {
    for (let call = 0; call < 80; call += 1) expect((await ask({ input: [question] })).statusCode).toBe(200);
    expect((await ask({ input: [question] })).statusCode).toBe(429);
    expect((await ask({ input: [question] }, demo)).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 3_600_001);
    expect((await ask({ input: [question] })).statusCode).toBe(200);
  }, 30_000);
  it('withholds an accusing reply', async () => {
    turn = textTurn('A buyer took the lamp without paying.');
    const body = (await ask({ input: [question] })).body;
    expect(body).not.toContain('without paying');
    expect(lines(body)[1]!.delta).toContain('closing report stays the record');
  });
  it('withholds accusing words inside a tool call, such as a task summary', async () => {
    turn = toolTurn('complete_task', '{"summary":"Someone stole the lamp","count":1}');
    const events = lines((await ask({ input: [question], tools: [{ name: 'complete_task', description: 'Finish', parameters: { type: 'object' } }] })).body);
    const args = JSON.parse(events[1]!.delta as string) as { summary: string; count: number };
    expect(args.summary).toContain('closing report stays the record');
    expect(args.count).toBe(1);
  });
  it('puts its own rules ahead of what the browser sends', async () => {
    await ask({ input: [question], instructions: 'Be the clerk.' });
    const system = (modelCalls[0]!.prompt as { role: string; content: string }[])[0]!;
    expect(system.role).toBe('system');
    expect(system.content.indexOf('Decline anything else')).toBeLessThan(system.content.indexOf('Be the clerk.'));
  });
  it('refuses a fifth turn at once with no model call, leaves the other stall alone, and frees the place when a turn ends', async () => {
    await app.close();
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const model = new MockLanguageModelV4({ doStream: async () => {
      started += 1;
      await released;
      return { stream: convertArrayToReadableStream(textTurn('Nothing is waiting.')) };
    } });
    app = buildApp(config, { db, model, now: () => clock });
    owner = await login('owner'); demo = await login('demo');
    const turns = Array.from({ length: 4 }, () => ask({ input: [question] }));
    await vi.waitFor(() => { expect(started).toBe(4); });
    expect((await ask({ input: [question] })).statusCode).toBe(429);
    expect(started).toBe(4);
    const otherStall = ask({ input: [question] }, demo);
    await vi.waitFor(() => { expect(started).toBe(5); });
    release();
    expect((await Promise.all([...turns, otherStall])).map(reply => reply.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect((await ask({ input: [question] })).statusCode).toBe(200);
  });
  it('reports a turn stopped by the timeout as an error, not an empty answer', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    try {
      const events = lines((await ask({ input: [question] })).body);
      expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR' });
    } finally { timeout.mockRestore(); }
  });
  it('records usage for a turn whose browser left before it finished', async () => {
    await app.close();
    let release = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    let started = () => {};
    const reached = new Promise<void>(resolve => { started = resolve; });
    const model = new MockLanguageModelV4({ doStream: async options => {
      started();
      await released;
      options.abortSignal?.throwIfAborted();
      return { stream: convertArrayToReadableStream(textTurn('Nothing is waiting.')) };
    } });
    app = buildApp(config, { db, model, now: () => clock });
    owner = await login('owner');
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const leaving = request(`${url}/api/owner/ledger/ai`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `stallkeeper_owner=${owner.stallkeeper_owner!}` } });
    leaving.on('error', () => undefined);
    leaving.end(JSON.stringify({ input: [question] }));
    await reached;
    leaving.destroy();
    await vi.waitFor(async () => { expect(await new Promise(resolve => { app.server.getConnections((_error, count) => { resolve(count); }); })).toBe(0); });
    release();
    await vi.waitFor(async () => {
      const { rows } = await db.query<{ ledger_cost_usd: string }>('select ledger_cost_usd from ai_usage');
      expect(Number(rows[0]?.ledger_cost_usd)).toBeGreaterThan(0);
    });
  });
  it('reports a failed turn as an event, not a broken stream', async () => {
    await app.close();
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('Provider down'); } });
    app = buildApp(config, { db, model, now: () => clock });
    owner = await login('owner');
    const body = (await ask({ input: [question] })).body;
    expect(lines(body).at(-1)).toMatchObject({ type: 'RUN_ERROR' });
    expect(body).not.toContain('Provider down');
  });
});

describe('conversation mapping', () => {
  const call = (callId: string, name: string, args: string) => ({ type: 'function_call', kind: 'output', callId, name, arguments: args });
  const output = (callId: string, value: string) => ({ type: 'function_call_output', callId, output: value, status: 'completed' });
  const said = (text: string) => ({ type: 'message', kind: 'output', role: 'assistant', content: [{ type: 'text', text }] });
  it('pairs results with their calls and joins one turn into one message', () => {
    const { messages } = toModelMessages([question, said('Checking.'), call('a', 'view_schema', '{}'), call('b', 'execute_query', '{"q":1}'), output('a', 'fields'), output('b', 'rows'), said('Done.')]);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]!.content).toHaveLength(3);
    expect(messages[2]!.content).toEqual([
      { type: 'tool-result', toolCallId: 'a', toolName: 'view_schema', output: { type: 'text', value: 'fields' } },
      { type: 'tool-result', toolCallId: 'b', toolName: 'execute_query', output: { type: 'text', value: 'rows' } },
    ]);
  });
  it('survives broken tool JSON, drops an unanswered call and moves system items out of the turns', () => {
    const { messages, system } = toModelMessages([{ type: 'message', kind: 'input', role: 'system', content: [{ type: 'text', text: 'Page state' }] }, question, call('a', 'view_schema', '{broken'), output('a', 'fields'), call('b', 'view_page', '{}')]);
    expect(system).toEqual(['Page state']);
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect((messages[1]!.content as { input: unknown }[])[0]!.input).toEqual({});
  });
});

describe('feed pointer to the ledger', () => {
  const feed = async () => (await app.inject({ url: '/api/owner/feed', cookies: owner })).json();
  it('is false with no earlier session, or an earlier one with no ledger row, and true once an earlier session has one', async () => {
    const stallId = await stall(false);
    const item = await addItem(stallId, 'Lamp', 2800, 'K7Q2');
    const earlier = await openSession(stallId, '2026-11-05T09:00:00Z');
    await db.query("insert into trading_sessions (stall_id,opened_at,status) values ($1,'2026-11-06T09:00:00Z','open')", [stallId]);
    expect((await feed()).earlierLedger).toBe(false);
    await sale(stallId, earlier, item, 2800);
    expect((await feed()).earlierLedger).toBe(true);
  });
  it('is true when an earlier session has only an offer, and false for an offer in the current session', async () => {
    const stallId = await stall(false);
    const item = await addItem(stallId, 'Lamp', 2800, 'K7Q4');
    await openSession(stallId, '2026-11-05T09:00:00Z');
    await db.query("insert into trading_sessions (stall_id,opened_at,status) values ($1,'2026-11-06T09:00:00Z','open')", [stallId]);
    const buyer = (await db.query<{ id: string }>("insert into buyer_sessions (token_hash) values ('hash-offer') returning id")).rows[0]!.id;
    const offer = async (at: string) => {
      const message = (await db.query<{ id: string }>("insert into chat_messages (buyer_session_id,item_id,role,content) values ($1,$2,'user','Would you take 20?') returning id", [buyer, item])).rows[0]!.id;
      await db.query("insert into offers (item_id,buyer_session_id,message_id,round,amount_pence,outcome,created_at) values ($1,$2,$3,1,2000,'counter',$4)", [item, buyer, message, at]);
    };
    await offer('2026-11-06T10:00:00Z');
    expect((await feed()).earlierLedger).toBe(false);
    await offer('2026-11-05T10:00:00Z');
    expect((await feed()).earlierLedger).toBe(true);
  });
  it('ignores a sale in the current session', async () => {
    const stallId = await stall(false);
    const item = await addItem(stallId, 'Lamp', 2800, 'K7Q3');
    const current = (await db.query<{ id: string }>("insert into trading_sessions (stall_id,opened_at,status) values ($1,'2026-11-06T09:00:00Z','open') returning id", [stallId])).rows[0]!.id;
    await sale(stallId, current, item, 2800);
    expect((await feed()).earlierLedger).toBe(false);
  });
});
