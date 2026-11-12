import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import LedgerView from './views/LedgerView.vue';

vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, AgStudioLicenseManager: { setLicenseKey: vi.fn() }, singleColumnLayout: vi.fn(), studioTheme: { withParams: vi.fn() }, createAiHarness: vi.fn(), directLlmRunner: vi.fn() }));
// The DOM AG Studio 3.1.0 builds for a grid widget and a Till roll, each with its toolbar holding one button.
const widgetDom = vi.hoisted(() => (content: string, button: string) => `<div class="ag-studio-layout-widget">${content}<div class="ag-studio-widget-toolbar ag-studio-layout-widget-toolbar"><div class="ag-studio-widget-toolbar-items"><button class="ag-studio-widget-toolbar-button">${button}</button></div></div></div>`);
vi.mock('ag-studio-vue3', () => ({
  AgStudio: { emits: ['api-ready'], mounted() { (this as unknown as { $emit: (name: string, event: unknown) => void }).$emit('api-ready', { api: { getState: vi.fn(), setState: vi.fn() } }); },
    template: `<div class="studio">${widgetDom('<div class="ag-root-wrapper"></div>', 'Export')}${widgetDom('<div class="till-roll"></div>', 'Edit')}</div>` },
  createWidgets: vi.fn(() => ({ widgets: [{ id: 'line-chart', formatShape: vi.fn() }], menu: [], defaultType: 'grid' })),
}));

const ledger = { generatedAt: '2026-11-07T12:00:00.000Z', stall: { name: 'Demo stall', demo: true }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: 'Not run.' } }, sessions: [], ledger: [{ id: 'l1', kind: 'Sale', sessionId: 's1', itemId: 'i1', at: '2026-11-07T12:05:00.000Z', item: 'Brass lamp', code: 'BRSS', amount: 22, status: 'Paid', seeded: false }], offers: [], items: [{ id: 'i1', name: 'Brass lamp', code: 'BRSS', mode: 'Haggle', asking: 25, minimum: null, status: 'Sold', reference: null, seeded: false }] };

afterEach(() => { vi.unstubAllGlobals(); document.head.querySelectorAll('[data-test-studio]').forEach(node => node.remove()); });

describe('ledger grid export button', () => {
  it.each([[390, 'flex'], [1440, 'none']] as const)('sets the grid toolbar at %i px to %s', async (width, display) => {
    (window as unknown as { happyDOM: { setViewport: (size: { width: number; height: number }) => void } }).happyDOM.setViewport({ width, height: 844 });
    // Studio's own toolbar rule in 3.1.0, which it injects at runtime and which hides a toolbar until hover, focus or selection.
    const studioRule = document.createElement('style');
    studioRule.dataset.testStudio = '';
    studioRule.textContent = '.ag-studio-widget-toolbar { display: none; opacity: 0; transform: scale(.95); }';
    document.head.prepend(studioRule);
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => Response.json(String(input).endsWith('/config') ? { licenceKey: null, aiEnabled: false } : String(input).endsWith('/journeys') ? [] : ledger)));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: defineComponent({ render: () => h('div') }) }] });
    await router.push('/owner/ledger');
    const wrapper = mount(LedgerView, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    const [grid, till] = wrapper.findAll('.ag-studio-widget-toolbar').map(toolbar => toolbar.element as HTMLElement);
    expect(grid!.querySelector('button')!.textContent).toBe('Export');
    expect(getComputedStyle(grid!).display).toBe(display);
    if (width === 390) expect(getComputedStyle(grid!).opacity).toBe('1');
    expect(getComputedStyle(till!).display).toBe('none');
    wrapper.unmount();
  });
});
