import { createStudio, type AgExternalShape, type AgStudioApi } from 'ag-studio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toStudioData } from './ledger/sources.js';
import { ledgerWidgets } from './ledger/widgets.js';

const stallIds = ['till-roll', 'check-stamp', 'pledge-progress', 'price-journey'];
type StallWidget = {
  id: string;
  ai?: { description?: string; usage?: string; configuration?: string };
  dataMapping?: Record<string, { required?: boolean; aiDescription?: string }>;
  formatShape?: (params: { api: AgStudioApi }) => AgExternalShape<unknown>;
  featureConfig?: { crossFilter?: { supportsHighlight?: boolean } };
  form?: (params: unknown) => unknown;
  defaultSize?: unknown;
  minSize?: unknown;
};

const registered = () => (ledgerWidgets.widgets as unknown as StallWidget[]).filter(widget => stallIds.includes(widget.id));
let api: AgStudioApi;
let root: HTMLElement;

// These run against the real AG Studio, not a mock. A mocked createWidgets would copy the fallback this test exists to catch.
describe('ledger widget catalogue', () => {
  beforeAll(() => {
    root = document.createElement('div');
    document.body.append(root);
    api = createStudio(root, { widgets: ledgerWidgets as never });
  });
  afterAll(() => { api.destroy(); root.remove(); });

  it('creates a built-in widget when a field is dropped on the canvas', () => {
    expect(ledgerWidgets.defaultType).toBe('grid');
    expect(stallIds).not.toContain(ledgerWidgets.defaultType);
  });
  it('lists the Stall widgets ahead of the built-in groups', () => {
    const [stall, ...builtIn] = ledgerWidgets.menu;
    expect(stall).toEqual({ label: 'Stall', widgetIds: stallIds });
    expect(builtIn.flatMap(group => group.widgetIds)).toContain('grid');
    expect(builtIn.flatMap(group => group.widgetIds)).toContain('column-chart-grouped');
  });
  it('still registers every Stall widget, with a form', () => {
    expect(registered().map(widget => widget.id)).toEqual(stallIds);
    expect(registered().every(widget => typeof widget.form === 'function')).toBe(true);
    expect(registered().find(widget => widget.id === 'price-journey')).toMatchObject({
      formatShape: expect.any(Function), ai: expect.any(Object), defaultSize: { width: 900, height: 420 }, minSize: { width: 320, height: 240 },
    });
  });
  it('gives every widget distinct AI guidance and an exact required mapping', () => {
    const widgets = registered();
    expect(new Set(widgets.map(widget => widget.ai?.description)).size).toBe(stallIds.length);
    expect(new Set(widgets.map(widget => widget.ai?.usage)).size).toBe(stallIds.length);
    expect(new Set(widgets.map(widget => widget.ai?.configuration)).size).toBe(stallIds.length);
    expect(new Set(widgets.map(widget => Object.values(widget.dataMapping ?? {})[0]?.aiDescription)).size).toBe(stallIds.length);
    for (const widget of widgets) {
      expect(widget.ai?.description).toBeTruthy();
      expect(widget.ai?.usage).toBeTruthy();
      expect(widget.ai?.configuration).toBeTruthy();
      const mapping = Object.values(widget.dataMapping ?? {});
      expect(mapping).toHaveLength(1);
      expect(mapping[0]).toMatchObject({ required: true });
      expect(mapping[0]?.aiDescription).toBeTruthy();
    }
  });
  it('stores the Till roll click-to-filter setting', () => {
    const till = registered().find(widget => widget.id === 'till-roll')!;
    const form = till.form!({ createDefaults: (params: unknown) => params });
    expect(form).toMatchObject({ supportsTriggerCrossFilter: true });
  });
  it('compiles each required mapping into the agent configuration schema', () => {
    for (const widget of registered()) {
      const command = api.defineAiCommand({ type: 'AgConfigureWidgetCommand', params: { widgetType: widget.id as never } });
      const schema = command.toJSONSchema() as { properties: { value: { properties: { dataMapping: { additionalProperties: boolean; required: string[]; properties: Record<string, { description: string }> } } } } };
      const mapping = schema.properties.value.properties.dataMapping;
      const [key] = Object.keys(widget.dataMapping!);
      expect(mapping.additionalProperties).toBe(false);
      expect(mapping.required).toEqual([key]);
      expect(mapping.properties[key!]!.description).toBe(widget.dataMapping![key!]!.aiDescription);
    }
  });
  it('parses every format value shown by the forms and rejects invalid agent values', () => {
    const shapes = Object.fromEntries(registered().map(widget => [widget.id, widget.formatShape!({ api })]));
    const title = { enabled: true, text: 'Waiting on PayPal', typography: { fontFamily: 'Inter', fontSize: 16, fontWeight: 'bold', fontStyle: 'normal' }, color: '#111', textAlign: 'left', wrapping: true };
    const common = { title, subtitle: title, caption: title, crossFilter: 'filter' };

    expect(shapes['till-roll']!.parse({ ...common, triggerCrossFilter: false }).success).toBe(true);
    expect(shapes['check-stamp']!.parse(common).success).toBe(true);
    expect(shapes['pledge-progress']!.parse({ ...common, crossFilter: 'none' }).success).toBe(true);
    expect(shapes['till-roll']!.parse({ ...common, triggerCrossFilter: 'false' }).success).toBe(false);
    expect(shapes['check-stamp']!.parse({ ...common, crossFilter: 'highlight' }).success).toBe(false);
    expect(shapes['pledge-progress']!.parse({ ...common, title: { textAlign: 'middle' } }).success).toBe(false);
    expect(shapes['check-stamp']!.toJSONSchema()).toMatchObject({ additionalProperties: false });
  });
  it('rejects highlight in every strict format schema', () => {
    for (const widget of registered()) {
      expect(widget.formatShape!({ api }).parse({ crossFilter: 'highlight' }).success).toBe(false);
    }
  });
  it('explicitly disables highlight on every widget', () => {
    for (const widget of registered()) {
      expect(widget.featureConfig?.crossFilter?.supportsHighlight).toBe(false);
    }
  });
});

it('renders zero in a waiting-on-PayPal value card even for an empty ledger', async () => {
  const element = document.createElement('div');
  document.body.append(element);
  const studio = createStudio(element, {
    data: toStudioData({ generatedAt: '2026-11-11T09:00:00Z', stall: { name: 'Stall', demo: false }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: '' } }, sessions: [], ledger: [], offers: [], items: [] }),
    initialState: { selectedPageId: 'payments', pages: [{ id: 'payments', widgets: {
      waiting: { type: 'value', dataMapping: { value: [{ id: 'paymentSummary.unresolved', aggregation: 'sum' }] } },
    }, widgetLayout: { waiting: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 4 } } }] },
  });
  try {
    await vi.waitFor(() => {
      expect(element.querySelector('.ag-studio-value-widget-content')?.textContent).toBe('0');
    });
  } finally { studio.destroy(); element.remove(); }
});
