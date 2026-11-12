import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { buildApp } from './app.js';
import { testDatabase } from '../test/database.js';
const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173' };
const answer = { content: [{ type: 'text' as const, text: 'The stallholder says it works, with a scuff on the base.' }], finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } }, warnings: [] };
let model: MockLanguageModelV4;
let app: ReturnType<typeof buildApp>;
let code: string;
let cookies: Record<string, string>;
let date = new Date('2026-11-05T12:00:00Z');
beforeEach(async () => {
  await db.query('truncate chat_messages, item_floors, items, trading_sessions, buyer_sessions, ai_usage cascade');
  date = new Date('2026-11-05T12:00:00Z');
  model = new MockLanguageModelV4({ doGenerate: answer });
  app = buildApp(config, { db, model, now: () => date });
  const login = await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password: 'owner' } });
  const owner = { stallkeeper_owner: login.cookies[0]!.value };
  const item = await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: { name: 'Brass lamp', notes: 'Tested, works. Scuff on base. Made in 1970. Height 30 cm.', mode: 'haggle', askingPence: 2800, floorPence: 1739 } });
  code = item.json().code;
  await app.inject({ method: 'POST', url: '/api/owner/stall/open', cookies: owner });
  const first = await app.inject(`/api/i/${code}`);
  cookies = { stallkeeper_buyer: first.cookies[0]!.value };
});
afterEach(async () => app.close());
const chat = (message = 'Does it work?') => app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies, payload: { message } });
const itemPage = () => app.inject({ url: `/api/i/${code}`, cookies });
async function reserve(state: string) {
  const checkout = (await db.query(`insert into checkouts (stall_id,trading_session_id,buyer_session_id,state,total_pence,checkout_key,create_request_id,capture_request_id,reservation_deadline)
    select i.stall_id,t.id,b.id,$1,2800,i.id::text,gen_random_uuid(),gen_random_uuid(),'2026-11-05T12:05:00Z' from items i join trading_sessions t on t.stall_id=i.stall_id cross join buyer_sessions b returning id, checkout_key`, [state])).rows[0];
  await db.query('insert into checkout_lines (checkout_id,item_id,code,name,asking_pence,amount_pence) select $1,id,code,name,asking_pence,asking_pence from items', [checkout.id]);
  await db.query("update items set status='available', reserved_checkout_id=$1", [checkout.id]);
  return checkout;
}
const text = (message: { content: unknown }) => (message.content as { text: string }[])[0]!.text;
const keepPrompts = (prompts: { content: unknown }[][]) => async ({ prompt }: { prompt: { content: unknown }[] }) => { prompts.push(prompt); return answer; };

it('sends only public facts and isolated append-only history to a non-streaming model with only the offer tool', async () => {
  expect((await itemPage()).json().chatAvailable).toBe(true);
  expect((await chat()).json()).toMatchObject({ reply: answer.content[0]!.text, turnsLeft: 19 });
  const call = model.doGenerateCalls[0]!;
  expect(JSON.stringify(call.prompt)).not.toMatch(/1739|17\.39|floor/i);
  for (const fact of ['Brass lamp', 'Tested, works', 'Scuff on base', 'GBP 28.00', 'retailReference', 'stallName']) expect(JSON.stringify(call.prompt)).toContain(fact);
  expect(call).toMatchObject({ maxOutputTokens: 2000, providerOptions: { anthropic: { effort: 'low', fallbacks: 'default' } } });
  expect(call.temperature).toBeUndefined(); expect(call.tools?.map(tool => tool.name)).toEqual(['respond_to_offer']);
  expect(model.doStreamCalls).toHaveLength(0);
  await chat('Is it from 1970?');
  expect(model.doGenerateCalls[1]!.prompt).toHaveLength(4);
  const rows = (await db.query('select role,content from chat_messages order by id')).rows;
  expect(rows.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  await expect(db.query("update chat_messages set content='changed'")).rejects.toThrow('append-only');
  await expect(db.query('delete from chat_messages')).rejects.toThrow('append-only');
  const usage = (await db.query('select * from ai_usage')).rows[0];
  expect(Number(usage.input_tokens)).toBe(2000); expect(Number(usage.output_tokens)).toBe(200); expect(Number(usage.cost_usd)).toBeCloseTo(0.006);
  const other = await app.inject(`/api/i/${code}`);
  const response = await app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies: { stallkeeper_buyer: other.cookies[0]!.value }, payload: { message: 'How tall?' } });
  expect(response.statusCode).toBe(200); expect(model.doGenerateCalls[2]!.prompt).toHaveLength(2);
});
it('rejects empty and oversized messages before spending a turn, and accepts 500 characters', async () => {
  for (const message of ['', ' ', 'a'.repeat(501)]) expect((await chat(message)).statusCode).toBe(400);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await chat('a'.repeat(500))).json().turnsLeft).toBe(19);
});
it('caps the buyer session at 20 turns across reloads', async () => {
  for (let n = 0; n < 20; n++) expect((await chat()).json().turnsLeft).toBe(19 - n);
  expect((await chat()).json().chatAvailable).toBe(false);
  expect((await itemPage()).json()).toMatchObject({ chatAvailable: false, availability: 'available' });
  expect(model.doGenerateCalls).toHaveLength(20);
});
it('hides chat when the daily cap is spent and restores it on the next UTC day', async () => {
  await db.query("insert into ai_usage (day,cost_usd) values ('2026-11-05',3)");
  expect((await chat()).statusCode).toBe(503); expect(model.doGenerateCalls).toHaveLength(0);
  expect((await itemPage()).json().chatAvailable).toBe(false);
  date = new Date('2026-11-06T00:00:00Z');
  expect((await chat()).statusCode).toBe(200);
});
it.each(['refusal', 'error'])('reports unavailable chat on model %s, then tries the model again', async failure => {
  model.doGenerate = async () => {
    if (failure === 'error') throw new Error('Provider unavailable');
    return { ...answer, finishReason: { unified: 'content-filter', raw: 'refusal' } };
  };
  const failed = await chat();
  expect(failed.statusCode).toBe(503); expect(failed.json().chatAvailable).toBe(false);
  if (failure === 'refusal') expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBe(0.003);
  expect((await db.query('select role from chat_messages')).rows).toEqual([{ role: 'user' }]);
  expect((await itemPage()).json()).toMatchObject({ chatAvailable: true, availability: 'available', item: { notes: 'Tested, works. Scuff on base. Made in 1970. Height 30 cm.', askingPence: 2800 } });
  const prompts: { content: unknown }[][] = [];
  model.doGenerate = keepPrompts(prompts);
  expect((await chat('How tall is it?')).json()).toMatchObject({ reply: answer.content[0]!.text, turnsLeft: 18, chatAvailable: true });
  expect(prompts[0]!.slice(1).map(text)).toEqual(['How tall is it?']);
  expect((await db.query('select role from chat_messages order by id')).rows.map(row => row.role)).toEqual(['user', 'user', 'assistant']);
});
it('pairs each answer with its own question when calls in one session overlap', async () => {
  const finish = new Map<string, () => void>();
  let entered!: () => void;
  const bothEntered = new Promise<void>(resolve => { entered = resolve; });
  model.doGenerate = async ({ prompt }) => {
    const question = text(prompt.at(-1)!);
    await new Promise<void>(resolve => {
      finish.set(question, resolve);
      if (finish.size === 2) entered();
    });
    return { ...answer, content: [{ type: 'text', text: `Answer to ${question}` }] };
  };
  const first = chat('First?');
  const second = chat('Second?');
  await bothEntered;
  finish.get('Second?')!();
  expect((await second).statusCode).toBe(200);
  const prompts: { content: unknown }[][] = [];
  model.doGenerate = keepPrompts(prompts);
  await chat('Third?');
  expect(prompts[0]!.slice(1).map(text)).toEqual(['Second?', 'Answer to Second?', 'Third?']);
  finish.get('First?')!();
  expect((await first).statusCode).toBe(200);
  await chat('Fourth?');
  expect(prompts[1]!.slice(1).map(text)).toEqual(['First?', 'Answer to First?', 'Second?', 'Answer to Second?', 'Third?', answer.content[0]!.text, 'Fourth?']);
});
it('keeps a reply cut off at the output limit', async () => {
  model.doGenerate = async () => ({ ...answer, finishReason: { unified: 'length', raw: 'max_tokens' } });
  expect((await chat()).json()).toMatchObject({ reply: answer.content[0]!.text, turnsLeft: 19, chatAvailable: true });
});
it.each([['stop', 'end_turn'], ['length', 'max_tokens'], ['content-filter', 'refusal']] as const)('gives the stall copy and records the turn when the model finishes with %s and a blank reply', async (unified, raw) => {
  const stallCopy = "The asking price is £28. Read the stallholder's notes, make an offer, or pay with the PayPal button. Not paid yet.";
  model.doGenerate = async () => ({ ...answer, content: [{ type: 'text', text: ' ' }], finishReason: { unified, raw } });
  const blank = await chat();
  expect(blank.statusCode).toBe(200);
  expect(blank.json()).toMatchObject({ reply: stallCopy, turnsLeft: 19, chatAvailable: true });
  expect((await db.query('select role,content from chat_messages order by id')).rows).toEqual([{ role: 'user', content: 'Does it work?' }, { role: 'assistant', content: stallCopy }]);
});
it('releases a lapsed reservation before answering', async () => {
  const checkout = await reserve('awaiting_approval');
  date = new Date('2026-11-05T12:05:00Z');
  expect((await chat()).statusCode).toBe(200);
  expect((await db.query('select state from checkouts where id=$1', [checkout.id])).rows[0].state).toBe('expired');
  expect((await db.query('select reserved_checkout_id from items')).rows[0].reserved_checkout_id).toBeNull();
});
it('keeps refusing while a capture holds the item past its deadline', async () => {
  const checkout = await reserve('capturing');
  date = new Date('2026-11-05T12:05:00Z');
  expect((await chat()).statusCode).toBe(409);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await db.query('select reserved_checkout_id from items')).rows[0].reserved_checkout_id).toBe(checkout.id);
});
it('refuses fixed, sold, reserved and closed items without calling the model', async () => {
  for (const update of ["mode='fixed'", "mode='haggle', status='sold'"]) {
    await db.query(`update items set ${update}`);
    expect((await chat()).statusCode).toBe(409);
  }
  const checkout = await reserve('awaiting_approval');
  expect((await chat()).statusCode).toBe(409);
  expect((await itemPage()).json()).toMatchObject({ availability: 'reserved', chatAvailable: false, checkout: { checkoutId: checkout.id } });
  await db.query('update items set reserved_checkout_id=null');
  await db.query("update trading_sessions set status='closing'");
  expect((await chat()).statusCode).toBe(409); expect(model.doGenerateCalls).toHaveLength(0);
});
it('answers another buyer while a model call is running', async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  model.doGenerate = async () => { started(); await release; return answer; };
  const first = chat();
  await entered;
  model.doGenerate = async () => answer;
  const other = await app.inject(`/api/i/${code}`);
  const second = await app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies: { stallkeeper_buyer: other.cookies[0]!.value }, payload: { message: 'How tall?' } });
  expect(second.statusCode).toBe(200);
  finish(); expect((await first).statusCode).toBe(200);
});
it('refuses a request whose last turn is taken after it was admitted', async () => {
  await db.query('update buyer_sessions set turns_used=19');
  const rival = await db.connect();
  await rival.query('begin');
  await rival.query('update buyer_sessions set turns_used=20');
  const late = chat();
  await vi.waitFor(async () => expect((await db.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rows[0].count).toBe(1));
  await rival.query('commit');
  rival.release();
  expect((await late).statusCode).toBe(503);
  expect(model.doGenerateCalls).toHaveLength(0);
  expect((await db.query('select turns_used from buyer_sessions')).rows[0].turns_used).toBe(20);
  expect((await db.query('select id from chat_messages')).rows).toEqual([]);
});
it('requires a known buyer session and disables chat when the model is unconfigured', async () => {
  expect((await app.inject({ method: 'POST', url: `/api/i/${code}/chat`, payload: { message: 'Hello' } })).statusCode).toBe(401);
  await app.close(); app = buildApp(config, { db });
  expect((await itemPage()).json().chatAvailable).toBe(false);
  expect((await chat()).statusCode).toBe(503);
});
it('applies a configured daily budget', async () => {
  await app.close(); app = buildApp({ ...config, aiDailyCapUsd: '0.002' }, { db, model, now: () => date });
  expect((await chat()).json()).toEqual({ reply: answer.content[0]!.text, turnsLeft: 19, chatAvailable: false, card: null, agreedPrice: null });
  expect((await chat()).statusCode).toBe(503);
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBe(0.003);
});
it('treats a blank daily budget as the default and zero as chat off', async () => {
  await app.close(); app = buildApp({ ...config, aiDailyCapUsd: '' }, { db, model, now: () => date });
  await db.query("insert into ai_usage (day,cost_usd) values ('2026-11-05',2.99)");
  expect((await itemPage()).json().chatAvailable).toBe(true);
  await db.query('update ai_usage set cost_usd=3');
  expect((await itemPage()).json().chatAvailable).toBe(false);
  await db.query('truncate ai_usage');
  await app.close(); app = buildApp({ ...config, aiDailyCapUsd: '0' }, { db, model, now: () => date });
  expect((await itemPage()).json().chatAvailable).toBe(false);
});
it('dates, sizes and negated amounts do not change price or reservation state', async () => {
  for (const message of ['Is it from 1970?', 'Is it 30 cm tall?', 'I am not offering £5']) expect((await chat(message)).statusCode).toBe(200);
  const item = (await itemPage()).json();
  expect((await db.query('select price_version from items where code=$1', [code])).rows[0].price_version).toBe(1);
  expect(item).toMatchObject({ item: { askingPence: 2800 }, card: null, agreedPrice: null, checkout: null, availability: 'available' });
});
it("returns this buyer session's own conversation on the item page, never another session's, and no floor", async () => {
  expect((await itemPage()).json().messages).toEqual([]);
  await chat('Does it work?'); await chat('Is it from 1970?');
  const page = await itemPage();
  expect(page.json().messages).toEqual([
    { role: 'user', content: 'Does it work?' }, { role: 'assistant', content: answer.content[0]!.text },
    { role: 'user', content: 'Is it from 1970?' }, { role: 'assistant', content: answer.content[0]!.text },
  ]);
  expect(page.body).not.toMatch(/1739|17\.39|floor/i);
  const other = await app.inject(`/api/i/${code}`);
  expect(other.json().messages).toEqual([]);
  const stranger = await app.inject({ url: `/api/i/${code}`, cookies: { stallkeeper_buyer: other.cookies[0]!.value } });
  expect(stranger.json().messages).toEqual([]);
  expect(JSON.stringify(stranger.json())).not.toContain('Does it work?');
});
it('leaves a question out of the restored conversation when its answer failed, as the model history does', async () => {
  model.doGenerate = async () => { throw new Error('Model unavailable'); };
  expect((await chat('Lost question?')).statusCode).toBe(503);
  expect((await itemPage()).json().messages).toEqual([]);
  model.doGenerate = async () => answer;
  await chat('Kept question?');
  expect((await itemPage()).json().messages.map((message: { content: string }) => message.content)).toEqual(['Kept question?', answer.content[0]!.text]);
});

it('limits overlapping turns across buyer sessions and releases capacity after failure', async () => {
  const releases: (() => void)[] = [];
  model.doGenerate = async () => {
    await new Promise<void>(resolve => releases.push(resolve));
    throw new Error('Provider unavailable');
  };
  const pending = [];
  for (let i = 0; i < 4; i++) {
    const buyer = (await app.inject(`/api/i/${code}`)).cookies[0]!.value;
    pending.push(app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies: { stallkeeper_buyer: buyer }, payload: { message: 'Does it work?' } }).then(response => response));
  }
  try {
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const limited = await chat();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toMatchObject({ chatAvailable: true, error: expect.stringContaining('try again') });
    expect((await db.query('select count(*)::integer as n from chat_messages')).rows[0].n).toBe(4);
    expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBeCloseTo(0.4);
  } finally {
    releases.forEach(release => release());
    expect((await Promise.all(pending)).map(response => response.statusCode)).toEqual([503, 503, 503, 503]);
  }
  model.doGenerate = async () => answer;
  expect((await chat()).statusCode).toBe(200);
  expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBeCloseTo(0.403);
});

it('limits starts across session turnover and restores admission after a minute', async () => {
  for (let buyer = 0; buyer < 3; buyer++) {
    cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
    for (let turn = 0; turn < 20; turn++) expect((await chat()).statusCode).toBe(200);
  }
  cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
  expect((await chat()).statusCode).toBe(429);
  expect(model.doGenerateCalls).toHaveLength(60);
  date = new Date(date.getTime() + 60_000);
  expect((await chat()).statusCode).toBe(200);
  expect(model.doGenerateCalls).toHaveLength(61);
});

it('retains failed-call charges across new sessions and service restarts until the next UTC day', async () => {
  await app.close();
  app = buildApp({ ...config, aiDailyCapUsd: '0.20' }, { db, model, now: () => date });
  const failingCall = vi.fn(async () => { throw new Error('Response lost'); });
  model.doGenerate = failingCall;
  for (let i = 0; i < 2; i++) {
    expect((await chat()).statusCode).toBe(503);
    cookies = { stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value };
  }
  expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBeCloseTo(0.20);
  await app.close();
  app = buildApp({ ...config, aiDailyCapUsd: '0.20' }, { db, model, now: () => date });
  expect((await chat()).statusCode).toBe(503);
  expect(failingCall).toHaveBeenCalledTimes(2);
  date = new Date('2026-11-06T00:00:00Z');
  model.doGenerate = async () => answer;
  expect((await chat()).statusCode).toBe(200);
  expect((await db.query('select cost_usd from ai_usage order by day')).rows.map(row => Number(row.cost_usd))).toEqual([0.20, 0.003]);
});

it('replaces a reservation with usage even when the provider refuses the answer', async () => {
  model.doGenerate = async () => ({ ...answer, finishReason: { unified: 'content-filter', raw: 'refusal' } });
  expect((await chat()).statusCode).toBe(503);
  expect(Number((await db.query('select cost_usd from ai_usage')).rows[0].cost_usd)).toBeCloseTo(0.003);
});

it('issues no offer card when a concurrent turn takes the last daily reservation', async () => {
  await app.close();
  app = buildApp({ ...config, aiDailyCapUsd: '0.10' }, { db, model, now: () => date });
  const buyers = await Promise.all([0, 1].map(async () => ({ stallkeeper_buyer: (await app.inject(`/api/i/${code}`)).cookies[0]!.value })));
  await db.query("insert into ai_usage (day,cost_usd) values ('2026-11-05',0)");
  const lock = await db.connect();
  await lock.query('begin');
  await lock.query("select * from ai_usage where day='2026-11-05' for update");
  let locked = true;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  model.doGenerate = async () => { await held; return answer; };
  const responses: { buyer: number; status: number }[] = [];
  const pending = buyers.map((cookies, buyer) => app.inject({ method: 'POST', url: `/api/i/${code}/chat`, cookies, payload: { offerPence: 2200 } })
    .then(response => { responses.push({ buyer, status: response.statusCode }); return response; }));
  try {
    // Hold the usage row so both requests pass the initial allowance check before either reserves it.
    await vi.waitFor(async () => expect(Number((await db.query('select sum(turns_used) as n from buyer_sessions')).rows[0].n)).toBe(2));
    await lock.query('commit'); locked = false;
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]!.status).toBe(503);
    const refused = await app.inject({ url: `/api/i/${code}`, cookies: buyers[responses[0]!.buyer]! });
    expect(refused.json().card).toBeNull();
    expect((await db.query("select count(*)::integer as n from offer_cards where status='open'")).rows[0].n).toBe(1);
  } finally {
    if (locked) await lock.query('rollback');
    lock.release();
    finish();
    await Promise.all(pending);
  }
  expect(responses.map(response => response.status).sort()).toEqual([200, 503]);
  const accepted = responses.find(response => response.status === 200)!;
  expect((await app.inject({ url: `/api/i/${code}`, cookies: buyers[accepted.buyer]! })).json().card).not.toBeNull();
  expect((await db.query("select count(*)::integer as n from offer_cards where status='open'")).rows[0].n).toBe(1);
});
