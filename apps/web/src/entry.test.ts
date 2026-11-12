import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const stub = (responses: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn(async (url: string) => url in responses ? Response.json(responses[url]) : Response.json({ error: 'unexpected' }, { status: 500 })));
async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return { router, wrapper };
}
const item = (mode: 'fixed' | 'haggle') => ({ code: 'K7Q2', name: 'Brass lamp', notes: 'Tested. Scuff on base', askingPence: 2800, mode, seeded: true, illustration: 'lamp' });
const buyerPage = (mode: 'fixed' | 'haggle') => ({ item: item(mode), stallName: 'Demo stall', availability: 'available', chatAvailable: false, checkout: null, card: null, agreedPrice: null });

it('sends a judge from the empty main stall to the demo, with one line on what Stallkeeper is', async () => {
  stub({ '/api/stall': { name: 'Main stall', items: [] } });
  const { wrapper } = await open('/');
  expect(wrapper.text()).not.toMatch(/sandbox/i);
  expect(wrapper.text()).toContain('Stallkeeper looks after the stall');
  const links = wrapper.findAll('a[href="/demo"]');
  expect(links).toHaveLength(1);
  expect(links[0]!.classes()).toContain('btn');
});
it('keeps a smaller demo link on a stall with items', async () => {
  stub({ '/api/stall': { name: 'Main stall', items: [{ ...item('fixed'), seeded: false, availability: 'available' }] } });
  const { wrapper } = await open('/');
  expect(wrapper.text()).not.toContain('Stallkeeper looks after the stall');
  const links = wrapper.findAll('a[href="/demo"]');
  expect(links).toHaveLength(1);
  expect(links[0]!.classes()).not.toContain('btn');
});
it('keeps the demo link when the stall cannot load', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { wrapper } = await open('/');
  expect(wrapper.find('a[href="/demo"]').exists()).toBe(true);
});
it('returns from a seeded item to the demo by the wordmark', async () => {
  stub({ '/api/i/K7Q2': buyerPage('haggle') });
  const { wrapper, router } = await open('/i/K7Q2');
  expect(wrapper.find('a.wordmark').attributes('href')).toBe('/demo');
  await wrapper.find('a.wordmark').trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/demo');
});
it('keeps the wordmark on the main stall for an owner item', async () => {
  stub({ '/api/i/K7Q2': { ...buyerPage('haggle'), item: { ...item('haggle'), seeded: false } } });
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('a.wordmark').attributes('href')).toBe('/');
});
it('keeps the tag code form and the stall link off a buyer item page', async () => {
  stub({ '/api/i/K7Q2': buyerPage('haggle') });
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('#tag-code').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Find item');
  expect(wrapper.text()).not.toContain('Browse the stall');
});
it('shows no chat card on a fixed-price seeded item', async () => {
  stub({ '/api/i/FIXD': buyerPage('fixed') });
  const { wrapper } = await open('/i/FIXD');
  expect(wrapper.text()).not.toContain('No chat on this item');
  expect(wrapper.text()).not.toContain('Try an item with Stallkeeper');
});
it('shows no AI link on an item that already has the AI', async () => {
  stub({ '/api/i/LAMP': buyerPage('haggle') });
  const { wrapper } = await open('/i/LAMP');
  expect(wrapper.text()).not.toContain('Try an item with Stallkeeper');
});
it('shows a not-found page with links to the stall and the demo, with no sandbox wording', async () => {
  const { wrapper } = await open('/no/such/page');
  expect(wrapper.text()).not.toMatch(/sandbox/i);
  expect(wrapper.text()).toContain('Page not found');
  expect(wrapper.find('main a[href="/"]').exists()).toBe(true);
  expect(wrapper.find('main a[href="/demo"]').exists()).toBe(true);
});
it('describes the site for link previews and carries a favicon', () => {
  const page = new DOMParser().parseFromString(readFileSync(join(import.meta.dirname, '../index.html'), 'utf8'), 'text/html');
  for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]']) expect(page.querySelector(selector)?.getAttribute('content')?.trim()).toBeTruthy();
  const icon = page.querySelector('link[rel="icon"]')?.getAttribute('href');
  expect(icon).toBeTruthy();
  expect(existsSync(join(import.meta.dirname, '../public', icon!))).toBe(true);
});
it.each([
  ['sold', 'This item has sold. Please leave it for its buyer.'],
  ['reserved', 'Someone is paying for this now. Check back in a few minutes.'],
])('keeps a %s item to one line and one way back to the stall', async (availability, line) => {
  stub({ '/api/i/K7Q2': { ...buyerPage('fixed'), availability } });
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.text()).toContain(line);
  expect(wrapper.text()).not.toContain('Seeded demo item');
  expect(wrapper.text()).not.toContain('Scuff on base');
  expect(wrapper.find('form').exists()).toBe(false);
  const actions = wrapper.findAll('main a.btn, main button.btn');
  expect(actions.map(action => action.text())).toEqual(['See what else is on the stall']);
  expect(actions[0]!.attributes('href')).toBe('/demo');
});
it('says when a held item frees up, from the end of the other buyer\'s reservation', async () => {
  stub({ '/api/i/K7Q2': { ...buyerPage('fixed'), availability: 'reserved', reservedUntil: '2026-11-09T13:30:00.000Z' } });
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.text()).toContain("Someone is paying for this now. Free again by 13:30 if they don't pay.");
});
it('gives the tag code keyboard a Go key', async () => {
  stub({ '/api/stall': { name: 'Main stall', items: [] } });
  const { wrapper } = await open('/');
  expect(wrapper.find('#tag-code').attributes('enterkeyhint')).toBe('go');
});
it('drops the chat link from a sold haggle item the buyer had chatted about', async () => {
  stub({ '/api/i/K7Q2': { ...buyerPage('haggle'), availability: 'sold', messages: [{ role: 'user', content: 'Would you take 20?' }, { role: 'assistant', content: 'The stallholder says no lower than asking today.' }] } });
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.text()).toContain('This item has sold. Please leave it for its buyer.');
  const actions = wrapper.findAll('main a.btn, main button.btn');
  expect(actions.map(action => action.text())).toEqual(['See what else is on the stall']);
});
it('shows the paid screen when the capture lands while the buyer has the chat open', async () => {
  vi.useFakeTimers();
  try {
    const messages = [{ role: 'user', content: 'Would you take 20?' }, { role: 'assistant', content: 'The stallholder says 24 is the lowest.' }];
    const checkout = { checkoutId: 'checkout1', state: 'capturing', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 300_000).toISOString(), totalPence: 2800, reviewRequired: false };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/i/K7Q2') return Response.json({ ...buyerPage('haggle'), availability: 'reserved', checkout, messages });
      if (url === '/api/checkouts/checkout1') return Response.json({ ...checkout, state: 'paid' });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { wrapper } = await open('/i/K7Q2');
    await wrapper.findAll('button').find(button => button.text() === 'View your chat')!.trigger('click');
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(wrapper.find('.paid-screen').isVisible()).toBe(true);
    expect(wrapper.find('.paid-screen .code').text()).toBe('K7Q2');
  } finally { vi.useRealTimers(); }
});
it('shows the sold line when an item sells while the buyer has the chat open', async () => {
  const messages = [{ role: 'user', content: 'Would you take 20?' }, { role: 'assistant', content: 'The stallholder says 24 is the lowest.' }];
  const card = { id: 'card1', itemName: 'Brass lamp', code: 'K7Q2', totalPence: 2400, kind: 'counter', note: 'Checked against the owner\'s limits', expiresAt: new Date(Date.now() + 600_000).toISOString() };
  let page: object = { ...buyerPage('haggle'), chatAvailable: true, card, messages };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/i/K7Q2') return Response.json(page);
    if (url.endsWith('/accept')) return Response.json({}, { status: 409 });
    return Response.json({ error: 'unexpected' }, { status: 500 });
  }));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.findAll('button').find(button => button.text() === 'View your chat')!.trigger('click');
  page = { ...buyerPage('haggle'), availability: 'sold', messages };
  await wrapper.findAll('button').find(button => button.text() === 'Accept £24')!.trigger('click'); await flushPromises();
  const sold = wrapper.findAll('p.notice').find(line => line.text() === 'This item has sold. Please leave it for its buyer.');
  expect(sold?.isVisible()).toBe(true);
  const actions = wrapper.findAll('main a.btn, main button.btn').filter(action => action.isVisible());
  expect(actions.map(action => action.text())).toEqual(['See what else is on the stall']);
});
