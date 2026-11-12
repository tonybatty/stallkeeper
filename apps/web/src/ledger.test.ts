import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiHarness, directLlmRunner, type AgLlmAdapter } from 'ag-studio';
import { ledgerAi, paypalCheck, unresolved, unresolvedPayments } from './ledger/agents.js';
import { claudeAdapter, collectTurn, readableNotes, readableReferences } from './ledger/claudeAdapter.js';
import { initialReport, itemStoryFilter, itemStoryReport, keepEdits } from './ledger/report.js';
import { priceJourneyFixture } from './ledger/priceJourney.fixtures.js';
import { routes } from './router.js';
import { ledgerRows, offerStages, studioRows, tableChanges, toStudioData, type LedgerData, type LedgerRow, type OfferRow } from './ledger/sources.js';

vi.mock('ag-studio', () => ({ createAiHarness: vi.fn(), directLlmRunner: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); });

const row = (extra: Partial<LedgerRow>): LedgerRow => ({ id: 'sale:1', kind: 'Sale', sessionId: 's1', itemId: 'i1', at: '2026-11-07T10:00:00.000Z', hour: '10:00', item: 'Brass lamp', code: 'BRSS', mode: 'Haggle', priceSource: 'Agreed offer', asking: 25, amount: 22, recordedSales: 22, discount: 3, capture: 'Capture recorded', webhook: 'Confirmed by PayPal', paypalCheck: 'Not checked yet', status: 'Confirmed by PayPal', seeded: true, ...extra });
const offer = (extra: Partial<OfferRow>): OfferRow => ({ id: 'o1', sessionId: 's1', itemId: 'i1', at: '2026-11-07T10:00:00.000Z', item: 'Brass lamp', code: 'BRSS', round: 1, asking: 25, offered: 20, outcome: 'Countered', card: 22, cardStatus: 'Agreed', agreed: true, becameSale: true, seeded: true, ...extra });
const data = (extra: Partial<LedgerData> = {}): LedgerData => ({ generatedAt: '2026-11-07T12:00:00.000Z', stall: { name: 'Demo stall', demo: true }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: 'Not run.' } },
  sessions: [{ id: 's1', label: 'Sat 7 Nov, 09:00', openedAt: '2026-11-07T09:00:00.000Z', closedAt: null, status: 'open', charity: null, charityPercent: null, seededPledge: false, recordedSales: 22, sales: 1, pledged: 0, donated: 0 }],
  ledger: [row({})], offers: [offer({})], items: [{ id: 'i1', name: 'Brass lamp', code: 'BRSS', mode: 'Haggle', asking: 25, minimum: null, status: 'Sold', reference: null, seeded: true }], ...extra });

describe('Studio sources', () => {
  it.each([{ ledger: [] }, { ledger: [row({ status: 'PayPal agrees' })] }])('supplies a numeric zero for an unresolved-payment card with no unresolved rows', ({ ledger }) => {
    const source = toStudioData(data({ ledger })).sources.find(entry => entry.id === 'paymentSummary') as unknown as { data: { id: string; unresolved: number }[] };
    expect(source?.data).toEqual([{ id: 'stall', unresolved: 0 }]);
  });
  it('counts every unresolved status and updates the same summary row back to zero', () => {
    const ledger = ['Needs review', 'Capture pending', 'Waiting for PayPal to confirm', 'PayPal differs', 'PayPal agrees', 'Confirmed by PayPal', 'Reported by Donate button'].map((status, i) => row({ id: String(i), status }));
    const before = data({ ledger });
    const after = data({ ledger: ledger.map(entry => ({ ...entry, status: 'PayPal agrees' })) });
    const source = toStudioData(before).sources.find(entry => entry.id === 'paymentSummary') as unknown as { data: { id: string; unresolved: number }[] };
    expect(source?.data).toEqual([{ id: 'stall', unresolved: unresolved(ledger).length }]);
    expect(source?.data[0]?.unresolved).toBe(4);
    expect(tableChanges(before, after).find(change => change.tableId === 'paymentSummary')).toEqual({ tableId: 'paymentSummary', add: [], update: [{ id: 'stall', unresolved: 0 }], remove: [] });
  });
  it('keeps money as numbers and describes a refund on its own field', () => {
    const [sale, refundedSale, refund] = ledgerRows([row({}), row({ id: 'sale:2', refundedInFull: true }), row({ id: 'refund:1', kind: 'Refund', amount: -7, recordedSales: -7 })]);
    expect(sale).toMatchObject({ sold: 22, refunded: 0, itemsSold: 1 });
    expect(refundedSale).toMatchObject({ sold: 22, refunded: 0, itemsSold: 0 });
    expect(refund).toMatchObject({ sold: 0, refunded: 7, itemsSold: 0 });
    expect(typeof sale!.amount).toBe('number');
  });
  it('keeps a donation out of sold and refunded', () => {
    expect(ledgerRows([row({ kind: 'Donation', amount: 3, recordedSales: 0 })])[0]).toMatchObject({ sold: 0, refunded: 0, recordedSales: 0, itemsSold: 0 });
  });
  it('tells the agents a tip is recorded sales and not an item sold', () => {
    const ledger = toStudioData(data()).sources.find(source => source.id === 'ledger') as unknown as { description: string };
    expect(ledger.description).toContain('kind is Sale, Tip, Refund');
    expect(ledger.description).toContain('counts in recordedSales but is not an item sold');
  });
  it('tells owners and the clerk that offers asking is the current price', () => {
    const offers = toStudioData(data()).sources.find(source => source.id === 'offers') as unknown as { description: string; fields: { id: string; name: string }[] };
    expect(offers.fields.find(field => field.id === 'asking')?.name).toBe('Current asking price');
    expect(offers.description).toContain('asking is the current asking price of the item, not the price when the offer was made');
    const page = initialReport().pages.find(entry => entry.id === 'offers');
    expect(JSON.stringify(page?.widgets?.prices)).toContain('Asking and offer price by tag');
  });
  it('counts a tip as money taken, so its refund has a base, but not as an item sold', () => {
    expect(ledgerRows([row({ kind: 'Tip', amount: 2, recordedSales: 2, asking: 5 })])[0]).toMatchObject({ sold: 2, itemsSold: 0 });
  });
  it('counts each offer once per stage it reached', () => {
    const stages = offerStages([offer({}), offer({ id: 'o2', card: null, agreed: false, becameSale: false }), offer({ id: 'o3', becameSale: false, agreed: false })]);
    const count = (stage: string) => stages.filter(entry => entry.stage === stage).length;
    expect([count('Offers'), count('Offer shown'), count('Agreed'), count('Paid')]).toEqual([3, 2, 1, 1]);
  });
  it('keeps seeded wording out of the ledger fields', () => {
    const fields = (toStudioData(data()).sources.find(source => source.id === 'ledger') as unknown as { fields: { id: string; hide?: boolean }[] }).fields;
    expect(fields.find(field => field.id === 'seeded')).toBeUndefined();
    const sources = toStudioData(data()).sources as unknown as { fields?: { name: string }[] }[];
    expect(sources.flatMap(source => source.fields ?? []).map(field => field.name)).not.toContain('Seeded');
  });
  it('sends only what changed when a refetch arrives', () => {
    const before = data();
    const after = data({ ledger: [row({ status: 'PayPal agrees' }), row({ id: 'sale:2', code: 'MRRR' })] });
    expect(tableChanges(before, before)).toEqual([]);
    const [change] = tableChanges(before, after);
    expect(change).toMatchObject({ tableId: 'ledger', remove: [] });
    expect(change!.add.map(entry => entry.id)).toEqual(['sale:2']);
    expect(change!.update.map(entry => entry.status)).toEqual(['PayPal agrees']);
    expect(tableChanges(after, before)[0]!.remove).toEqual(['sale:2']);
  });
  it('keeps a session that first trades on a live refresh at the top of the list', () => {
    const before = data();
    const today = { ...before.sessions[0]!, id: 's2', label: 'Sun 8 Nov, 09:00', openedAt: '2026-11-08T09:00:00.000Z' };
    const after = data({ sessions: [today, before.sessions[0]!], ledger: [row({}), row({ id: 'sale:2', sessionId: 's2' })] });
    const change = tableChanges(before, after).find(entry => entry.tableId === 'sessions');
    expect(change!.remove).toEqual(['s1']);
    expect(change!.add.map(entry => entry.id)).toEqual(['s2', 's1']);
    expect(change!.update).toEqual([]);
  });
  it('holds every table the page reads', () => {
    expect(Object.keys(studioRows(data()))).toEqual(['sessions', 'ledger', 'offers', 'stages', 'items', 'journeys', 'paymentSummary']);
  });
  it('appends a paid event to the live journey transaction', () => {
    const before = data({ journeys: priceJourneyFixture.slice(0, -2) });
    const paid = priceJourneyFixture.find(event => event.stage === 'Paid')!;
    const change = tableChanges(before, data({ journeys: [...before.journeys!, paid] })).find(entry => entry.tableId === 'journeys');
    expect(change).toMatchObject({ add: [paid], update: [], remove: [] });
  });
});

describe('report state', () => {
  it('constructs an item drill-through and a private item report', () => {
    expect(itemStoryFilter('i1')).toEqual({ filter: { field: { id: 'items.id' }, operator: 'isIn', value: ['i1'] } });
    const story = itemStoryReport();
    expect(story.selectedPageId).toBe('story');
    expect(Object.keys(story.pages[0]!.widgets!)).toEqual(['journey', 'story-offers', 'story-payment']);
    expect(JSON.stringify(story)).not.toMatch(/floor|buyer/i);
  });
  it('gives each item story grid the full desktop width, as the summary grids have, so no columns scroll sideways', () => {
    const layout = itemStoryReport().pages[0]!.widgetLayout!;
    for (const id of ['story-offers', 'story-payment']) expect(layout[id]).toMatchObject({ xTrack: 0, xSpan: 24 });
    expect(layout['story-payment']!.yTrack).toBeGreaterThanOrEqual(layout['story-offers']!.yTrack + layout['story-offers']!.ySpan);
  });
  it('starts on Takings with no filter on any page and the side panels shut', () => {
    const state = initialReport();
    expect(state.selectedPageId).toBe('takings');
    expect(state.panels).toMatchObject({ filters: { collapsed: true }, data: { collapsed: true } });
    expect(state.pages.map(page => page.id)).toEqual(['takings', 'offers', 'paypal']);
    expect(state.pages.map(page => page.filter)).toEqual([undefined, undefined, undefined]);
  });
  it('covers every session\'s sale and offer in the first state', () => {
    const later = { ...row({ id: 'sale:2', sessionId: 's2', recordedSales: 10, amount: 10 }) };
    const sessions = [{ ...data().sessions[0]!, id: 's2', label: 'Sun 8 Nov, 09:00' }, data().sessions[0]!];
    const studio = studioRows(data({ ledger: [row({}), later], sessions }));
    expect(studio.ledger.map(entry => entry.sessionId)).toEqual(['s1', 's2']);
    expect(studio.offers).toHaveLength(1);
    expect(studio.sessions.map(entry => entry.label)).toEqual(['Sun 8 Nov, 09:00', 'Sat 7 Nov, 09:00']);
  });
  it('passes the seeded flag through on rows as a plain boolean', () => {
    const rows = ledgerRows([row({}), row({ id: 'sale:2', seeded: false })]);
    expect(rows.map(entry => entry.seeded)).toEqual([true, false]);
    expect(studioRows(data({ offers: [offer({}), offer({ id: 'o2', seeded: false })] })).offers.map(entry => entry.seeded)).toEqual([true, false]);
  });
  it('brings back saved edits but never last time\'s session or cross filter, so a layout from before opens on every session', () => {
    const built = initialReport();
    const [takings] = built.pages;
    const saved = { ...built, pages: [{ ...takings!, widgets: { ...takings!.widgets, card: { type: 'value' } }, crossFilter: { values: { till: [] } },
      filter: { page: [{ field: { id: 'sessions.label' }, filterWidgetId: 'session', model: { operator: 'isIn', value: ['Old session'] } }, { field: { id: 'ledger.kind' } }], widget: { card: [{ field: { id: 'ledger.status' } }] } } }] } as unknown as typeof built;
    const [page] = keepEdits(built, saved).pages;
    expect(page!.widgets).toHaveProperty('card');
    expect(page!.crossFilter).toBeUndefined();
    expect(page!.filter?.page?.map(filter => filter.field.id)).toEqual(['ledger.kind']);
    expect(page!.filter?.widget).toHaveProperty('card');
  });
  it('sums recorded sales, never the amount that holds donations', () => {
    expect(JSON.stringify(initialReport().pages[0]!.widgets?.['kpi-sales'])).toContain('ledger.recordedSales');
    expect(JSON.stringify(initialReport())).not.toContain('"ledger.amount","aggregation"');
  });
  it('uses short chart titles, pound axes and no KPI sparklines', () => {
    type Widget = { type: string; dataMapping: Record<string, unknown>; format: { title: { text: string }; style?: { custom?: { valueAxis?: { title?: { text?: string } } } } } };
    const widgets = (id: string) => initialReport().pages.find(page => page.id === id)!.widgets as unknown as Record<string, Widget>;
    const { hours } = widgets('takings');
    const { prices } = widgets('offers');
    expect([hours!.format.title.text, prices!.format.title.text]).toEqual(['Takings by hour', 'Asking and offer price by tag']);
    expect([hours!.format.style?.custom?.valueAxis?.title?.text, prices!.format.style?.custom?.valueAxis?.title?.text]).toEqual(['£', '£']);
    const kpis = initialReport().pages.flatMap(page => Object.values(page.widgets as unknown as Record<string, Widget>)).filter(widget => widget.type === 'value');
    expect(kpis.length).toBeGreaterThan(0);
    for (const widget of kpis) expect(widget.dataMapping).not.toHaveProperty('sparklineX');
  });
  it('auto-sizes every grid so payment amounts, states and item names are not clipped', () => {
    type Grid = { type?: string; format?: { style?: { columnAutoSize?: boolean } } };
    const widgets = [...initialReport().pages, ...itemStoryReport().pages]
      .flatMap(page => Object.values(page.widgets ?? {})) as Array<Grid | undefined>;
    const grids = widgets.filter((widget): widget is Grid => widget?.type === 'grid');
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) expect(grid.format?.style?.columnAutoSize).toBe(true);
  });
  it('keeps the PayPal grid to the distinct facts that fit beside the amount and status', () => {
    const page = initialReport().pages.find(entry => entry.id === 'paypal')!;
    const payment = page.widgets!.attention as unknown as { dataMapping: { cols: Array<{ id: string }> } };
    expect(payment.dataMapping.cols.map(field => field.id)).toEqual(['ledger.at', 'ledger.item', 'ledger.code', 'ledger.amount', 'ledger.capture', 'ledger.status']);
  });
});

describe('Claude adapter', () => {
  const finish = { type: 'FINISH' as const, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 8 } };
  it('folds a turn into output items, pairing the call id Studio will answer', () => {
    const response = collectTurn([
      { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Checking.' }, { type: 'TEXT_MESSAGE_END', messageId: 'm' },
      { type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'view_schema' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: '{"a":1}' }, { type: 'TOOL_CALL_END', toolCallId: 'c' }, finish,
    ], 'id', 1);
    expect(response.status).toBe('completed');
    expect(response.usage).toEqual(finish.usage);
    expect(response.output[0]).toMatchObject({ type: 'message', content: [{ text: 'Checking.' }] });
    expect(response.output[1]).toMatchObject({ type: 'function_call', callId: 'c', name: 'view_schema', arguments: '{"a":1}', status: 'completed' });
  });
  it('sends empty arguments as an empty object', () => {
    const response = collectTurn([{ type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'view_plan' }, { type: 'TOOL_CALL_END', toolCallId: 'c' }, finish], 'id', 1);
    expect(response.output[0]).toMatchObject({ arguments: '{}' });
  });
  it('marks a cut-off turn incomplete and a failed turn failed', () => {
    expect(collectTurn([{ ...finish, finishReason: 'length' }], 'id', 1)).toMatchObject({ status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } });
    expect(collectTurn([{ type: 'RUN_ERROR', message: 'No.' }], 'id', 1)).toMatchObject({ status: 'failed', error: { message: 'No.' } });
  });
  it('streams events and posts only what the route accepts', async () => {
    const lines = [{ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hi' }, { type: 'TEXT_MESSAGE_END', messageId: 'm' }, finish];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n'));
    vi.stubGlobal('fetch', fetcher);
    const handler = claudeAdapter().executeTurn({ input: [], instructions: 'Keep it short.', responseFormat: { type: 'text' }, model: { id: 'other' }, tools: [{ name: 'view_schema', description: 'd', parameters: {}, kind: 'client' }] });
    const events = [];
    for await (const event of handler.stream) events.push(event.type);
    expect(events).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
    expect((await handler.complete).status).toBe('completed');
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'tools']);
    expect(body.tools).toEqual([{ name: 'view_schema', description: 'd', parameters: {} }]);
  });
  const notesTurn = async (adapter: AgLlmAdapter) => {
    const delta = (text: string) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: text });
    const lines = [{ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }, delta('Summing @field[ledger.recorded'), delta('Sales] gave £10.00 for @wid'), delta('get[kpi-sales] and @table[offers]; mail me@x.'), { type: 'TEXT_MESSAGE_END', messageId: 'm' }, finish];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n')));
    const handler = adapter.executeTurn({ input: [], responseFormat: { type: 'text' } });
    let shown = '';
    for await (const event of handler.stream) if (event.type === 'TEXT_MESSAGE_CONTENT') shown += event.delta;
    return { shown, kept: (await handler.complete).output[0] };
  };
  const raw = 'Summing @field[ledger.recordedSales] gave £10.00 for @widget[kpi-sales] and @table[offers]; mail me@x.';
  it('keeps the @field, @widget and @table references in a final answer and in the turn kept as history', async () => {
    const { shown, kept } = await notesTurn(claudeAdapter());
    expect(shown).toBe(raw);
    expect(kept).toMatchObject({ content: [{ text: raw }] });
  });
  it('shows a delegated agent\'s working notes as readable text, even split across deltas, and keeps the references in its history', async () => {
    const { shown, kept } = await notesTurn(readableNotes(claudeAdapter()));
    expect(shown).toBe('Summing recorded sales gave £10.00 for kpi sales and offers; mail me@x.');
    expect(kept).toMatchObject({ content: [{ text: raw }] });
    expect(readableReferences('@field[ledger.amount] stays £22.50')).toBe('amount stays £22.50');
    expect(readableReferences('Both @field[ledger.recordedSales] and @field[sessions.recordedSales] gave £39')).toBe('Both recorded sales and session recorded sales gave £39');
    expect(readableReferences('@field[ledger.paypalCheck] and @field[refundRate]')).toBe('PayPal order read and refund rate');
  });
  it('gives the lead the plain adapter and every delegated agent, the clerk included, readable notes', async () => {
    const built = { instructions: () => '' };
    vi.mocked(directLlmRunner).mockImplementation(setup => setup as never);
    vi.mocked(createAiHarness).mockImplementation(((_api: unknown, define: (parts: unknown) => unknown) => define({ builtIn: { lead: built, data: built, planning: built, widget: built, page: built }, tools: { delegateTo: () => ({}) } })) as never);
    const adapter = claudeAdapter();
    const setup = (ledgerAi(adapter, data, () => {}) as (params: unknown) => unknown)({ api: { defineAiTool: (tool: unknown) => tool } } as never) as unknown as { agents: { id?: string; adapter: AgLlmAdapter }[] };
    const [lead, ...delegated] = setup.agents;
    expect(lead!.adapter).toBe(adapter);
    expect(delegated).toHaveLength(5);
    for (const agent of delegated) expect((await notesTurn(agent.adapter)).shown).not.toContain('@field[');
  });
  it('routes a records-and-card request through the clerk before a layout-safe page agent', () => {
    const agent = (id: string) => ({ id, instructions: () => `${id} base` });
    const targets: string[][] = [];
    vi.mocked(directLlmRunner).mockImplementation(setup => setup as never);
    vi.mocked(createAiHarness).mockImplementation(((_api: unknown, define: (parts: unknown) => unknown) => define({
      builtIn: { lead: agent('lead'), data: agent('data'), planning: agent('planning'), widget: agent('widget'), page: agent('page') },
      tools: { delegateTo: (ids: string[]) => { targets.push(ids); return { name: 'delegate_to' }; } },
    })) as never);
    const setup = (ledgerAi(claudeAdapter(), data, () => {}) as (params: unknown) => unknown)({ api: { defineAiTool: (tool: unknown) => tool } } as never) as unknown as {
      agents: { id: string; instructions?: (ctx: unknown, params: unknown) => string; tools?: (ctx: unknown, params: unknown) => unknown[] }[];
    };
    const [lead] = setup.agents;
    lead!.tools!({}, {});
    const instructions = lead!.instructions!({}, {});
    expect(targets).toEqual([['data', 'page', 'planning', 'widget', 'clerk']]);
    expect(instructions.indexOf('delegate to the Stall clerk first')).toBeLessThan(instructions.indexOf('Page or Widget agent'));
    expect(instructions).toContain('never to the Data agent, and only once per question');
    expect(instructions).toContain('never by an id');
    for (const id of ['data', 'planning']) expect(setup.agents.find(entry => entry.id === id)!.instructions!({}, {})).toContain('Finish by calling complete_task with your whole answer as the summary.');
    for (const id of ['widget', 'page']) {
      const delegate = setup.agents.find(entry => entry.id === id)!;
      expect(delegate.instructions!({}, {})).toContain('Leave the widgets already on the page where they are');
      expect(delegate.instructions!({}, {})).toContain('free space at the bottom');
    }
  });
  it('shows the clerk\'s hand-back summary readably on the delegation step, keeping the raw summary and other tool results', async () => {
    const summary = 'Recorded sales are £42.50 from @field[ledger.recordedSales] in @table[sessions].';
    const events = [
      { type: 'TOOL_CALL_START', toolCallId: 'd1', toolCallName: 'delegate_to' },
      { type: 'TOOL_CALL_RESULT', messageId: 'd1-result', toolCallId: 'd1', content: JSON.stringify({ success: true, response: summary }) },
      { type: 'TOOL_CALL_START', toolCallId: 'v1', toolCallName: 'view_schema' },
      { type: 'TOOL_CALL_RESULT', messageId: 'v1-result', toolCallId: 'v1', content: JSON.stringify({ success: true, response: summary }) },
      { type: 'TOOL_CALL_START', toolCallId: 'd3', toolCallName: 'delegate_to' },
      { type: 'TOOL_CALL_RESULT', messageId: 'd3-result', toolCallId: 'd3', content: JSON.stringify({ success: true, response: '(the delegate finished without a summary)' }) },
      { type: 'TOOL_CALL_START', toolCallId: 'd2', toolCallName: 'delegate_to' },
      { type: 'TOOL_CALL_RESULT', messageId: 'd2-result', toolCallId: 'd2', content: "Tool 'delegate_to' failed: @field[x]" },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'See @field[ledger.recordedSales] in @table[sessions] and @widget[kpi-sales].' },
    ];
    const built = { instructions: () => '' };
    vi.mocked(directLlmRunner).mockImplementation(setup => ({ ...setup, run: async function* () { yield* events; } }) as never);
    vi.mocked(createAiHarness).mockImplementation(((_api: unknown, define: (parts: unknown) => unknown) => define({ builtIn: { lead: built, data: built, planning: built, widget: built, page: built }, tools: { delegateTo: () => ({}) } })) as never);
    const setup = (ledgerAi(claudeAdapter(), data, () => {}) as (params: unknown) => unknown)({ api: { defineAiTool: (tool: unknown) => tool } } as never) as unknown as { agents: { run: (input: unknown, ctx: unknown) => AsyncIterable<{ type: string; content?: string; delta?: string }> }[] };
    const seen = [];
    for await (const event of setup.agents[0]!.run({}, {})) seen.push(event);
    expect(JSON.parse(seen[1]!.content!)).toEqual({ success: true, response: 'Recorded sales are £42.50 from recorded sales in sessions.', data: { summary } });
    expect(seen.slice(2, 4)).toEqual(events.slice(2, 4));
    expect(JSON.parse(seen[5]!.content!)).toMatchObject({ response: 'Finished.' });
    expect(seen.slice(6)).toEqual(events.slice(6));
    expect(seen[8]!.delta).toBe('See @field[ledger.recordedSales] in @table[sessions] and @widget[kpi-sales].');
  });
  it('passes the route refusal through as the turn failure', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ error: "The Stall clerk has used today's allowance." }, { status: 429 })));
    const handler = claudeAdapter().executeTurn({ input: [], responseFormat: { type: 'text' } });
    expect(await handler.complete).toMatchObject({ status: 'failed', error: { message: "The Stall clerk has used today's allowance." } });
  });
});

describe('Stall clerk tools', () => {
  it('reads only rows that still need PayPal, without PayPal references', () => {
    const rows = unresolved([row({ status: 'Needs review' }), row({ status: 'Waiting for PayPal to confirm', item: 'Mirror' }), row({ status: 'PayPal agrees', item: 'Stool' }), row({ kind: 'Donation', status: 'Reported by Donate button' })]);
    expect(rows.map(entry => entry.status)).toEqual(['Needs review', 'Waiting for PayPal to confirm']);
    expect(JSON.stringify(rows)).not.toContain('CAP1');
  });
  it('leaves seeded out of the rows the model reads', () => {
    const rows = unresolved([row({ status: 'Needs review', seeded: true })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('seeded');
  });
  it('hands the model the transaction line with its own closing check time, apart from the latest read of any kind', () => {
    const note = "In the closing check on 7 Nov, 19:13, PayPal's transaction list was not read: PayPal refused it for this app.";
    const payload = unresolvedPayments(data({ paypalCheck: { checkedAt: '2026-11-12T03:26:34.488Z', transactionList: { ran: false, checkedAt: '2026-11-07T19:13:49.000Z', note } } }));
    expect(payload.paypalCheck).toEqual({ latestReadAt: '2026-11-12T03:26:34.488Z', transactionList: { ran: false, note, closingCheckAt: '2026-11-07T19:13:49.000Z' } });
    expect(payload).toMatchObject({ count: 0, rows: [] });
    expect(payload.paypalCheck).not.toHaveProperty('checkedAt');
  });
  it('says the check could not run when the route refuses or the connection fails', async () => {
    const refused = await paypalCheck(vi.fn<typeof fetch>(async () => Response.json({ error: 'No.' }, { status: 502 })));
    const dropped = await paypalCheck(vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); }));
    expect(refused).toEqual({ ran: false, note: 'The PayPal check could not run just now. The ledger is unaffected.' });
    expect(dropped).toEqual(refused);
  });
  it('passes on the counts and the note, and leaves PayPal order ids out of what the model reads', async () => {
    // A field the route might add later, such as an order id, must not reach the model.
    const check = { sent: 2, read: 2, agree: 2, differ: 0, notRead: 0, left: 0, note: 'PayPal read 2 orders: 2 agree with the record.',
      orders: [{ codes: 'BRSS', outcome: 'agrees', note: 'PayPal and this record agree.', orderId: 'ORDER9' }], orderIds: ['ORDER9'] };
    const result = await paypalCheck(vi.fn<typeof fetch>(async () => Response.json({ paypalCheck: check })));
    expect(result).toEqual({ ran: true, note: check.note, sent: 2, read: 2, agree: 2, differ: 0, notRead: 0, left: 0, orders: [{ codes: 'BRSS', outcome: 'agrees', note: 'PayPal and this record agree.' }] });
    expect(JSON.stringify(result)).not.toContain('ORDER9');
  });
  it('posts only to the ledger\'s read-only PayPal check', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 502 }));
    await paypalCheck(fetcher);
    expect(fetcher.mock.calls).toEqual([['/api/owner/ledger/paypal-check', { method: 'POST' }]]);
  });
});

describe('the ledger route', () => {
  it('is a lazy route, so the buyer bundle does not hold it', () => {
    const route = routes.find(entry => entry.path === '/owner/ledger');
    expect(typeof route?.component).toBe('function');
    expect(routes.find(entry => entry.path === '/owner/feed')?.component).toHaveProperty('setup');
  });
});
