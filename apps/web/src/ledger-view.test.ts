import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import CheckStamp from './ledger/CheckStamp.vue';
import PledgeProgress from './ledger/PledgeProgress.vue';
import { itemCellOptions } from './ledger/itemCell.js';
import LedgerView from './views/LedgerView.vue';

vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, AgStudioLicenseManager: { setLicenseKey: vi.fn() }, singleColumnLayout: {}, studioTheme: { withParams: vi.fn() }, createAiHarness: vi.fn(), directLlmRunner: vi.fn() }));
const studio = vi.hoisted(() => ({ api: { getState: vi.fn(), getHistory: vi.fn(), setState: vi.fn(), getDataEngine: vi.fn(() => ({ applyTransaction: vi.fn() })) } }));
vi.mock('ag-studio-vue3', () => ({ AgStudio: { name: 'AgStudio', props: ['context', 'initialState', 'drillThrough', 'data', 'mode', 'panels'], emits: ['api-ready'], mounted() { (this as unknown as { $emit: (name: string, event: unknown) => void }).$emit('api-ready', { api: studio.api }); }, template: '<div class="studio"><div v-if="mode === \'edit\'" class="ag-studio-ai-assistant-panel"></div></div>' }, createWidgets: vi.fn(() => ({ widgets: [{ id: 'line-chart', formatShape: vi.fn() }], menu: [], defaultType: 'grid' })) }));

class FakeStream {
  static CLOSED = 2;
  static opened: FakeStream[] = [];
  closed = false;
  readyState = 1;
  onopen?: () => void;
  onerror?: () => void;
  listeners: (() => void)[] = [];
  constructor() { FakeStream.opened.push(this); }
  addEventListener(_name: string, listener: () => void) { this.listeners.push(listener); }
  close() { this.closed = true; }
}
const ledger = { generatedAt: '2026-11-07T12:00:00.000Z', stall: { name: 'Demo stall', demo: true }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: 'Not run.' } }, sessions: [], ledger: [], offers: [{ id: 'o1', sessionId: 's1', itemId: 'i1', at: '2026-11-07T12:01:00.000Z', item: 'Brass lamp', code: 'BRSS', round: 1, asking: 25, offered: 18, outcome: 'counter', card: 22, cardStatus: 'Shown', agreed: false, becameSale: false, seeded: false }], items: [{ id: 'i1', name: 'Brass lamp', code: 'BRSS', mode: 'Haggle', asking: 25, minimum: null, status: 'Sold', reference: null, seeded: false }] };
const replies = (aiEnabled: boolean) => vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled } : String(input).endsWith('/journeys') ? [] : ledger));

// The view finds Studio's clerk panel in the document, so only an attached view moves its notes into that panel.
async function open(attach = false) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: defineComponent({ render: () => h('div') }) }] });
  await router.push('/owner/ledger');
  return mount(LedgerView, { global: { plugins: [router] }, ...(attach ? { attachTo: document.body } : {}) });
}

beforeEach(() => { FakeStream.opened = []; studio.api.getHistory.mockReset(); vi.stubGlobal('EventSource', FakeStream); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ledger page', () => {
  it('says where the button would be that the clerk may be used up for the day', async () => {
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.text()).not.toContain('Ask the clerk');
    expect(wrapper.text()).toContain('daily AI limit');
    expect(wrapper.find('.ledger-wait').exists()).toBe(false);
    wrapper.unmount();
  });
  it('says what the AI has spent today, as a service-wide estimate', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: true } : String(input).endsWith('/journeys') ? [] : { ...ledger, aiSpend: { spentUsd: 1.256, capUsd: 3 } })));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.find('[data-test="ai-spend"]').text()).toContain('AI spend today: about £0.94 of the £2.25 daily cap. An estimate across the whole service');
    wrapper.unmount();
  });
  it('folds the clerk panel notes under About, so the conversation keeps the panel', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: true } : String(input).endsWith('/journeys') ? [] : { ...ledger, aiSpend: { spentUsd: 1.256, capUsd: 3 } })));
    const wrapper = await open(true);
    await flushPromises();
    const notes = document.querySelector<HTMLDetailsElement>('.ag-studio-ai-assistant-panel details.ledger-clerk-notes');
    expect(notes?.open).toBe(false);
    expect(notes?.querySelector('summary')?.textContent).toBe('About');
    expect(notes?.querySelector('[data-test="ai-spend"]')?.textContent).toContain('AI spend today: about £0.94 of the £2.25 daily cap.');
    expect(notes?.textContent).toContain('Part of Stallkeeper. Answers from your stall records.');
    expect(wrapper.find('.ledger-notes').exists()).toBe(false);
    wrapper.unmount();
  });
  it('shows one sentence, not a report of empty tiles, for a stall with nothing recorded', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: true } : String(input).endsWith('/journeys') ? [] : { ...ledger, offers: [], items: [] })));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.find('[data-test="ledger-empty"]').text()).toBe('Nothing recorded yet. Sales, tips and offers show here once buyers pay or make an offer.');
    expect(wrapper.find('.ledger-canvas').exists()).toBe(false);
    expect(wrapper.find('.ledger-tabs').exists()).toBe(false);
    expect(wrapper.find('.ledger-wait').exists()).toBe(false);
    wrapper.unmount();
  });
  it('shows one sentence in place of the money tiles for a stall with stock but no sales or offers, and the report once a sale arrives', async () => {
    const paid = { id: 'l1', kind: 'Sale', sessionId: 's1', itemId: 'i1', at: '2026-11-07T12:05:00.000Z', item: 'Brass lamp', code: 'BRSS', amount: 22, status: 'Paid', seeded: false };
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/config')) return Response.json({ licenceKey: null, aiEnabled: false });
      if (url.endsWith('/journeys')) return Response.json([]);
      reads += 1;
      return Response.json(reads > 1 ? { ...ledger, offers: [], ledger: [paid] } : { ...ledger, offers: [] });
    }));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.find('[data-test="ledger-empty"]').text()).toBe('No sales yet. Takings, offers and the PayPal check appear after the first sale.');
    expect(wrapper.find('.ledger-canvas').exists()).toBe(false);
    FakeStream.opened[0]!.listeners.forEach(listener => listener());
    await new Promise(resolve => setTimeout(resolve, 600));
    await flushPromises();
    expect(wrapper.find('[data-test="ledger-empty"]').exists()).toBe(false);
    const sources = wrapper.findComponent({ name: 'AgStudio' }).props('data') as { sources: { id: string; data: { id: string }[] }[] };
    expect(sources.sources.find(source => source.id === 'ledger')!.data.map(row => row.id)).toEqual(['l1']);
    wrapper.unmount();
  });
  it('shows no limit note while the page loads', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise(() => undefined)));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.text()).not.toContain('daily AI limit');
    expect(wrapper.find('.ledger-wait').exists()).toBe(true);
    wrapper.unmount();
  });
  it('opens no live stream if the owner left before the records arrived', async () => {
    let answer = () => {};
    const held = new Promise<void>(resolve => { answer = resolve; });
    const fetcher = replies(false);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (...args) => { await held; return fetcher(...args); }));
    const wrapper = await open();
    wrapper.unmount();
    answer();
    await flushPromises();
    expect(FakeStream.opened).toEqual([]);
  });
  it('closes the live stream when the owner leaves', async () => {
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    expect(FakeStream.opened).toHaveLength(1);
    wrapper.unmount();
    expect(FakeStream.opened[0]!.closed).toBe(true);
  });
  it('marks the ledger paused when the stream drops and sends an ended session to the login once the browser gives up', async () => {
    const fetcher = replies(false); vi.stubGlobal('fetch', fetcher);
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.find('.ledger-stale').exists()).toBe(false);
    const stream = FakeStream.opened[0]!;
    stream.readyState = 0; stream.onerror!(); await flushPromises();
    expect(wrapper.find('.ledger-stale').text()).toBe('Updates paused');
    stream.readyState = 1; stream.onopen!(); await flushPromises();
    expect(wrapper.find('.ledger-stale').exists()).toBe(false);
    fetcher.mockImplementation(async () => Response.json({ error: 'Log in to continue.' }, { status: 401 }));
    stream.readyState = FakeStream.CLOSED; stream.onerror!(); await flushPromises();
    expect(wrapper.vm.$router.currentRoute.value.path).toBe('/owner/login');
    wrapper.unmount();
  });
  it('opens a new stream after the browser gives up on the old one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('fetch', replies(false));
      const wrapper = await open();
      await flushPromises();
      const stream = FakeStream.opened[0]!;
      stream.readyState = FakeStream.CLOSED; stream.onerror!(); await flushPromises();
      expect(FakeStream.opened).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeStream.opened).toHaveLength(2);
      wrapper.unmount();
      expect(FakeStream.opened[1]!.closed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('opens a wide screen in edit mode with the clerk beside the report, and saves a layout only after the owner changed it', async () => {
    const state = { selectedPageId: 'takings', panels: {}, pages: [{ id: 'takings', widgets: { a: {} }, widgetLayout: { a: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 } } }] };
    studio.api.getState.mockReturnValue(state);
    localStorage.clear();
    vi.stubGlobal('fetch', replies(true));
    const wrapper = await open();
    await flushPromises();
    expect(wrapper.find('.ledger-menu-body').text()).not.toContain('Ask the clerk');
    expect(wrapper.text()).toContain('The closing report stays the record.');
    wrapper.unmount();
    expect(localStorage.length).toBe(0);
    const edited = await open();
    await flushPromises();
    (edited.findComponent('.studio') as VueWrapper).vm.$emit('state-updated', { durable: true, change: { source: { type: 'ui' } } });
    edited.unmount();
    expect(localStorage.length).toBe(1);
    localStorage.clear();
  });
  it('resets the report without giving Studio a panel change, which it cannot animate after Edit', async () => {
    const panels = { edit: { collapsed: true } };
    studio.api.getState.mockReturnValue({ selectedPageId: 'offers', panels, pages: [] });
    studio.api.setState.mockClear();
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === 'Reset layout')!.trigger('click');
    const state = studio.api.setState.mock.calls[0]![0] as { selectedPageId: string; panels: unknown; pages: unknown[] };
    expect(state.panels).toBe(panels);
    expect(state.selectedPageId).toBe('takings');
    expect(state.pages.length).toBeGreaterThan(0);
    wrapper.unmount();
  });
  it('restores the exact report history after an item story', async () => {
    const current = { selectedPageId: 'offers', panels: {}, pages: [{ id: 'offers', widgets: {}, widgetLayout: {} }] };
    const history = { type: 'AgReportHistory', current, undo: [{ id: 'u1' }], redo: [{ id: 'r1' }] };
    studio.api.getState.mockReturnValue(current);
    studio.api.getHistory.mockReturnValue(history);
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    const first = wrapper.findComponent({ name: 'AgStudio' });
    (first.props('context') as { openItemStory: (id: string) => void }).openItemStory('i1');
    await flushPromises();
    expect(wrapper.text()).toContain('Item story');
    expect(wrapper.findComponent({ name: 'AgStudio' }).props('drillThrough')).toEqual({ filter: { field: { id: 'items.id' }, operator: 'isIn', value: ['i1'] } });
    await wrapper.find('.ledger-back').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Stall ledger');
    expect(wrapper.findComponent({ name: 'AgStudio' }).props('initialState')).toEqual(history);
    wrapper.unmount();
  });
  it('restores the summary as it stood when the story was reopened with browser Forward', async () => {
    const first = { selectedPageId: 'takings', panels: {}, pages: [{ id: 'takings', widgets: {}, widgetLayout: {} }, { id: 'offers', widgets: {}, widgetLayout: {} }] };
    studio.api.getState.mockReturnValue(first);
    studio.api.getHistory.mockReturnValue({ type: 'AgReportHistory', current: first, undo: [], redo: [] });
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    const router = wrapper.vm.$router;
    (wrapper.findComponent({ name: 'AgStudio' }).props('context') as { openItemStory: (id: string) => void }).openItemStory('i1');
    await flushPromises();
    router.back();
    await flushPromises();
    expect(wrapper.text()).toContain('Stall ledger');
    const later = { ...first, selectedPageId: 'offers' };
    const laterHistory = { type: 'AgReportHistory', current: later, undo: [{ id: 'u1' }], redo: [] };
    studio.api.getState.mockReturnValue(later);
    studio.api.getHistory.mockReturnValue(laterHistory);
    await wrapper.findAll('[role="tab"]').find(tab => tab.text() === 'Offers')!.trigger('click');
    router.forward();
    await flushPromises();
    expect(wrapper.text()).toContain('Item story');
    await wrapper.find('.ledger-back').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent({ name: 'AgStudio' }).props('initialState')).toEqual(laterHistory);
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe('Offers');
    wrapper.unmount();
  });
  it('opens an item story from a grid Item cell, and offers none inside the story', async () => {
    vi.stubGlobal('fetch', replies(false));
    const wrapper = await open();
    await flushPromises();
    const field = { fieldId: 'ledger.item', name: 'Item', context: { itemId: 'ledger.itemId', amount: 'ledger.amount', kind: 'ledger.kind' } } as never;
    const render = itemCellOptions.createCellRenderer!(field) as unknown as (params: unknown) => HTMLElement | string;
    const params = { value: 'Brass lamp', getLinkedValue: (ref: { id: string }) => (ref.id === 'ledger.itemId' ? 'i1' : undefined) };
    (render(params) as HTMLElement).querySelector<HTMLButtonElement>('.ledger-item-story')!.click();
    await flushPromises();
    expect(wrapper.text()).toContain('Item story');
    expect(render(params)).toBe('Brass lamp');
    wrapper.unmount();
    expect(render(params)).toBe('Brass lamp');
  });
  it('keeps the edited summary, never the item story, as the saved layout when the owner leaves from inside a story', async () => {
    const summaryState = { selectedPageId: 'takings', panels: {}, pages: [{ id: 'takings', widgets: { a: {} }, widgetLayout: { a: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 } } }] };
    studio.api.getState.mockReturnValue(summaryState);
    localStorage.clear();
    vi.stubGlobal('fetch', replies(true));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/owner/ledger', component: LedgerView }, { path: '/elsewhere', component: defineComponent({ render: () => h('div') }) }] });
    await router.push('/owner/ledger');
    const app = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] } });
    await flushPromises();
    (app.findComponent('.studio') as VueWrapper).vm.$emit('state-updated', { durable: true, change: { source: { type: 'ui' } } });
    (app.findComponent({ name: 'AgStudio' }).props('context') as { openItemStory: (id: string) => void }).openItemStory('i1');
    await flushPromises();
    expect(app.text()).toContain('Item story');
    studio.api.getState.mockReturnValue({ selectedPageId: 'story', panels: {}, pages: [{ id: 'story', widgets: {}, widgetLayout: {} }] });
    await router.push('/elsewhere');
    await flushPromises();
    expect(app.text()).not.toContain('Item story');
    expect(JSON.parse(localStorage.getItem('stallkeeper-ledger-layout-v2-demo') ?? 'null')).toEqual(summaryState);
    app.unmount();
    localStorage.clear();
  });
  it('keeps Edit working in an item story on a wide screen with the clerk', async () => {
    studio.api.getState.mockReturnValue({ selectedPageId: 'takings', panels: {}, pages: [{ id: 'takings', widgets: {}, widgetLayout: {} }] });
    vi.stubGlobal('fetch', replies(true));
    const wrapper = await open();
    await flushPromises();
    const studioProps = () => wrapper.findComponent({ name: 'AgStudio' }).props() as { mode: string; panels: { edit: { right: string[] } }; context: { openItemStory: (id: string) => void } };
    studioProps().context.openItemStory('i1');
    await flushPromises();
    expect(wrapper.text()).toContain('Item story');
    expect(studioProps().mode).toBe('edit');
    const edit = wrapper.findAll('.ledger-menu-body button').find(button => button.text() === 'Edit')!;
    await edit.trigger('click');
    expect(studioProps().mode).toBe('edit');
    expect(studioProps().panels.edit.right).toContain('edit');
    expect(edit.attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  });
  it('opens and closes an item story with the records that arrived after the page loaded', async () => {
    const paid = { id: 'l1', kind: 'Sale', sessionId: 's1', itemId: 'i1', at: '2026-11-07T12:05:00.000Z', item: 'Brass lamp', code: 'BRSS', amount: 22, status: 'Paid', seeded: false };
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/config')) return Response.json({ licenceKey: null, aiEnabled: false });
      if (url.endsWith('/journeys')) return Response.json([]);
      reads += 1;
      return Response.json(reads > 1 ? { ...ledger, ledger: [paid] } : ledger);
    }));
    const wrapper = await open();
    await flushPromises();
    const ledgerRows = () => ((wrapper.findComponent({ name: 'AgStudio' }).props('data') as { sources: { id: string; data: { id: string }[] }[] }).sources.find(source => source.id === 'ledger')!.data.map(row => row.id));
    expect(ledgerRows()).toEqual([]);
    const context = () => wrapper.findComponent({ name: 'AgStudio' }).props('context') as { reload: () => Promise<void>; openItemStory?: (id: string) => void };
    await context().reload();
    context().openItemStory!('i1');
    await flushPromises();
    expect(ledgerRows()).toEqual(['l1']);
    expect(context().openItemStory).toBeUndefined();
    await wrapper.find('.ledger-back').trigger('click');
    await flushPromises();
    expect(ledgerRows()).toEqual(['l1']);
    wrapper.unmount();
  });
});

const widget = (rows: Record<string, unknown>[], fields: string[], context: Record<string, unknown>) => ({
  context, dataMapping: { value: fields.map(key => ({ key })) },
  widgetApi: { setDisplayState: vi.fn(), getData: vi.fn(async () => ({ results: { rows } })) },
});

describe('check stamp', () => {
  const stampFor = async (rows: Record<string, unknown>[]) => {
    const wrapper = mount(CheckStamp, { props: { params: widget(rows, ['status', 'count'], { transactionNote: () => "PayPal's transaction list was not read: PayPal refused it for this app.", reload: vi.fn() }) as never } });
    await flushPromises();
    return wrapper;
  };
  it('counts a capture still pending and says the stall is waiting on PayPal', async () => {
    const wrapper = await stampFor([{ status: 'Capture pending', count: 2 }, { status: 'PayPal agrees', count: 3 }]);
    expect(wrapper.find('.stamp').text()).toBe('Waiting on PayPal');
    expect(wrapper.text()).toContain('2 capture pending');
  });
  it('says the payments agree with PayPal when every order read agrees', async () => {
    const wrapper = await stampFor([{ status: 'PayPal agrees', count: 2 }, { status: 'Refund recorded', count: 1 }]);
    expect(wrapper.find('.stamp').text()).toBe('Agrees with PayPal');
    expect(wrapper.text()).toContain('2 of 2 read, 2 agree with PayPal');
    expect(wrapper.text()).toContain('0 not read yet');
    expect(wrapper.find('.muted').exists()).toBe(false);
  });
  it('still agrees with an order not read yet, and counts it', async () => {
    const wrapper = await stampFor([{ status: 'PayPal agrees', count: 1 }, { status: 'Confirmed by PayPal', count: 1 }]);
    expect(wrapper.find('.stamp').text()).toBe('Agrees with PayPal');
    expect(wrapper.text()).toContain('1 of 2 read, 1 agree with PayPal');
    expect(wrapper.text()).toContain('1 not read yet');
  });
  it.each(['PayPal differs', 'Needs review'])('needs a look when a row is %s', async status => {
    const wrapper = await stampFor([{ status: 'PayPal agrees', count: 4 }, { status, count: 1 }, { status: 'Waiting for PayPal to confirm', count: 1 }]);
    expect(wrapper.find('.stamp').text()).toBe('Needs a look');
  });
  it('is not checked only when no order has been read', async () => {
    const wrapper = await stampFor([{ status: 'Confirmed by PayPal', count: 10 }]);
    expect(wrapper.find('.stamp').text()).toBe('Not checked');
    expect(wrapper.text()).toContain('0 of 10 read');
  });
  it('keeps an unavailable transaction list on its own line when the payment check needs attention', async () => {
    const wrapper = await stampFor([{ status: 'PayPal differs', count: 1 }]);
    expect(wrapper.find('.muted').text()).toBe("PayPal's transaction list was not read: PayPal refused it for this app.");
    expect(wrapper.text()).not.toContain('Transaction Search');
  });
  it('shows the transaction line with the date of the closing check it came from', async () => {
    const note = "In the closing check on 7 Nov, 19:13, PayPal's transaction list was not read: PayPal could not list it at the time.";
    const wrapper = mount(CheckStamp, { props: { params: widget([{ status: 'PayPal differs', count: 1 }], ['status', 'count'], { transactionNote: () => note, reload: vi.fn() }) as never } });
    await flushPromises();
    expect(wrapper.find('.muted').text()).toBe(note);
  });
});

describe('check button', () => {
  const press = async (reload: () => Promise<void>) => {
    const params = widget([], ['status', 'count'], { transactionNote: () => '', reload });
    const wrapper = mount(CheckStamp, { props: { params: params as never } });
    await flushPromises();
    await wrapper.find('button').trigger('click');
    await flushPromises();
    return wrapper;
  };
  it('says so when the connection fails, and leaves the rows alone', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); }));
    const reload = vi.fn(async () => undefined);
    const wrapper = await press(reload);
    expect(wrapper.find('[role=status]').text()).toContain('could not run just now');
    expect(reload).not.toHaveBeenCalled();
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
  });
  const check = (extra: Record<string, unknown>) => ({ sent: 0, read: 0, agree: 0, differ: 0, notRead: 0, left: 0, orders: [], ...extra });
  it('shows the check\'s own note and refreshes the rows', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ paypalCheck: check({ sent: 1, notRead: 1, note: 'PayPal could not be read just now. 1 order was not read this time, so earlier results stand.' }) })));
    const reload = vi.fn(async () => undefined);
    const wrapper = await press(reload);
    expect(wrapper.find('[role=status]').text()).toBe('PayPal could not be read just now. 1 order was not read this time, so earlier results stand.');
    expect(reload).toHaveBeenCalledOnce();
  });
  it('does not call the rows finished when they failed to update', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ paypalCheck: check({ note: 'Every captured order already has a PayPal read, so nothing was sent to PayPal.' }) })));
    const wrapper = await press(async () => { throw new Error('Ledger read failed'); });
    expect(wrapper.find('[role=status]').text()).toContain('could not update');
  });
});

describe('pledge progress', () => {
  const fields = ['label', 'pledged', 'donated', 'sales'];
  const row = { label: 'Sat 7 Nov, 09:00', pledged: 2, donated: 0, sales: 20 };
  it('reports pledge progress without internal origin labels', async () => {
    const wrapper = mount(PledgeProgress, { props: { params: widget([row], fields, {}) as never } });
    await flushPromises();
    expect(wrapper.text()).toContain('£0.00 of £2.00 pledged');
  });
});
