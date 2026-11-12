import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import type { Take } from './items.js';
import { routes } from './router.js';
enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const base = { code: 'K7Q2', name: 'Brass lamp', notes: 'Good. Works.', askingPence: 2800, minimumPence: null, mode: 'fixed', seeded: true };
const login = { email: 'judge@example.invalid', password: 'fixture-buyer' };
const checkout = (state: string) => ({ checkoutId: 'c1', state, paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 290_000).toISOString(), totalPence: 2800, reviewRequired: false });
const taken: Take = { takenAt: '2026-11-06T12:00:00Z', message: null };
const page = (extra: object = {}, item: object = {}) => ({ item: { ...base, ...item }, stallName: 'Demo stall', demoStall: true, availability: 'available', chatAvailable: false, checkout: null, take: null, card: null, agreedPrice: null, ...extra });
beforeEach(() => {
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start: async () => undefined }) }) });
});
function server(item: object, buyer: object | null = login) {
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (url === '/api/demo') return Response.json({ buyer });
    if (url.startsWith('/api/i/')) return Response.json(item);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function open(path = '/i/K7Q2') {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return wrapper;
}
const box = (wrapper: Awaited<ReturnType<typeof open>>) => wrapper.find('.sandbox-buyer');
const ownerLink = (wrapper: Awaited<ReturnType<typeof open>>) => wrapper.findAll('a').find(link => /see this (sale|take) as the owner/i.test(link.text()));

it('shows the buyer login with two Copy buttons folded under the pay card on a demo item', async () => {
  server(page());
  const wrapper = await open();
  expect(box(wrapper).text()).toContain('PayPal login for buyers');
  expect(box(wrapper).text()).toContain(login.email); expect(box(wrapper).text()).toContain(login.password);
  expect(box(wrapper).findAll('button').map(button => button.text())).toEqual(['Copy email', 'Copy password']);
  expect(wrapper.find('.checkout .sandbox-buyer').exists()).toBe(false);
  const html = wrapper.find('main').html();
  expect(html.indexOf('paypal-container')).toBeLessThan(html.indexOf('sandbox-buyer'));
  expect(wrapper.find('details.login summary').text()).toBe('PayPal login for buyers');
  expect(ownerLink(wrapper)).toBeUndefined();
});
it.each([
  ['does not label a seeded item', true, 'Brass lampTag K7Q2'],
  ['does not label an item the owner added', false, 'Brass lampTag K7Q2'],
])('%s on the pay screen and keeps what the stallholder says off the pay card', async (_case, seeded, row) => {
  server(page({}, { seeded, condition: 'Good', notes: 'Works.' }));
  const fixed = await open();
  expect(fixed.find('.item-card').exists()).toBe(true);
  expect(fixed.find('.checkout-item').exists()).toBe(false);
  expect(fixed.text().match(/The stallholder says/g)).toHaveLength(1);
  expect(fixed.text()).not.toMatch(/seeded/i);
  fixed.unmount();
  server(page({ checkout: checkout('awaiting_approval') }, { seeded, condition: 'Good', notes: 'Works.' }));
  const wrapper = await open();
  expect(wrapper.find('.checkout h2').text()).toBe('Review and pay');
  expect(wrapper.find('.item-card').exists()).toBe(false);
  expect(wrapper.find('.checkout-item').text()).toBe(row);
  expect(wrapper.text()).not.toContain('The stallholder says');
});
it('says PayPal did not load, and that nothing was paid, when its script fails before any order', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('paypal', { createInstance: async () => { throw new Error('PayPal could not load'); } });
  server(page({ agreedPrice: { id: 'card', itemName: 'Brass lamp', code: 'K7Q2', totalPence: 2400, kind: 'counter', note: '', expiresAt: '2026-11-05T12:30:00Z' } }, { mode: 'haggle' }));
  const wrapper = await open();
  expect(wrapper.find('.checkout [role=status]').text()).toBe('PayPal did not load, so nothing was paid. Refresh the page to try again.');
  expect(wrapper.text()).not.toContain('Payment could not be confirmed');
});
it('keeps the login visible while the page reads Reserved for you', async () => {
  server(page({ checkout: checkout('awaiting_approval') }));
  const wrapper = await open();
  expect(wrapper.text()).toContain('Reserved for you for');
  expect(box(wrapper).exists()).toBe(true);
});
it('copies the email and the password', async () => {
  server(page());
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const wrapper = await open();
  const [email, password] = box(wrapper).findAll('button');
  await email!.trigger('click'); await password!.trigger('click'); await flushPromises();
  expect(writeText.mock.calls).toEqual([[login.email], [login.password]]);
  expect(box(wrapper).text()).toContain('Password copied.');
});
it('folds the login behind a closed summary on a pay-what-you-want item', async () => {
  server(page({}, { mode: 'pwyw' }));
  const login = (await open()).find('details.login');
  expect(login.exists()).toBe(true);
  expect(login.attributes('open')).toBeUndefined();
  expect(login.find('summary').text()).toBe('PayPal login for buyers');
  expect(login.findAll('button').map(button => button.text())).toEqual(['Copy email', 'Copy password']);
});
it('keeps the free item to Take it alone, then shows the folded login on the tip and the next step once taken', async () => {
  server(page({}, { mode: 'free' }));
  let wrapper = await open();
  expect(box(wrapper).exists()).toBe(false);
  expect(ownerLink(wrapper)).toBeUndefined();
  wrapper.unmount();
  server(page({ take: taken }, { mode: 'free' }));
  wrapper = await open();
  expect(wrapper.find('details.login .sandbox-buyer').exists()).toBe(true);
  expect(ownerLink(wrapper)?.text()).toBe('Next: see this take as the owner');
  expect(ownerLink(wrapper)?.attributes('href')).toBe('/demo#try-owner-heading');
});
it('gives a free item taken on a main stall no owner link', async () => {
  server(page({ demoStall: false, take: taken }, { mode: 'free', seeded: false }));
  const wrapper = await open();
  expect(wrapper.text()).toContain("It's yours");
  expect(ownerLink(wrapper)).toBeUndefined();
});
it('shows nothing and fetches no login on a main stall item', async () => {
  const fetcher = server(page({ demoStall: false }, { seeded: false }));
  const wrapper = await open();
  expect(wrapper.find('.paypal-container').exists()).toBe(true);
  expect(box(wrapper).exists()).toBe(false);
  expect(fetcher).not.toHaveBeenCalledWith('/api/demo');
});
it('shows nothing, and checkout still renders, when no buyer is configured', async () => {
  server(page(), null);
  const wrapper = await open();
  expect(box(wrapper).exists()).toBe(false);
  expect(wrapper.find('.checkout').exists()).toBe(true);
  expect(wrapper.find('.paypal-container').exists()).toBe(true);
});
it('links the paid screen on a demo item to the owner steps, and not on a main stall item', async () => {
  server(page({ checkout: checkout('paid') }));
  let wrapper = await open();
  expect(wrapper.text()).toContain('Paid, take it');
  expect(box(wrapper).exists()).toBe(false);
  expect(ownerLink(wrapper)?.text()).toBe('See this sale as the owner');
  expect(ownerLink(wrapper)?.attributes('href')).toBe('/demo#try-owner-heading');
  wrapper.unmount();
  server(page({ demoStall: false, checkout: checkout('paid') }, { seeded: false }));
  wrapper = await open();
  expect(wrapper.text()).toContain('Paid, take it');
  expect(ownerLink(wrapper)).toBeUndefined();
});
it('lands the link on an anchor that exists on the demo page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Demo stall', charity: null, filmUrl: null, buyer: null, owner: { loginUrl: '/owner/login', password: 'demo' }, reset: { schedule: '03:00', idleMinutes: 20 }, items: [] })));
  const wrapper = await open('/demo');
  expect(wrapper.find('#try-owner-heading').exists()).toBe(true);
});
