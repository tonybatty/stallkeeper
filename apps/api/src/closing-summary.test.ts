import { afterEach, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { closedStall } from '../test/closed-stall.js';
import { testDatabase } from '../test/database.js';
import { repairClosings, type ClosingReport } from './closing.js';
import { checkSummaryText, summaryService } from './closing-summary.js';
const db = testDatabase();
const reply = (text: string, finish = 'stop') => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: finish as 'stop', raw: 'end_turn' }, usage: { inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 120, text: 120, reasoning: 0 } }, warnings: [] });
const good = 'The report is provisional. £28.00 was recorded across 1 paid checkout, and 1 item sold.\n\n- Brass lamp sold, so consider listing a similar lamp next time.';
let stall: Awaited<ReturnType<typeof closedStall>>;
let model: MockLanguageModelV4;
async function start(text = good) {
  model = new MockLanguageModelV4({ doGenerate: reply(text) });
  stall = await closedStall(db, { model });
  await stall.sell();
  return stall.close();
}
afterEach(async () => { await stall.app.close(); });

it('writes the summary when the stall closes with no owner action, sending the model only the structured report', async () => {
  await start();
  expect(model.doGenerateCalls).toHaveLength(1);
  expect((await stall.get()).summary).toBe(good);
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: good });
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
  for (const fact of ['Brass lamp', '£28.00', 'paidCheckouts', 'Sold, gone with the buyer']) expect(prompt).toContain(fact);
  expect(prompt).not.toMatch(/ORDER\d|CAP-|floor|cookie|checkoutId|paypal/i);
  expect(model.doGenerateCalls[0]).toMatchObject({ providerOptions: { anthropic: { effort: 'low' } } });
  expect(model.doGenerateCalls[0]!.tools ?? []).toEqual([]);
  expect((await stall.get()).summary).toBe(good);
  await stall.post('/api/owner/closing/summary');
  expect(model.doGenerateCalls).toHaveLength(1);
  const usage = (await db.query('select input_tokens,output_tokens,cost_usd from ai_usage')).rows[0];
  expect(Number(usage.input_tokens)).toBe(900); expect(Number(usage.output_tokens)).toBe(120); expect(Number(usage.cost_usd)).toBeCloseTo(0.003, 6);
});
it('retries one refused draft for a normal close with a sale, a free take and a flagged item', async () => {
  let calls = 0;
  const safe = 'Brass lamp sold, and the free take is recorded; for Mirror, the record cannot say what happened.\n\n- Brass lamp sold, so consider listing a similar lamp next time.';
  model = new MockLanguageModelV4({ doGenerate: async () => reply(++calls === 1 ? 'Someone took the unsold mirror.' : safe) });
  stall = await closedStall(db, { model });
  const mirror = await stall.add('Mirror');
  await stall.take('Cookbooks');
  await stall.sell();
  const report = await stall.close();
  expect(await stall.get()).toMatchObject({ summary: safe, summaryPending: false });
  await stall.observe(report.sessionId, 'absent', mirror.id);
  await vi.waitFor(async () => { expect(await stall.get()).toMatchObject({ summary: safe, summaryPending: false }); }, { timeout: 15_000 });
  expect(model.doGenerateCalls).toHaveLength(3);
});
it('shows the closing summary for a recorded free take with a completed tip', async () => {
  const text = 'Cookbooks was taken without payment, with a tip recorded. Nothing needs attention.';
  model = new MockLanguageModelV4({ doGenerate: reply(text) });
  stall = await closedStall(db, { model });
  const free = (await stall.app.inject({ method: 'POST', url: '/api/owner/items', cookies: stall.owner, payload: { name: 'Cookbooks', notes: 'Used', mode: 'free', askingPence: 200 } })).json();
  const cookies = { stallkeeper_buyer: (await stall.app.inject(`/api/i/${free.code}`)).cookies[0]!.value };
  expect((await stall.app.inject({ method: 'POST', url: `/api/i/${free.code}/take`, cookies, payload: {} })).statusCode).toBe(201);
  const checkout = (await stall.app.inject({ method: 'POST', url: `/api/i/${free.code}/checkout`, cookies, payload: { amountPence: 2800 } })).json();
  await stall.app.inject({ method: 'POST', url: `/api/checkouts/${checkout.checkoutId}/capture`, cookies });
  await stall.close();
  expect(await stall.get()).toMatchObject({ summary: text, summaryPending: false, closing: { itemsTaken: 1, tipCount: 1, tipsPence: 2800 } });
  expect(model.doGenerateCalls).toHaveLength(1);
});
it('hides a summary once the report it was written from has changed, and writes a new one on its own', async () => {
  model = new MockLanguageModelV4({ doGenerate: reply(good) });
  stall = await closedStall(db, { model });
  const mirror = await stall.add('Mirror');
  await stall.sell();
  const report = await stall.close();
  expect(model.doGenerateCalls).toHaveLength(1);
  const flagged = (await stall.observe(report.sessionId, 'absent', mirror.id)).json();
  // A response that says nothing is pending must already hold a current summary. How fast the mock model answers must not decide which of the two the response shows.
  expect(flagged.summaryPending || flagged.summary === good).toBe(true);
  // The flag itself starts the new summary, before any later read of the report could.
  await vi.waitFor(() => { expect(model.doGenerateCalls).toHaveLength(2); }, { timeout: 15_000 });
  await vi.waitFor(async () => { expect(await stall.get()).toMatchObject({ summary: good, summaryPending: false }); }, { timeout: 15_000 });
  // Reading the report again sends nothing more to the model.
  await stall.get();
  expect(model.doGenerateCalls).toHaveLength(2);
}, 30_000);
it('shows the plain report, with no out-of-date notice, when the rewrite after a flag is refused', async () => {
  let calls = 0;
  // The first summary passes the check. The rewrite after the flag uses a vague quantity, which the check refuses.
  model = new MockLanguageModelV4({ doGenerate: async () => reply(++calls === 1 ? good : 'About half of the stock is still at the stall.') });
  stall = await closedStall(db, { model });
  const mirror = await stall.add('Mirror');
  await stall.sell();
  const report = await stall.close();
  await vi.waitFor(async () => { expect((await stall.get()).summary).toBe(good); }, { timeout: 15_000 });
  await stall.observe(report.sessionId, 'absent', mirror.id);
  await vi.waitFor(() => { expect(calls).toBe(3); }, { timeout: 15_000 });
  await vi.waitFor(async () => { expect((await stall.get()).summaryPending).toBe(false); }, { timeout: 15_000 });
  const shown = await stall.get();
  expect(shown.summary).toBeNull();
  expect(shown).not.toHaveProperty('summaryOutdated');
}, 30_000);
it('keeps the newer summary when an older write for the same report finishes after it', async () => {
  // The app gets no model, so only the two writes below reach one, and the test awaits each write to its end.
  stall = await closedStall(db);
  const mirror = await stall.add('Mirror');
  await stall.sell();
  const before = await stall.close() as unknown as ClosingReport;
  const after = (await stall.observe(before.sessionId, 'absent', mirror.id)).json().closing as ClosingReport;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  model = new MockLanguageModelV4({ doGenerate: async () => { if (++calls === 1) await held; return reply(good); } });
  const service = summaryService({ db, model, dailyCap: 3, now: () => new Date('2026-11-05T12:00:00Z') });
  const older = service.write(before, () => undefined);
  await vi.waitFor(() => { expect(calls).toBe(1); }, { timeout: 15_000 });
  expect(await service.write(after, () => undefined)).toBe(good);
  release();
  expect(await older).toBe(good);
  expect(await stall.get()).toMatchObject({ summary: good });
  expect(calls).toBe(2);
}, 30_000);
it('writes one summary for a close, even after repair moves the session from closing to closed', async () => {
  await start();
  expect(model.doGenerateCalls).toHaveLength(1);
  await repairClosings(db, new Date('2026-11-05T12:05:00Z'));
  expect((await db.query("select status from trading_sessions where id=$1", [(await stall.get()).closing.sessionId])).rows[0].status).toBe('closed');
  expect(await stall.get()).toMatchObject({ summary: good, summaryPending: false });
  expect(model.doGenerateCalls).toHaveLength(1);
});
it('tries at most two drafts for the same report, never retrying on refresh', async () => {
  model = new MockLanguageModelV4({ doGenerate: reply('Sales were £35.00 today.') });
  stall = await closedStall(db, { model }); await stall.sell(); await stall.close();
  for (let read = 0; read < 3; read++) await stall.get();
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(await stall.get()).toMatchObject({ summary: null, summaryPending: false });
});
it('shows the plain report with no error when the model fails', async () => {
  await start();
  model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('overloaded'); } });
  await stall.app.close();
  stall = await closedStall(db, { model }); await stall.sell(); await stall.close();
  const response = await stall.post('/api/owner/closing/summary');
  expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ summary: null });
  const report = await stall.get();
  expect(report.closing.status).toBe('final'); expect(report.summary).toBeNull();
});
it.each([
  ['an invented amount', 'Sales were £35.00 today.'],
  ['an invented count', 'The report is provisional. 7 items sold.'],
  ['a derived figure', 'About 50% of items sold.'],
  ['a spelled-out figure', 'Three items sold.'],
  ['a vague share', 'Half the items sold.'],
  ['an accusation', 'The lamp was stolen.'],
  ['a hint of blame', 'Someone took it without paying.'],
  ['blame around a named item', 'Someone took the brass lamp without paying.'],
  ['blame with no taking word', 'A buyer left without paying.'],
  ['an unfinished answer', good, 'length'],
])('drops a summary with %s and spends its tokens on the record', async (_name, text, finish) => {
  model = new MockLanguageModelV4({ doGenerate: reply(text, finish) });
  stall = await closedStall(db, { model }); await stall.sell(); await stall.close();
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: null });
  expect((await stall.get()).summary).toBeNull();
  expect((await db.query('select input_tokens from ai_usage')).rows).toHaveLength(1);
});
it('logs the refusal rule and finish reason, and shows nothing, when the figure check refuses', async () => {
  model = new MockLanguageModelV4({ doGenerate: reply('Sales were £35.00 today.') });
  stall = await closedStall(db, { model }); await stall.sell(); await stall.close();
  const warnings: string[] = [];
  const report = (await stall.get()).closing as ClosingReport;
  const service = summaryService({ db, model, dailyCap: 3, now: () => new Date('2026-11-05T12:00:00Z') });
  expect(await service.write(report, message => warnings.push(message))).toBeNull();
  expect(warnings).toEqual(['Closing summary refused: unknown-amount, retrying once', 'Closing summary refused: unknown-amount, finish stop']);
});
it('gives the demo stall a trace of each request, and gives a real owner none', async () => {
  const refused = 'Sales were £35.00 today.';
  let next = refused;
  model = new MockLanguageModelV4({ doGenerate: async () => reply(next) });
  stall = await closedStall(db, { model }); await stall.sell(); await stall.close();
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: null });
  // Swap the two stalls' kinds. The unique index on the kind is dropped for the swap and restored in the finally block below.
  await db.query('drop index stalls_one_per_kind');
  await db.query('update stalls set is_demo = not is_demo');
  try {
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: null, trace: { outcome: 'refused', refusal: 'unknown-amount', finishReason: 'stop', inputTokens: 1800, outputTokens: 240 } });
  next = good;
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: good, trace: { outcome: 'shown', finishReason: 'stop', inputTokens: 900, outputTokens: 120 } });
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: good, trace: { outcome: 'saved' } });
  } finally {
    await db.query('update stalls set is_demo = not is_demo');
    await db.query('create unique index stalls_one_per_kind on stalls (is_demo)');
  }
});
it('writes nothing when the daily budget is reached or no model is configured', async () => {
  model = new MockLanguageModelV4({ doGenerate: reply(good) });
  stall = await closedStall(db, { model });
  await db.query("insert into ai_usage (day,input_tokens,output_tokens,cost_usd) values ('2026-11-05',0,0,3)");
  await stall.sell(); await stall.close();
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: null });
  expect(model.doGenerateCalls).toHaveLength(0);
  await stall.app.close();
  stall = await closedStall(db); await stall.sell(); await stall.close();
  expect((await stall.post('/api/owner/closing/summary')).json()).toEqual({ summary: null });
});
it('needs the owner and a closing report', async () => {
  stall = await closedStall(db, { model: new MockLanguageModelV4({ doGenerate: reply(good) }) });
  expect((await stall.post('/api/owner/closing/summary')).statusCode).toBe(409);
  expect((await stall.app.inject({ method: 'POST', url: '/api/owner/closing/summary' })).statusCode).toBe(401);
});

const input = {
  reportStatus: 'final', recordedSales: '£28.00', refunded: '£4.00', paidCheckouts: 2, itemsSold: 1, itemsInReport: 3, groupsWithItems: 1,
  groups: [{ label: 'Sold, gone with the buyer', count: 1, items: [{ name: 'Lamp 40 cm', code: 'K7Q2', refunded: false }] }, { label: 'Unsold, still at the stall', count: 2, items: [] }],
  removed: [{ name: 'Mirror', code: 'M2R9', reason: 'Sold for £5 cash' }],
};
const freeInput = { ...input, itemsTakenFree: 1, tips: '£2.00', tipCount: 1,
  groups: [...input.groups, { label: 'Taken free, gone with the taker', count: 1, items: [{ name: 'Cookbooks', code: 'BOOK', refunded: false }] }] };
it.each([
  'The free item was taken without payment, with £2.00 in tips recorded.',
  'A buyer took Cookbooks without paying. A tip was recorded.',
  'Cookbooks was taken by a buyer without payment. A tip was recorded.',
  'A visitor took the free Cookbooks and left a tip.',
  'Someone took Cookbooks free of charge.',
])('accepts an honest recorded free take: %s', text => {
  expect(checkSummaryText(text, freeInput)).toEqual({ text });
});
it.each([
  "A buyer didn't pay for Lamp 40 cm.",
  'Someone stole Cookbooks.',
  'A buyer took Lamp 40 cm without paying.',
  'A buyer took Cookbooks without paying for Lamp 40 cm.',
  'A buyer took Cookbooks Deluxe without paying.',
  'A buyer took the free item without paying, then stole the lamp.',
  "Cookbooks was taken without payment. A buyer didn't pay for the lamp.",
  'A buyer took the free Lamp 40 cm without paying.',
  'A visitor took Lamp 40 cm free of charge.',
  'Someone took the items free of charge.',
])('still refuses blame when the report also has a free take: %s', text => {
  expect(checkSummaryText(text, freeInput)).toEqual({ refusal: 'accusation' });
});
it('does not allow free-take wording without a recorded free take', () => {
  expect(checkSummaryText('A buyer took the free item without paying.', input)).toEqual({ refusal: 'accusation' });
});
it('accepts only figures the report holds, ignoring digits in the stallholder’s own text', () => {
  expect(checkSummaryText('Final report: £28.00 recorded, £4 refunded, 2 paid checkouts, 1 item sold of 3. Lamp 40 cm (K7Q2) is still here. Mirror M2R9: Sold for £5 cash.', input)).toHaveProperty('text');
  expect(checkSummaryText('Sales: £28, with 1 removed.', input)).toHaveProperty('text');
  expect(checkSummaryText('1 item sold at £3.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('£1 refunded.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('28 items sold.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('Checked on 5 November.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('Sold — nothing else.', input)).toEqual({ text: 'Sold, nothing else.' });
  expect(checkSummaryText('Two paid checkouts and one item sold. Nobody is one of them.', input)).toHaveProperty('text');
  expect(checkSummaryText('One group needs attention.', input)).toHaveProperty('text');
  expect(checkSummaryText('Four groups need attention.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('Five items sold.', input)).toHaveProperty('refusal');
  expect(checkSummaryText('   ', input)).toHaveProperty('refusal');
});
it.each(['Fifty per cent of items sold.', 'A third of the items sold.', 'A quarter of the items sold.', 'Sales were twice the usual.', 'Thirty items sold.', 'Zero refunds.', 'Thirty pounds came in.', '3 pounds came in.', '3p came in.', 'Three pence came in.', '2 quid came in.', 'GBP 3 came in.', 'A fifth of the items sold.', 'A tenth of the items sold.', 'A couple of items sold.', 'A pair of items sold.', 'Both items sold.', 'One lamp and one mirror sold.', 'Items sold: one.', 'Refunds, one, recorded.', 'Only one.', 'Consider listing a similar one.', 'The one purchase was the lamp.', 'The one thing that sold was the lamp.', 'That one buyer paid.', 'This one lamp sold.', 'The other one mirror sold.', 'The one lamp and the one mirror sold.', 'Which one sold?', 'Each one sold.', 'Every one sold.', 'Any one sold.', 'Another one sold.', 'That one Lamp 40 cm is here.', 'The one Lamp 40 cm in the corner sold.', 'This one Lamp 40 cm.'])('refuses a figure it cannot check: %s', text => {
  expect(checkSummaryText(text, input)).toHaveProperty('refusal');
});
it('checks the tens and zero by value, and leaves money words in the stallholder’s own text alone', () => {
  const groups = [{ label: 'Sold, gone with the buyer', count: 30, items: [] }];
  expect(checkSummaryText('Thirty items need attention.', { ...input, groups })).toHaveProperty('text');
  expect(checkSummaryText('Zero items sold.', { ...input, itemsSold: 0 })).toHaveProperty('text');
  expect(checkSummaryText('Mirror: 5 pounds in cash.', { ...input, removed: [{ name: 'Mirror', code: 'M2R9', reason: '5 pounds in cash' }] })).toHaveProperty('text');
});
it('accepts "one" where it is no figure, and vague words inside the stallholder’s own text', () => {
  for (const text of ['No one has checked the shelf.', 'One of the groups needs attention.', 'This one needs your attention.', 'The group is the one for items off the shelf.', 'Check the other one.', 'That one was refunded.', 'The one that sold was the lamp.', 'The one in the corner sold.', 'Look at the one, then the shelf.'])
    expect(checkSummaryText(text, input), text).toHaveProperty('text');
  expect(checkSummaryText('Pair of candlesticks is still here.', { ...input, groups: [{ label: 'Unsold, still at the stall', count: 1, items: [{ name: 'Pair of candlesticks', code: 'P4R1', refunded: false }] }] })).toHaveProperty('text');
});
it('matches the stallholder’s own text whatever capitals the model writes, so a name that holds a quantity word still passes', () => {
  const groups = [{ label: 'Unsold, still at the stall', count: 1, items: [{ name: 'Ceramic mugs, pair', code: 'M2G9', refunded: false }] }];
  expect(checkSummaryText('The ceramic mugs, pair, are still here.', { ...input, groups })).toHaveProperty('text');
  expect(checkSummaryText('The ceramic mugs are a pair.', { ...input, groups })).toHaveProperty('refusal');
  expect(checkSummaryText('Lamp 40 CM (k7q2) is still here.', input)).toHaveProperty('text');
});
it('names the rule that refused a summary, never carrying the text', () => {
  const refusal = (text: string) => checkSummaryText(text, input);
  expect(refusal('Someone stole it.')).toEqual({ refusal: 'accusation' });
  expect(refusal('Half the items sold.')).toEqual({ refusal: 'vague-quantity' });
  expect(refusal('Items sold: one.')).toEqual({ refusal: 'unchecked-one' });
  expect(refusal('3 pounds came in.')).toEqual({ refusal: 'money-wording' });
  expect(refusal('7 items sold.')).toEqual({ refusal: 'unknown-count' });
  expect(refusal('Sales were £35.00.')).toEqual({ refusal: 'unknown-amount' });
  expect(refusal('Five items sold.')).toEqual({ refusal: 'unknown-spelled-count' });
  expect(refusal('   ')).toEqual({ refusal: 'empty' });
  expect(refusal('x'.repeat(1501))).toEqual({ refusal: 'too-long' });
  expect(refusal('2 paid checkouts.')).toEqual({ text: '2 paid checkouts.' });
});
it('checks a count of groups against the groups, not against any count in the report', () => {
  // Real wording from the hosted service on 7 November: "Two groups need your attention." and "The stallholder needs to look at 5 groups."
  const unpaid = { label: 'Not on the shelf, no confirmed payment. This record cannot say what happened.', count: 1, items: [] };
  const unresolved = { label: 'Payment unresolved', count: 1, items: [] };
  const held = (...attention: { label: string; count: number; items: never[] }[]) => ({ ...input, paidCheckouts: 3, itemsSold: 3, itemsTakenFree: 1, tipCount: 1, itemsInReport: 14, groupsWithItems: 5, removed: [],
    groups: [{ label: 'Sold, gone with the buyer', count: 3, items: [] }, { label: 'Unsold, still at the stall', count: 2, items: [] }, ...attention] });
  expect(checkSummaryText('Two groups need your attention.', held(unpaid, unresolved))).toEqual({ text: 'Two groups need your attention.' });
  expect(checkSummaryText('The stallholder needs to look at 5 groups.', held(unpaid, unresolved))).toHaveProperty('text');
  expect(checkSummaryText('2 of the groups need your attention.', held(unpaid, unresolved))).toHaveProperty('text');
  expect(checkSummaryText('Two groups need your attention.', held(unpaid))).toEqual({ refusal: 'unknown-group-count' });
  expect(checkSummaryText('Three groups need your attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-group-count' });
  expect(checkSummaryText('One group needs your attention.', held(unpaid))).toHaveProperty('text');
  expect(checkSummaryText('The 3 groups need your attention.', held(unpaid))).toEqual({ refusal: 'unknown-group-count' });
  expect(checkSummaryText('2 items are unsold.', held(unpaid))).toHaveProperty('text');
  for (const text of ['Two of your groups need attention.', '2 other groups need checking.', 'The 2 remaining groups need checking.'])
    expect(checkSummaryText(text, held(unpaid)), text).toEqual({ refusal: 'unknown-group-count' });
  for (const text of ['Two of your groups need attention.', '2 other groups need checking.', 'The 2 remaining groups need checking.'])
    expect(checkSummaryText(text, held(unpaid, unresolved)), text).toHaveProperty('text');
  expect(checkSummaryText('No one in the groups paid twice.', held(unpaid))).toEqual({ refusal: 'vague-quantity' });
  expect(checkSummaryText('No one from these groups needs a call.', held(unpaid))).toHaveProperty('text');
  expect(checkSummaryText('2 items across groups are unsold.', held(unpaid))).toHaveProperty('text');
  expect(checkSummaryText('£36.75 across two groups need attention.', { ...held(unpaid, unresolved), recordedSales: '£36.75' })).toHaveProperty('text');
  expect(checkSummaryText('£12 across two groups need attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-amount' });
  expect(checkSummaryText('£2 across three groups need attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-group-count' });
  expect(checkSummaryText('£2 across two groups need attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-amount' });
  for (const text of ['2 of the 5 groups need your attention.', 'Two of the five groups need attention.'])
    expect(checkSummaryText(text, held(unpaid)), text).toEqual({ refusal: 'unknown-group-count' });
  for (const text of ['2 of the 5 groups need your attention.', 'Two of the five groups need attention.'])
    expect(checkSummaryText(text, held(unpaid, unresolved)), text).toHaveProperty('text');
  expect(checkSummaryText('2 of the 4 groups need your attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-group-count' });
  const noTwo = { ...held(unpaid, unresolved), groups: [{ label: 'Sold, gone with the buyer', count: 3, items: [] }, unpaid, unresolved] };
  for (const text of ['Sold 3 lamps and 2 groups need attention.', 'You sold 3 and 2 groups need your attention.', 'Three sold and two groups need attention.'])
    expect(checkSummaryText(text, noTwo), text).toHaveProperty('text');
  for (const text of ['Sold 2 lamps and 2 groups need attention.', 'You sold 2 and 2 groups need your attention.', 'Two sold and two groups need attention.'])
    expect(checkSummaryText(text, noTwo), text).toHaveProperty('refusal');
  expect(checkSummaryText('2 of your older 5 groups need attention.', noTwo)).toHaveProperty('text');
  expect(checkSummaryText('2 of your older 4 groups need attention.', noTwo)).toEqual({ refusal: 'unknown-group-count' });
  for (const text of ['2 out of 5 groups need your attention.', '2 out of the 5 groups need your attention.', 'Two out of the five groups need attention.']) {
    expect(checkSummaryText(text, held(unpaid)), text).toEqual({ refusal: 'unknown-group-count' });
    expect(checkSummaryText(text, held(unpaid, unresolved)), text).toHaveProperty('text');
  }
  expect(checkSummaryText('2 out of 4 groups need your attention.', held(unpaid, unresolved))).toEqual({ refusal: 'unknown-group-count' });
  expect(checkSummaryText('You sold 4 from 2 groups.', { ...noTwo, itemsSold: 4 })).toEqual({ text: 'You sold 4 from 2 groups.' });
});
it('refuses accusing words but accepts the report’s own neutral wording', () => {
  for (const text of ['Someone stole it.', 'The thief left.', 'It went missing.', 'Possible theft.', 'A buyer did not pay.', 'Nobody to blame.', 'Someone took the lamp.', 'A buyer took it.', 'A customer walked off with the lamp.', 'Someone has taken the mug.', 'The mug was taken by a visitor.'])
    expect(checkSummaryText(text, input), text).toHaveProperty('refusal');
  expect(checkSummaryText('Not on the shelf, no confirmed payment. This record cannot say what happened.', input)).toHaveProperty('text');
  expect(checkSummaryText('The copper kettle was taken back indoors.', input)).toHaveProperty('text');
});
