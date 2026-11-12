import { afterEach, beforeEach, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { buildApp } from './app.js';
import { testDatabase } from '../test/database.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173' };
const answer = { content: [{ type: 'text' as const, text: 'The stallholder says it works.' }], finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } }, warnings: [] };
const offerCall = (amountPence: number) => ({ ...answer, content: [{ type: 'tool-call' as const, toolCallId: 'call', toolName: 'respond_to_offer', input: JSON.stringify({ amountPence }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' } });
let app: ReturnType<typeof buildApp>;
let clock: Date;
let script: Array<typeof answer | ReturnType<typeof offerCall>>;
let owner: Record<string, string>;
let demo: Record<string, string>;
const login = async (password: string) => ({ stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password } })).cookies[0]!.value });
const feed = (cookies = owner) => app.inject({ url: '/api/owner/feed', cookies });
const ledger = (cookies = owner) => app.inject({ url: '/api/owner/ledger/data', cookies });
const addItem = async (cookies: Record<string, string>, name: string) => (await app.inject({ method: 'POST', url: '/api/owner/items', cookies, payload: { name, notes: 'Tested, works. Scuff on base.', mode: 'haggle', askingPence: 2800, floorPence: 1739 } })).json() as { id: string; code: string };
async function ask(item: { id: string; code: string }, message: string, buyer: Record<string, string>) {
  await db.query('insert into chat_messages (buyer_session_id,item_id,role,content) select id,$2,\'user\',$3 from buyer_sessions where token_hash=$1', [buyer.hash, item.id, message]);
}
const say = (item: { code: string }, payload: { message: string } | { offerPence: number }, buyer: Record<string, string>) => app.inject({ method: 'POST', url: `/api/i/${item.code}/chat`, cookies: { stallkeeper_buyer: buyer.stallkeeper_buyer! }, payload });
async function visit(item: { code: string }) {
  const token = (await app.inject(`/api/i/${item.code}`)).cookies[0]!.value;
  const { rows } = await db.query('select token_hash as hash from buyer_sessions order by created_at desc limit 1');
  return { stallkeeper_buyer: token, hash: rows[0].hash as string };
}
beforeEach(async () => {
  await db.query('truncate chat_messages, item_floors, items, trading_sessions, buyer_sessions, ai_usage cascade');
  clock = new Date('2026-11-05T12:00:00Z'); script = [answer];
  const model = new MockLanguageModelV4({ doGenerate: async () => script.length > 1 ? script.shift()! : script[0]! });
  app = buildApp(config, { db, model, now: () => clock });
  owner = await login('owner'); demo = await login('demo');
});
afterEach(async () => app.close());

it('lists buyer questions newest first, grouped by item, without offers', async () => {
  const lamp = await addItem(owner, 'Brass lamp'); const clock = await addItem(owner, 'Carriage clock');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const buyer = await visit(lamp);
  await ask(lamp, 'Does it work?', buyer); await ask(clock, 'Is it keeping time?', buyer); await ask(lamp, 'Is it from 1970?', buyer);
  const { buyerQuestions } = (await feed()).json();
  expect(buyerQuestions.map((g: { name: string }) => g.name)).toEqual(['Brass lamp', 'Carriage clock']);
  expect(buyerQuestions[0].questions.map((q: { text: string }) => q.text)).toEqual(['Is it from 1970?', 'Does it work?']);
  expect(buyerQuestions[1]).toMatchObject({ code: clock.code, seeded: false, questions: [{ text: 'Is it keeping time?' }] });
});
it('keeps tapped and typed offers out of the list, and a typed question in it', async () => {
  const lamp = await addItem(owner, 'Brass lamp');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const buyer = await visit(lamp);
  await say(lamp, { offerPence: 2000 }, buyer);
  script = [offerCall(1500), answer];
  await say(lamp, { message: 'Would you take fifteen pounds?' }, buyer);
  await say(lamp, { message: 'Does it work?' }, buyer);
  expect((await db.query('select count(*)::int as count from offers')).rows[0].count).toBe(2);
  expect((await feed()).json().buyerQuestions[0].questions.map((q: { text: string }) => q.text)).toEqual(['Does it work?']);
});
it('leaves out questions about removed items', async () => {
  const lamp = await addItem(owner, 'Brass lamp');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await ask(lamp, 'Does it work?', await visit(lamp));
  expect((await feed()).json().buyerQuestions).toHaveLength(1);
  await app.inject({ method: 'POST', url: `/api/owner/items/${lamp.id}/remove`, cookies: owner, payload: { reason: 'Withdrawn' } });
  expect((await feed()).json().buyerQuestions).toEqual([]);
});
it('leaves out questions from earlier trading sessions, even about an item still on sale', async () => {
  const lamp = await addItem(owner, 'Brass lamp');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const buyer = await visit(lamp);
  await ask(lamp, 'Last session question', buyer);
  await db.query("update trading_sessions set status='closed',closed_at=now()");
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  expect((await feed()).json().buyerQuestions).toEqual([]);
  await ask(lamp, 'This session question', buyer);
  expect((await feed()).json().buyerQuestions[0].questions.map((q: { text: string }) => q.text)).toEqual(['This session question']);
});
it('starts the demo list clean after a reset, and labels seeded items', async () => {
  // The demo cookie from beforeEach was issued at the pinned clock and lasts seven days, so log in again on the real clock this test needs.
  clock = new Date(); demo = await login('demo');
  await app.inject({ method: 'POST', url: '/api/owner/demo/reset', cookies: demo });
  const seeded = (await db.query<{ id: string; code: string }>("select i.id,i.code from items i join stalls s on s.id=i.stall_id where s.is_demo and i.mode='haggle' limit 1")).rows[0]!;
  await ask(seeded, 'An earlier judge asked this', await visit(seeded));
  expect((await feed(demo)).json().buyerQuestions).toMatchObject([{ seeded: true, questions: [{ text: 'An earlier judge asked this' }] }]);
  clock = new Date(Date.now() + 60_000);
  expect((await app.inject({ method: 'POST', url: '/api/owner/demo/reset', cookies: demo })).statusCode).toBe(200);
  expect((await feed(demo)).json().buyerQuestions).toEqual([]);
});
it('caps the list at the most recent thirty questions', async () => {
  const lamp = await addItem(owner, 'Brass lamp');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const buyer = await visit(lamp);
  for (let i = 1; i <= 35; i++) await ask(lamp, `Question ${i}`, buyer);
  const [group] = (await feed()).json().buyerQuestions;
  expect(group.questions).toHaveLength(30); expect(group.questions[0].text).toBe('Question 35'); expect(group.questions[29].text).toBe('Question 6');
});
it('keeps the demo stall and the main stall apart and hides questions from visitors', async () => {
  const lamp = await addItem(owner, 'Brass lamp'); const mug = await addItem(demo, 'Demo mug');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: demo });
  await ask(lamp, 'Main stall question', await visit(lamp));
  await ask(mug, 'Demo stall question', await visit(mug));
  expect(JSON.stringify((await feed()).json().buyerQuestions)).toContain('Main stall question');
  expect(JSON.stringify((await feed()).json().buyerQuestions)).not.toContain('Demo stall question');
  expect(JSON.stringify((await feed(demo)).json().buyerQuestions)).toContain('Demo stall question');
  expect(JSON.stringify((await feed(demo)).json().buyerQuestions)).not.toContain('Main stall question');
  expect((await app.inject('/api/owner/feed')).statusCode).toBe(401);
  const page = JSON.stringify((await app.inject(`/api/i/${lamp.code}`)).json());
  expect(page).not.toContain('Main stall question'); expect(page).not.toContain('buyerQuestions');
});
it('returns no questions before a trading session exists', async () => {
  const lamp = await addItem(owner, 'Brass lamp');
  await ask(lamp, 'Does it work?', await visit(lamp));
  const body = (await feed()).json();
  expect(body.session).toBeNull(); expect(body.buyerQuestions).toEqual([]);
});
it('reports today\'s service-wide estimated AI spend against the daily cap, owner only', async () => {
  expect((await ledger()).json().aiSpend).toEqual({ spentUsd: 0, capUsd: 3 });
  await db.query("insert into ai_usage (day,cost_usd) values ('2026-11-04',2.5), ('2026-11-05',1.25)");
  expect((await ledger()).json().aiSpend).toEqual({ spentUsd: 1.25, capUsd: 3 });
  expect((await ledger(demo)).json().aiSpend).toEqual({ spentUsd: 1.25, capUsd: 3 });
  expect((await app.inject('/api/owner/ledger/data')).body).not.toContain('aiSpend'); expect((await feed()).body).not.toContain('aiSpend');
});
it('tells the live feed when a closing summary runs', async () => {
  await addItem(owner, 'Brass lamp');
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  await app.inject({ method: 'POST', url: '/api/owner/stall/close', cookies: owner });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/owner/feed/stream`, { headers: { cookie: `stallkeeper_owner=${encodeURIComponent(owner.stallkeeper_owner!)}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  const next = async () => new TextDecoder().decode((await reader.read()).value);
  try {
    await next();
    const update = next();
    await app.inject({ method: 'POST', url: '/api/owner/closing/summary', cookies: owner });
    expect(await update).toContain('event: update');
    expect((await ledger()).json().aiSpend.spentUsd).toBeGreaterThan(0);
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
});
