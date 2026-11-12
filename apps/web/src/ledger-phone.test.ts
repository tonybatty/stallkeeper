import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { arrange, canvasHeight, canvasRowHeight, phoneBreakpoint, phoneCounts, phoneOrder } from './ledger/phone.js';
import { itemCell, itemCellOptions, setItemStoryOpener } from './ledger/itemCell.js';
import { initialReport, itemStoryReport, keepEdits } from './ledger/report.js';
import { studioRows, toStudioData, type LedgerData } from './ledger/sources.js';
import LedgerView from './views/LedgerView.vue';

vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, AgStudioLicenseManager: { setLicenseKey: vi.fn() }, singleColumnLayout: vi.fn(), studioTheme: { withParams: vi.fn() }, createAiHarness: vi.fn(), directLlmRunner: vi.fn() }));
const studio = vi.hoisted(() => ({ api: { getState: vi.fn(), setState: vi.fn() } }));
vi.mock('ag-studio-vue3', () => ({ AgStudio: { emits: ['api-ready'], mounted() { (this as unknown as { $emit: (name: string, event: unknown) => void }).$emit('api-ready', { api: studio.api }); }, template: '<div class="studio"></div>' }, createWidgets: vi.fn(() => ({ widgets: [{ id: 'line-chart', formatShape: vi.fn() }], menu: [], defaultType: 'grid' })) }));

const phonePage = (id: string) => initialReport().pages.find(page => page.id === id)!;
const idsOf = (id: string) => Object.keys(phonePage(id).widgetLayout!);
const layoutsOf = (id: string) => Object.values(phonePage(id).widgetLayout!);
const counts = { ledger: 40, offers: 30, journey: 8 };
const place = (id: string) => arrange(id, idsOf(id), layoutsOf(id) as never, 24, counts);

describe('phone report state', () => {
  it('holds no filter widgets, because the session and dates filters are in the header', () => {
    for (const page of initialReport().pages) expect(Object.keys(page.widgets ?? {})).not.toEqual(expect.arrayContaining(['session']));
    expect(JSON.stringify(initialReport())).not.toContain('date-filter');
    expect(JSON.stringify(initialReport())).not.toContain('list-filter');
  });
  it('lays the desktop out as four tiles, then the chart beside the Till roll, then the ledger', () => {
    expect(initialReport().pages[0]!.widgetLayout).toMatchObject({ 'kpi-sales': { xTrack: 0, yTrack: 0, xSpan: 6 }, hours: { xTrack: 0, yTrack: 6, xSpan: 14 }, till: { xTrack: 14, yTrack: 6, xSpan: 10 }, grid: { xTrack: 0, yTrack: 24, xSpan: 24 } });
  });
  it('fills the desktop space beside the offer donut', () => {
    expect(phonePage('offers').widgetLayout).toMatchObject({
      'kpi-rate': { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 6 },
      funnel: { xTrack: 0, yTrack: 6, xSpan: 8, ySpan: 12 },
      outcomes: { xTrack: 8, yTrack: 0, xSpan: 16, ySpan: 18 },
      prices: { xTrack: 0, yTrack: 18, xSpan: 24 },
    });
  });
  it('puts the figures first: the tiles on Takings, the outcome chart on Offers, the stamp on PayPal check', () => {
    const first = (id: string) => { const { layouts } = place(id); const ids = idsOf(id); return ids.filter((_, index) => layouts[index]!.yTrack === 0); };
    expect(first('takings')).toEqual(expect.arrayContaining(['kpi-sales', 'kpi-items']));
    expect(first('takings')).not.toContain('hours');
    expect(first('offers')).toEqual(['outcomes']);
    expect(first('paypal')).toEqual(['stamp']);
    for (const [pageId, order] of Object.entries(phoneOrder).filter(([pageId]) => pageId !== 'story')) {
      const { layouts } = place(pageId);
      const ids = idsOf(pageId);
      const top = (id: string) => layouts[ids.indexOf(id)]!.yTrack;
      expect(order.map(top)).toEqual([...order.map(top)].sort((a, b) => a - b));
    }
  });
  it('sets the four tiles two to a row', () => {
    const { layouts } = place('takings');
    const ids = idsOf('takings');
    const at = (id: string) => layouts[ids.indexOf(id)]!;
    expect(at('kpi-sales')).toMatchObject({ xTrack: 0, xSpan: 12, yTrack: 0 });
    expect(at('kpi-items')).toMatchObject({ xTrack: 12, xSpan: 12, yTrack: 0 });
    expect(at('kpi-refunds').yTrack).toBe(at('kpi-sales').ySpan);
  });
  it('makes the Till roll and every grid tall enough for all their rows, so none scrolls inside itself', () => {
    const { layouts } = place('takings');
    const ids = idsOf('takings');
    const rows = (id: string) => layouts[ids.indexOf(id)]!.ySpan * canvasRowHeight;
    expect(rows('till')).toBeGreaterThanOrEqual(counts.ledger * 49);
    expect(rows('grid')).toBeGreaterThanOrEqual(counts.ledger * 44 + 44);
    expect(layouts.every(layout => layout.xTrack === 0 || layout.xSpan === 12)).toBe(true);
    const offers = place('offers'); const offerIds = idsOf('offers');
    expect(offers.layouts[offerIds.indexOf('table')]!.ySpan * canvasRowHeight).toBeGreaterThanOrEqual(counts.offers * 44 + 44);
    const attention = place('paypal'); const paypalIds = idsOf('paypal');
    expect(attention.layouts[paypalIds.indexOf('attention')]!.ySpan * canvasRowHeight).toBeGreaterThanOrEqual(counts.ledger * 44 + 44);
  });
  it('grows every widget with the browser text size, so nothing clips at 130 percent', () => {
    const empty = { ledger: [], offers: [], journeys: [] } as unknown as LedgerData;
    expect(phoneCounts(empty).textScale).toBe(1);
    document.documentElement.style.fontSize = '20.8px';
    try { expect(phoneCounts(empty).textScale).toBeCloseTo(1.3); } finally { document.documentElement.style.fontSize = ''; }
    const ids = idsOf('takings');
    const normal = place('takings').layouts;
    const large = arrange('takings', ids, layoutsOf('takings') as never, 24, { ...counts, textScale: 1.3 }).layouts;
    for (const id of ['till', 'grid', 'kpi-sales', 'hours']) {
      const at = ids.indexOf(id);
      expect(large[at]!.ySpan * canvasRowHeight).toBeGreaterThanOrEqual((normal[at]!.ySpan - 1) * canvasRowHeight * 1.3 - canvasRowHeight);
    }
    expect(large[ids.indexOf('grid')]!.ySpan * canvasRowHeight).toBeGreaterThanOrEqual(counts.ledger * 44 * 1.3 + 44 * 1.3);
  });
  it('makes an item story a single phone column with room for every event and row', () => {
    const page = itemStoryReport().pages[0]!;
    const ids = Object.keys(page.widgetLayout!);
    const { layouts } = arrange('story', ids, Object.values(page.widgetLayout!) as never, 24, { ledger: 1, offers: 2, journey: 8 });
    expect(layouts.every(layout => layout.xTrack === 0 && layout.xSpan === 24)).toBe(true);
    const height = (id: string) => layouts[ids.indexOf(id)]!.ySpan * canvasRowHeight;
    expect(height('journey')).toBeGreaterThanOrEqual(8 * 144);
    expect(height('story-offers')).toBeGreaterThanOrEqual(2 * 44 + 44);
    expect(height('story-payment')).toBeGreaterThanOrEqual(40);
  });
  it('sizes the canvas to its widgets, so the page scrolls and the report does not', () => {
    const { layouts, rows } = place('takings');
    const bottom = Math.max(...layouts.map(layout => layout.yTrack + layout.ySpan));
    expect(rows).toBe(bottom);
    expect(canvasHeight(rows)).toBeGreaterThanOrEqual(rows * canvasRowHeight);
  });
  it('places a card an agent added after the listed widgets, at its own height', () => {
    const ids = [...idsOf('paypal'), 'card'];
    const layouts = [...layoutsOf('paypal'), { xTrack: 0, yTrack: 99, xSpan: 6, ySpan: 7 }];
    const { layouts: out } = arrange('paypal', ids, layouts as never, 24, counts);
    expect(out.at(-1)).toMatchObject({ xTrack: 0, xSpan: 24, ySpan: 7 });
    expect(out.at(-1)!.yTrack).toBe(Math.max(...out.slice(0, -1).map(layout => layout.yTrack + layout.ySpan)));
  });
  it('hands Studio a breakpoint that ends at 500 px and falls back to a column when the widgets do not match', () => {
    const breakpoint = phoneBreakpoint('takings', idsOf('takings'), counts);
    expect(breakpoint.maxWidth).toBe(500);
    const own = layoutsOf('takings').map(layout => ({ layout, minSize: { xSpan: 1, ySpan: 1 } }));
    expect(breakpoint.layout!(own as never, { columns: 24, rows: undefined })).toHaveLength(own.length);
  });
});

describe('ledger labels', () => {
  const offer = { id: 'o1', sessionId: 's1', itemId: 'i1', at: '2026-11-07T10:00:00.000Z', item: 'Lamp', code: 'BRSS', round: 1, asking: 25, offered: 20, outcome: 'Countered', card: 22, cardStatus: 'Agreed', agreed: true, becameSale: true, seeded: false };
  const ledger = { generatedAt: '2026-11-07T12:00:00.000Z', stall: { name: 'Demo stall', demo: true }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: 'Not run.' } }, sessions: [], ledger: [], offers: [offer, { ...offer, id: 'o2', becameSale: false }], items: [] } as LedgerData;
  it('reads Yes for an offer that became a sale and nothing for the rest', () => {
    expect(studioRows(ledger).offers.map(entry => entry.becameSale)).toEqual(['Yes', '']);
    expect(studioRows(ledger).offers.map(entry => entry.paid)).toEqual([1, 0]);
    const fields = (toStudioData(ledger).sources.find(source => source.id === 'offers') as unknown as { fields: { id: string; format: string }[] }).fields;
    expect(fields.find(field => field.id === 'becameSale')?.format).toBe('textFormat');
  });
  it('switches the counts on for the funnel bars', () => {
    expect(JSON.stringify(initialReport().pages.find(page => page.id === 'offers')!.widgets!.funnel)).toContain('"funnel":{"series":{"label":{"enabled":true}}}');
  });
});

describe('ledger page on a phone', () => {
  const data = { generatedAt: '2026-11-07T12:00:00.000Z', stall: { name: 'Demo stall', demo: true }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: 'Not run.' } },
    sessions: [{ id: 's1', label: 'Sat 7 Nov, 09:00', openedAt: '2026-11-07T09:00:00.000Z', closedAt: null, status: 'open', charity: null, charityPercent: null, seededPledge: false, recordedSales: 0, sales: 0, pledged: 0, donated: 0 }],
    ledger: [{ id: 'sale:1', sessionId: 's1', kind: 'Sale', at: '2026-11-07T10:00:00.000Z', amount: 22 }], offers: [], items: [] };
  const open = async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: defineComponent({ render: () => h('div') }) }] });
    await router.push('/owner/ledger');
    const wrapper = mount(LedgerView, { global: { plugins: [router] } });
    await flushPromises();
    return wrapper;
  };
  beforeEach(() => {
    vi.stubGlobal('EventSource', class { addEventListener() { /* No updates here. */ } close() { /* Nothing open. */ } });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: false } : String(input).endsWith('/journeys') ? [] : data)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  it('puts the session choice in the header and sends it to Studio as a page filter', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    studio.api.getState.mockReturnValue(initialReport());
    const wrapper = await open();
    expect(wrapper.findAll('.ledger-session option').map(option => option.text())).toEqual(['All sessions', 'Sat 7 Nov, 09:00']);
    expect(wrapper.find('.ledger-canvas').attributes('style')).toMatch(/height: \d+px/);
    await wrapper.find('.ledger-session').setValue('Sat 7 Nov, 09:00');
    const pages = (studio.api.setState.mock.calls.at(-1)![0] as ReturnType<typeof initialReport>).pages;
    const filters = (id: string) => pages.find(page => page.id === id)!.filter?.page ?? [];
    for (const id of ['takings', 'offers', 'paypal']) expect(filters(id)).toEqual([{ field: { id: 'sessions.label' }, filterWidgetId: 'header-session', model: { operator: 'isIn', value: ['Sat 7 Nov, 09:00'] } }]);
    wrapper.unmount();
  });
  it('keeps Dates, the PayPal check, Edit and Reset layout in the header menu, and no Pledge tab', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const wrapper = await open();
    expect(wrapper.findAll('[role=tab]').map(tab => tab.text())).toEqual(['Takings', 'Offers']);
    expect(wrapper.find('.ledger-menu-body').text()).toContain('Dates from');
    expect(wrapper.findAll('.ledger-menu-body button').map(button => button.text())).toEqual(['PayPal check', 'Edit', 'Reset layout']);
    await wrapper.findAll('.ledger-menu-body button')[0]!.trigger('click');
    expect(wrapper.findAll('[role=tab]').map(tab => tab.text())).toEqual(['Takings', 'Offers', 'PayPal check']);
    wrapper.unmount();
  });
  it('has no Edit on a phone, and keeps Reset layout for cards the clerk added', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const wrapper = await open();
    expect(wrapper.findAll('.ledger-menu-body button').map(button => button.text())).toEqual(['PayPal check', 'Reset layout']);
    wrapper.unmount();
  });
  it('names the way out while the clerk is open on a phone, and returns to the one-column report on leaving it or changing page', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: true } : String(input).endsWith('/journeys') ? [] : data)));
    const wrapper = await open();
    const menuButton = (text: string) => wrapper.findAll('.ledger-menu-body button').find(button => button.text() === text);
    expect(wrapper.find('.ledger').classes()).toContain('flow');
    await menuButton('Ask the clerk')!.trigger('click');
    expect(wrapper.find('.ledger').classes()).not.toContain('flow');
    await menuButton('Close the clerk')!.trigger('click');
    expect(wrapper.find('.ledger').classes()).toContain('flow');
    expect(menuButton('Ask the clerk')).toBeDefined();
    await menuButton('Ask the clerk')!.trigger('click');
    await wrapper.findAll('[role=tab]').find(tab => tab.text() === 'Offers')!.trigger('click');
    expect(wrapper.find('.ledger').classes()).toContain('flow');
    await menuButton('Ask the clerk')!.trigger('click');
    await menuButton('PayPal check')!.trigger('click');
    expect(wrapper.find('.ledger').classes()).toContain('flow');
    expect(menuButton('Ask the clerk')).toBeDefined();
    wrapper.unmount();
  });
  it('sets no fixed canvas height on a wide screen', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const wrapper = await open();
    expect(wrapper.find('.ledger-canvas').attributes('style')).toBeUndefined();
    wrapper.unmount();
  });
  it('drops a header filter from a saved layout', () => {
    const saved = initialReport();
    saved.pages[0] = { ...saved.pages[0]!, filter: { page: [{ field: { id: 'sessions.label' }, filterWidgetId: 'header-session', model: { operator: 'isIn', value: ['x'] } }] } };
    expect(keepEdits(initialReport(), saved).pages[0]!.filter?.page).toEqual([]);
  });
});

describe('ledger grid columns on a phone', () => {
  // Studio's CSV export writes the widget's data mapping in order, so this list is the export header.
  const header = ['ledger.at', 'ledger.kind', 'ledger.item', 'ledger.code', 'ledger.priceSource', 'ledger.asking', 'ledger.amount', 'ledger.status'];
  const gridCols = () => ((initialReport().pages[0]!.widgets!.grid as unknown as { dataMapping: { cols: { id: string }[] } }).dataMapping.cols.map(col => col.id));
  it('uses the expected columns in CSV header order', () => {
    expect(gridCols()).toEqual(header);
  });
  it('keeps those columns in a saved layout that opens on a phone', () => {
    const [takings] = keepEdits(initialReport(), initialReport()).pages;
    expect((takings!.widgets!.grid as unknown as { dataMapping: { cols: { id: string }[] } }).dataMapping.cols.map(col => col.id)).toEqual(header);
  });
  const linked = (values: Record<string, unknown>) => (ref: { id: string }) => values[ref.id];
  it('draws the London date and time as separate parts on a phone and keeps the grid format above it', () => {
    const field = { fieldId: 'ledger.at' } as Parameters<NonNullable<typeof itemCellOptions.createCellRenderer>>[0];
    const render = itemCellOptions.createCellRenderer!(field) as (params: { value: unknown; valueFormatted?: string }) => HTMLElement;
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const cell = render({ value: new Date('2026-07-07T09:05:32Z'), valueFormatted: '07/07/2026, 10:05' });
    expect(cell.textContent).toBe('7 Jul, 10:05');
    expect(cell.querySelector('.ledger-when-date')!.textContent).toBe('7 Jul, ');
    expect(cell.lastChild!.textContent).toBe('10:05');
    expect(cell.getAttribute('datetime')).toBe('2026-07-07T09:05:32.000Z');
    expect(cell.getAttribute('aria-label')).toBe('7 Jul, 10:05');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const wide = render({ value: '2026-07-07T09:05:32Z', valueFormatted: '07/07/2026, 10:05' });
    expect(wide.textContent).toBe('07/07/2026, 10:05');
    expect(wide.querySelector('.ledger-when-date')).toBeNull();
    expect(wide.getAttribute('aria-label')).toBe('7 Jul, 10:05');
    vi.unstubAllGlobals();
  });
  it('shows the amount under the item on a phone, naming a refund, a tip and a sale', () => {
    const text = (kindName: string, amount: number) => (itemCell('Brass lamp', linked({ 'ledger.amount': amount, 'ledger.kind': kindName }), true) as HTMLElement).textContent;
    expect(text('Sale', 22)).toBe('Brass lamp£22.00');
    expect(text('Refund', -22)).toBe('Brass lampRefund -£22.00');
    expect(text('Tip', 3.5)).toBe('Brass lampTip £3.50');
    const refund = itemCell('Brass lamp', linked({ 'ledger.amount': -22, 'ledger.kind': 'Refund' }), true) as HTMLElement;
    expect(refund.querySelector('.ledger-item-amount')!.getAttribute('data-kind')).toBe('refund');
  });
  it('leaves the item as plain text on a desktop, or when the amount did not arrive', () => {
    expect(itemCell('Brass lamp', linked({ 'ledger.amount': 22, 'ledger.kind': 'Sale' }), false)).toBe('Brass lamp');
    expect(itemCell('Brass lamp', linked({}), true)).toBe('Brass lamp');
  });
  it('escapes an item name, because Studio would otherwise render a string as HTML', () => {
    const cell = itemCell('<b>x</b>', linked({ 'ledger.amount': 1, 'ledger.kind': 'Sale' }), true) as HTMLElement;
    expect(cell.querySelector('b')).toBeNull();
    expect(cell.querySelector('.ledger-item-name')!.textContent).toBe('<b>x</b>');
  });
  it('makes the item name itself the story link, with no second link beside it', () => {
    const plain = itemCell('Brass lamp', linked({ 'ledger.amount': 22, 'ledger.kind': 'Sale' }), true) as HTMLElement;
    expect(plain.querySelector('button')).toBeNull();
    const withStory = itemCell('Brass lamp', linked({ 'ledger.amount': 22, 'ledger.kind': 'Sale' }), true, 'item-1', vi.fn()) as HTMLElement;
    const buttons = withStory.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe('Brass lamp£22.00');
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Open item story: Brass lamp, £22.00');
    expect(withStory.textContent).not.toContain('Open item story');
  });
  it('opens an item row by its linked ID', () => {
    const open = vi.fn();
    const linkedCell = itemCell('Brass lamp', linked({}), false, 'item-1', open) as HTMLElement;
    linkedCell.querySelector<HTMLButtonElement>('.ledger-item-story')!.click();
    expect(open).toHaveBeenCalledWith('item-1');
  });
  it('offers no story on a row with no item, such as a donation', () => {
    const field = { fieldId: 'ledger.item', name: 'Item', context: { itemId: 'ledger.itemId', amount: 'ledger.amount', kind: 'ledger.kind' } } as never;
    const render = itemCellOptions.createCellRenderer!(field) as unknown as (params: unknown) => HTMLElement | string;
    const open = vi.fn();
    setItemStoryOpener(open);
    const cell = render({ value: 'Donation', getLinkedValue: linked({ 'ledger.itemId': null }) });
    setItemStoryOpener(undefined);
    expect(typeof cell === 'string' ? cell : cell.querySelector('.ledger-item-story')).toBe(typeof cell === 'string' ? 'Donation' : null);
    expect((itemCell('Donation', linked({ 'ledger.amount': 5, 'ledger.kind': 'Donation' }), true, undefined, open) as HTMLElement).querySelector('.ledger-item-story')).toBeNull();
  });
  // Studio calls a grid cell renderer with only the value and `getLinkedValue`, never a grid context.
  it('shows the story action on a grid item row from the opener the view registers', () => {
    const field = { fieldId: 'offers.item', name: 'Item', context: { itemId: 'offers.itemId' } } as never;
    const render = itemCellOptions.createCellRenderer!(field) as unknown as (params: unknown) => HTMLElement | string;
    const params = { value: 'Brass lamp', getLinkedValue: linked({ 'offers.itemId': 'item-1' }) };
    expect(render(params)).toBe('Brass lamp');
    const open = vi.fn();
    setItemStoryOpener(open);
    const cell = render(params) as HTMLElement;
    setItemStoryOpener(undefined);
    cell.querySelector<HTMLButtonElement>('.ledger-item-story')!.click();
    expect(open).toHaveBeenCalledWith('item-1');
  });
  it('links nothing for an Item field that names no item ID', () => {
    const journeyItem = { fieldId: 'journeys.item', name: 'Item' } as never;
    expect(itemCellOptions.getLinkedFields!(journeyItem)).toBeUndefined();
    expect(itemCellOptions.createCellRenderer!(journeyItem)).toBeUndefined();
  });
  it('links the amount and kind to the Item column only, so no other column changes', () => {
    const item = { fieldId: 'ledger.item', context: { itemId: 'ledger.itemId', amount: 'ledger.amount', kind: 'ledger.kind' } } as never;
    const offerItem = { fieldId: 'offers.item', context: { itemId: 'offers.itemId' } } as never;
    const other = { fieldId: 'ledger.code' } as never;
    expect(itemCellOptions.getLinkedFields!(item)).toEqual([{ id: 'ledger.amount', aggregation: 'first' }, { id: 'ledger.kind', aggregation: 'first' }, { id: 'ledger.itemId', aggregation: 'first' }]);
    expect(itemCellOptions.getLinkedFields!(offerItem)).toEqual([{ id: 'offers.itemId', aggregation: 'first' }]);
    expect(itemCellOptions.getLinkedFields!(other)).toBeUndefined();
    expect(itemCellOptions.createCellRenderer!(other)).toBeUndefined();
    expect(itemCellOptions.createCellRenderer!(item)).toBeTypeOf('function');
  });
});
