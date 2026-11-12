import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createApp, nextTick } from 'vue';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import App from './App.vue';
import { routes } from './router';
import { appTitleHome } from './app-title';

async function appAt(path: string, attach = false) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: routes.map(({ path, meta }) => ({ path, meta, component: { template: '<main />' } })),
  });
  await router.push(path);
  await router.isReady();
  return mount(App, { global: { plugins: [router] }, ...(attach ? { attachTo: document.body } : {}) });
}

const luminance = (hex: string) => [1, 3, 5]
  .map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
  .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

describe('title bar', () => {
  // The page's own stylesheet, applied to the test document, so the title bar's layout is the one the browser cascade resolves.
  const sheet = document.createElement('style');
  beforeAll(() => {
    sheet.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    document.head.append(sheet);
  });
  afterAll(() => sheet.remove());

  it.each(['/i/MKTT', '/', '/demo', '/owner', '/owner/items/new', '/owner/feed', '/owner/closing', '/owner/ledger'])('opens %s with the Stallkeeper title bar first', async path => {
    const wrapper = await appAt(path, true);
    const titlebar = wrapper.get('.app-titlebar');
    expect(titlebar.element.previousElementSibling).toBeNull();
    expect(titlebar.get('.app-wordmark').text()).toBe('Stallkeeper');
    expect(wrapper.find('.market-awning').exists()).toBe(false);
    expect(wrapper.get('.app-mark').attributes('aria-hidden')).toBe('true');
    wrapper.unmount();
  });

  it('stays fixed at the top while the page scrolls, with a wordmark link at least 44px tall', async () => {
    const wrapper = await appAt('/i/MKTT', true);
    const bar = getComputedStyle(wrapper.get('.app-titlebar').element);
    expect([bar.position, bar.top]).toEqual(['sticky', '0px']);
    expect(getComputedStyle(wrapper.get('.app-wordmark').element).minHeight).toBe('44px');
    wrapper.unmount();
  });

  it('keeps only the app name while preserving the buyer home destination', async () => {
    const wrapper = await appAt('/i/MKTT');
    appTitleHome.value = '/demo';
    await nextTick();
    expect(wrapper.get('.app-titlebar-inner').text()).toBe('Stallkeeper');
    expect(wrapper.get('.app-wordmark').attributes('href')).toBe('/demo');
  });

  it.each(['/owner/ledger', '/owner/ledger/'])('uses the compact title bar on the stall ledger at %s', async (path) => {
    expect((await appAt(path)).get('.app-titlebar').classes()).toContain('compact');
  });
});

describe('owner tabs', () => {
  const tabs = (wrapper: Awaited<ReturnType<typeof appAt>>) => wrapper.findAll('.app-titlebar nav.owner-tabs a');

  it.each([
    ['/owner', 'Stall'], ['/owner/settings', 'Stall'], ['/owner/closing', 'Stall'],
    ['/owner/items', 'Items'], ['/owner/items/new', 'Items'], ['/owner/items/abc', 'Items'], ['/owner/tags', 'Items'],
    ['/owner/feed', 'Feed'], ['/owner/ledger', 'Ledger'],
  ])('puts Stall, Items, Feed and Ledger in the title bar at %s, with %s current', async (path, current) => {
    const wrapper = await appAt(path);
    expect(tabs(wrapper).map(tab => [tab.text(), tab.attributes('href')])).toEqual([['Stall', '/owner'], ['Items', '/owner/items'], ['Feed', '/owner/feed'], ['Ledger', '/owner/ledger']]);
    expect(tabs(wrapper).filter(tab => tab.attributes('aria-current') === 'page').map(tab => tab.text())).toEqual([current]);
  });

  it.each(['/owner/login', '/i/MKTT', '/', '/demo'])('has no owner tabs at %s', async path => {
    expect(tabs(await appAt(path))).toHaveLength(0);
  });
});

describe('market awning palette', () => {
  // The page's own stylesheet, applied to the test document, so the values are the ones the browser cascade resolves.
  const sheet = document.createElement('style');
  beforeAll(() => {
    sheet.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    document.head.append(sheet);
  });
  afterAll(() => sheet.remove());
  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

  it('keeps the cream page, peach panels, ink buttons and yellow tag', () => {
    expect({
      bg: token('bg'), card: token('card'), 'art-bg': token('art-bg'), ink: token('ink'), muted: token('muted'),
      chip: token('chip'), 'chip-ink': token('chip-ink'), primary: token('primary'), 'primary-ink': token('primary-ink'), 'awning-red': token('awning-red'),
    }).toEqual({
      bg: '#f8efe0', card: '#fffbf3', 'art-bg': '#f7d7bd', ink: '#201a16', muted: '#5a4e44',
      chip: '#ffd23f', 'chip-ink': '#201a16', primary: '#201a16', 'primary-ink': '#fffbf3', 'awning-red': '#c8321f',
    });
  });

  it('meets WCAG AA for muted text and card edges on the cream page', () => {
    for (const surface of ['bg', 'card', 'art-bg']) expect(contrast(token('muted'), token(surface))).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['bg', 'card']) expect(contrast(token('line'), token(surface))).toBeGreaterThanOrEqual(3);
  });
});

describe('page colours', () => {
  // happy-dom matches `body:has(#app > .x)` whenever #app exists, so its computed styles cannot tell pages apart.
  // Instead the real views are mounted under #app to show which page selector each one matches, and the declarations of that selector's rule are layered over :root, which is what the browser cascade does on body.
  const sheet = document.createElement('style');
  beforeAll(() => {
    sheet.textContent = ['styles.css', 'open-counter.css'].map(file => readFileSync(join(import.meta.dirname, file), 'utf8')).join('\n');
    document.head.append(sheet);
  });
  afterAll(() => sheet.remove());
  const declarations = (selector: string) => {
    const rule = [...sheet.sheet!.cssRules].find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === selector);
    if (!rule) throw new Error(`No rule for ${selector}`);
    return (name: string) => rule.style.getPropertyValue(`--${name}`).trim();
  };
  const appPage = '#app > .page';
  const printPage = '#app > .print-page';
  // One palette rule covers the app pages and Print tags, so the title bar and tabs look the same on every owner page.
  const paletteRule = `body:has(${appPage}, ${printPage})`;
  const tokens = () => {
    const root = declarations(':root');
    const rule = declarations(paletteRule);
    return (name: string) => rule(name) || root(name);
  };

  const demo = {
    name: 'Garden stall', filmUrl: null, repoUrl: null, buyer: null, open: true,
    owner: { loginUrl: '/owner/login', password: 'demo-fixture' }, reset: { schedule: '03:00 Europe/London', idleMinutes: 20 },
    items: [{ code: 'AAAA', name: 'Lamp', mode: 'haggle', askingPence: 2800, seeded: true, illustration: 'lamp', availability: 'available', newFrom: false, url: 'https://stall.example/i/AAAA', qrPng: 'data:image/png;base64,fixture' }],
  };
  const buyer = {
    item: { code: 'K7Q2', name: 'Brass lamp', notes: 'Tested. Scuff on base', askingPence: 2800, mode: 'haggle', seeded: false },
    stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null, card: null, agreedPrice: null, messages: [],
  };
  const tags = { stallName: 'Garden stall', tags: [{ code: 'K7Q2', name: 'Brass lamp', seeded: false, url: 'https://stall.example/i/K7Q2', host: 'stall.example', qrPng: 'data:image/png;base64,test' }] };
  let unmount = () => {};
  afterEach(() => { unmount(); unmount = () => {}; vi.unstubAllGlobals(); });
  // Mounted on #app as main.ts does, so each view's root is the direct child the page rules select.
  async function viewAt(path: string, body: object) {
    vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start: async () => undefined }) }) });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => Response.json(url === '/api/config' ? { clientId: 'test' } : body)));
    const host = Object.assign(document.createElement('div'), { id: 'app' });
    document.body.append(host);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(path);
    await router.isReady();
    const app = createApp(App).use(router);
    unmount = () => { app.unmount(); host.remove(); };
    app.mount(host);
    await flushPromises();
  }

  it.each([['/demo', demo, 'Try Stallkeeper'], ['/i/K7Q2', buyer, 'Brass lamp']])('renders %s as a .page directly under #app, where the app palette rule applies', async (path, body, heading) => {
    await viewAt(path, body);
    expect(document.querySelector(`${appPage} h1`)?.textContent).toBe(heading);
    expect(document.querySelector(printPage)).toBeNull();
  });

  it('renders Print tags as a .print-page directly under #app, which the app palette rule also selects', async () => {
    await viewAt('/owner/tags', tags);
    expect(document.querySelector(`${printPage} .printed-tag .tag-code`)?.textContent).toBe('K7Q2');
    expect(document.querySelector(appPage)).toBeNull();
  });

  it('declares white cards, bubbles and panels on the cream page in the app palette rule', () => {
    const token = tokens();
    expect({ bg: token('bg'), card: token('card'), panel: token('panel'), ink: token('ink'), chip: token('chip') })
      .toEqual({ bg: '#f8efe0', card: '#ffffff', panel: '#ffffff', ink: '#24231f', chip: '#ffd23f' });
  });

  it('meets WCAG AA for text and 3:1 for field edges on the cream page and its white cards', () => {
    const token = tokens();
    for (const surface of ['bg', 'card']) {
      for (const text of ['ink', 'muted', 'ok', 'flag']) expect(contrast(token(text), token(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token('line'), token(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps secondary fills, pills and dividers as visible on the cream page as they were on white, with AA text on the fills', () => {
    const token = tokens();
    for (const text of ['ink', 'muted']) expect(contrast(token(text), token('sec-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('muted'), token('art-bg'))).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['bg', 'card']) {
      expect(contrast(token('sec-bg'), token(surface))).toBeGreaterThanOrEqual(1.2);
      expect(contrast(token('rule'), token(surface))).toBeGreaterThanOrEqual(1.3);
      expect(contrast(token('art-bg'), token(surface))).toBeGreaterThanOrEqual(1.1);
    }
  });

  it('keeps notice and status fills visible as boxes on the cream page and white cards, with AA text on them', () => {
    const token = tokens();
    for (const text of ['ink', 'ok']) expect(contrast(token(text), token('ok-bg'))).toBeGreaterThanOrEqual(4.5);
    for (const text of ['ink', 'muted', 'ok', 'flag']) expect(contrast(token(text), token('flag-bg'))).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['bg', 'card']) {
      for (const fill of ['ok-bg', 'flag-bg']) expect(contrast(token(fill), token(surface))).toBeGreaterThanOrEqual(1.15);
    }
  });

  it('declares a plain white page for Print tags, with AA muted text on it', () => {
    const palette = tokens();
    const rule = declarations(`body:has(${printPage})`);
    const token = (name: string) => rule(name) || palette(name);
    expect({ bg: token('bg'), card: token('card') }).toEqual({ bg: '#ffffff', card: '#ffffff' });
    expect(contrast(token('muted'), token('bg'))).toBeGreaterThanOrEqual(4.5);
  });
});
