import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import CheckoutPayment from './components/CheckoutPayment.vue';
import { parsePence, type Checkout } from './items.js';
import { routes } from './router.js';
const chooseMode = async (wrapper: { findAll: (s: string) => Array<{ text: () => string; trigger: (e: string) => Promise<unknown> }> }, label: string) => { await wrapper.findAll('button').find(button => button.text() === label)!.trigger('click'); };
enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const held: Checkout = { checkoutId: 'checkout1', state: 'awaiting_approval', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 300_000).toISOString(), totalPence: 1234, reviewRequired: false };
const item = { code: 'T1N5', name: 'Seed tins', notes: 'Clean. Four tins.', askingPence: 500, minimumPence: null as number | null, mode: 'pwyw', seeded: false };
let callbacks: { onApprove: (data: { orderId: string }) => Promise<void> };
const start = vi.fn();
beforeEach(() => {
  start.mockReset().mockImplementation(async (_options: unknown, order: Promise<unknown>) => { await order; });
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: (value: typeof callbacks) => { callbacks = value; return { start }; } }) });
});
const checkoutCalls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/checkout'));
async function mountAmount(reply: (url: string) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : reply(url));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'T1N5', itemName: 'Seed tins', askingPence: 500, payWhatYouWant: true, initial: null } });
  await flushPromises();
  return { wrapper, fetcher };
}

it('reads whole pence from typed pounds and nothing else', () => {
  expect(['12', '12.5', '12.50', ' 0.05 ', '0'].map(parsePence)).toEqual([1200, 1250, 1250, 5, 0]);
  expect(['', '1.234', '-1', '1,50', '£5', '1e3', 'abc'].map(parsePence)).toEqual([null, null, null, null, null, null, null]);
});

it('starts the amount field empty beside the PayPal button, names no suggested amount, and totals what the buyer types', async () => {
  const { wrapper } = await mountAmount(() => Response.json(held));
  const field = wrapper.find<HTMLInputElement>('.amount input');
  expect(field.element.value).toBe('');
  expect(wrapper.text()).not.toMatch(/suggest|£5/);
  expect(wrapper.find('.total').exists()).toBe(false);
  expect(wrapper.find('paypal-button').exists()).toBe(true);
  await field.setValue('5');
  expect(wrapper.find('.total').text()).toBe('Total £5');
  await field.setValue('12.34');
  expect(wrapper.find('.total').text()).toBe('Total £12.34');
  await field.setValue('abc');
  expect(wrapper.find('.total').exists()).toBe(false);
});

it('names the amount field and stops browsers offering saved values', async () => {
  const { wrapper } = await mountAmount(() => Response.json(held));
  const field = wrapper.find<HTMLInputElement>('.amount input');
  expect(field.attributes('name')).toBe('amount'); expect(field.attributes('id')).toBeTruthy(); expect(field.attributes('autocomplete')).toBe('off');
});
it('sends the typed amount in pence when the buyer presses Pay, and then shows the amount the server reserved', async () => {
  const { wrapper, fetcher } = await mountAmount(() => Response.json(held));
  await wrapper.find('.amount input').setValue('12.34');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(checkoutCalls(fetcher)).toHaveLength(1);
  expect(JSON.parse(String(checkoutCalls(fetcher)[0]![1].body))).toEqual({ amountPence: 1234 });
  expect(start).toHaveBeenCalledWith({ presentationMode: 'auto' }, expect.any(Promise));
  expect(wrapper.find('.amount').exists()).toBe(false);
  expect(wrapper.find('.total').text()).toBe('Total £12.34');
});

it('keeps the buyer on the amount field and sends nothing for an amount that is not money or is zero', async () => {
  const { wrapper, fetcher } = await mountAmount(() => Response.json(held));
  for (const bad of ['', 'abc', '0', '0.00', '1.234']) {
    await wrapper.find('.amount input').setValue(bad);
    await wrapper.find('paypal-button').trigger('click'); await flushPromises();
    expect(wrapper.find('[role=status]').text()).toBe('Enter an amount of at least 1p.');
  }
  expect(checkoutCalls(fetcher)).toHaveLength(0);
  expect(start).not.toHaveBeenCalled();
  await wrapper.find('.amount input').setValue('0.01');
  expect(wrapper.find('[role=status]').text()).not.toContain('Enter an amount');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(JSON.parse(String(checkoutCalls(fetcher)[0]![1].body))).toEqual({ amountPence: 1 });
});

it.each([
  ['below the minimum', '0.50', 'The least you can pay for this item is £2.'],
  ['above the maximum', '500.01', 'The most you can pay for this item is £500.'],
])("shows the server's refusal of an amount %s, and leaves the field to try again with no talk of a failed payment", async (_name, amount, error) => {
  const { wrapper, fetcher } = await mountAmount(() => Response.json({ error }, { status: 422 }));
  await wrapper.find('.amount input').setValue(amount);
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(checkoutCalls(fetcher)).toHaveLength(1);
  expect(wrapper.find('[role=status]').text()).toBe(error);
  expect(wrapper.find('.amount input').exists()).toBe(true);
  await wrapper.find('.amount input').setValue('3');
  expect(wrapper.find('[role=status]').text()).toBe('Take it only when this page says Paid.');
});

it('shows the amount paid, not the suggested amount, on the paid screen', async () => {
  const { wrapper } = await mountAmount(url => Response.json(url.endsWith('/capture') ? { ...held, state: 'paid' } : held));
  await wrapper.find('.amount input').setValue('12.34');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await callbacks.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(wrapper.find('h2').text()).toBe('Paid, take it');
  expect(wrapper.find('.paid-screen p').text()).toBe('Seed tins · £12.34');
  expect(wrapper.find('.paid-screen .code').text()).toBe('T1N5');
  expect(wrapper.text()).not.toContain('£5');
});

it('gives other items no amount field and no amount in the checkout body', async () => {
  const fetcher = vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : Response.json(held));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: null } });
  await flushPromises();
  expect(wrapper.find('.amount').exists()).toBe(false);
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(checkoutCalls(fetcher)[0]![1].body).toBe('{}');
});

async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return { router, wrapper };
}

it('puts a Pay what you want label, an amount field and the PayPal button on the buyer page, with no suggestion and no chat', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout: null, card: null, agreedPrice: null })));
  const { wrapper } = await open('/i/T1N5');
  expect(wrapper.find('.price-chip').text()).toBe('Pay what you want');
  expect(wrapper.find('.item-card .meta').text()).toBe('Tag T1N5');
  expect(wrapper.text()).not.toMatch(/suggest|£5/);
  expect(wrapper.find<HTMLInputElement>('.amount input').element.value).toBe('');
  expect(wrapper.find('paypal-button').exists()).toBe(true);
  expect(wrapper.text()).not.toContain('Make an offer');
  expect(wrapper.text()).not.toContain('Ask a question');
});

it('states the minimum on the buyer page when the owner set one', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : Response.json({ item: { ...item, minimumPence: 250 }, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout: null, card: null, agreedPrice: null })));
  const { wrapper } = await open('/i/T1N5');
  expect(wrapper.text()).toContain('The minimum is £2.50.');
  expect(wrapper.text()).not.toContain('suggest');
});

it('shows the same page when the owner hid the suggestion, and the buyer types any amount at or above the minimum', async () => {
  const hidden = { ...item, askingPence: null, minimumPence: 250 };
  const fetcher = vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : String(url).endsWith('/checkout') ? Response.json({ ...held, totalPence: 600 }) : Response.json({ item: hidden, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout: null, card: null, agreedPrice: null }));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/i/T1N5');
  expect(wrapper.find('.price-chip').text()).toBe('Pay what you want');
  expect(wrapper.text()).not.toContain('suggest');
  expect(wrapper.text()).toContain('The minimum is £2.50.');
  const field = wrapper.find<HTMLInputElement>('.amount input');
  expect(field.element.value).toBe('');
  expect(wrapper.find('.total').exists()).toBe(false);
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.find('.checkout [role=status]').text()).toBe('Enter an amount of at least £2.50.');
  expect(checkoutCalls(fetcher)).toHaveLength(0);
  await field.setValue('6');
  expect(wrapper.find('.total').text()).toBe('Total £6');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(JSON.parse(String(checkoutCalls(fetcher)[0]![1].body))).toEqual({ amountPence: 600 });
});

it('asks for the expected amount as an optional figure for the owner alone, with nothing to hide from buyers', async () => {
  const fetcher = formFetcher();
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Seed tins');
  await chooseMode(wrapper, 'Pay what you want');
  const figure = wrapper.findAll('label').find(label => label.text().startsWith('Expected amount'))!;
  expect(figure.text()).toBe('Expected amount, £, for your recordsOptional. Buyers do not see this.');
  expect(figure.find('input').attributes('required')).toBeUndefined();
  expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Suggested amount');
  await chooseMode(wrapper, 'Fixed price');
  expect(wrapper.findAll('label').find(label => label.text().startsWith('Asking price'))!.find('input').attributes('required')).toBeDefined();
  await chooseMode(wrapper, 'Pay what you want');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toEqual([expect.objectContaining({ mode: 'pwyw', askingPence: null, minimumPence: null })]);
  expect(saved(fetcher)[0]).not.toHaveProperty('suggestionHidden');
});

it('opens a saved item with no expected amount on an empty field, clears a saved one, and refuses a figure that is not money', async () => {
  const owned = (askingPence: number | null) => ({ ...item, id: 'tins', askingPence, floorPence: null, priceDrops: false, status: 'available', removedReason: null, retailReference: null, photoUrl: null, priceVersion: 1 });
  const patches: unknown[] = [];
  const editFetcher = (askingPence: number | null) => vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'PATCH') { patches.push(JSON.parse(String(init.body))); return Response.json(owned(null)); }
    return Response.json({ stallName: 'Garden stall', items: [owned(askingPence)], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', editFetcher(null));
  const empty = await open('/owner/items/tins');
  expect(empty.wrapper.findAll('input')[3]!.element.value).toBe('');
  empty.wrapper.unmount();
  vi.stubGlobal('fetch', editFetcher(500));
  const { wrapper } = await open('/owner/items/tins');
  const figure = wrapper.findAll('input')[3]!;
  expect(figure.element.value).toBe('5.00');
  await figure.setValue('0');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(wrapper.find('[role=alert]').text()).toBe('Enter an expected amount above zero, or leave it empty.');
  expect(patches).toEqual([]);
  await figure.setValue('');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(patches).toEqual([expect.objectContaining({ mode: 'pwyw', askingPence: null })]);
});

it('keeps a seeded pay-what-you-want page to the item and the pay step, with no chat card or tag form', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : Response.json({ item: { ...item, seeded: true }, stallName: 'Demo stall', availability: 'available', chatAvailable: false, checkout: null })));
  const { wrapper } = await open('/i/T1N5');
  expect(wrapper.find('.item-card').classes()).toContain('compact');
  expect(wrapper.text()).not.toContain('Seeded demo item');
  expect(wrapper.text()).toContain('The stallholder says: Clean');
  expect(wrapper.find('.amount input').exists()).toBe(true);
  expect(wrapper.text()).not.toContain('No chat on this item');
  expect(wrapper.text()).not.toContain('nothing to haggle over');
  expect(wrapper.find('.code-entry').exists()).toBe(false);
});

async function fillForm(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, asking: string, minimum: string) {
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Seed tins');
  await chooseMode(wrapper, 'Pay what you want');
  const inputs = wrapper.findAll('input');
  await inputs[3]!.setValue(asking);
  await inputs[4]!.setValue(minimum);
  await wrapper.find('form').trigger('submit'); await flushPromises();
  return { wrapper, router };
}
const formFetcher = (refusal?: string) => vi.fn<typeof fetch>(async (url, init) => {
  if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
  if (url === '/api/owner/items' && init?.method === 'POST') return refusal ? Response.json({ error: refusal }, { status: 400 }) : Response.json({ id: 'new-item' }, { status: 201 });
  return Response.json({ items: [], sessionStatus: 'closed' });
});
const saved = (fetcher: ReturnType<typeof formFetcher>) => fetcher.mock.calls.filter(call => call[0] === '/api/owner/items' && call[1]?.method === 'POST').map(call => JSON.parse(String(call[1]?.body)));

it('saves a pay-what-you-want item with an expected amount and an optional minimum, in pence', async () => {
  const withMinimum = formFetcher();
  const { router } = await fillForm(withMinimum, '5', '1.50');
  expect(saved(withMinimum)).toEqual([expect.objectContaining({ mode: 'pwyw', askingPence: 500, minimumPence: 150, floorPence: null })]);
  expect(router.currentRoute.value.path).toBe('/owner/items');
  const without = formFetcher();
  await fillForm(without, '5.00', '');
  expect(saved(without)).toEqual([expect.objectContaining({ mode: 'pwyw', askingPence: 500, minimumPence: null, floorPence: null })]);
});

it.each([
  ['a minimum of zero', '0'],
  ['a minimum that is not money', 'two'],
])('does not send %s', async (_name, minimum) => {
  const fetcher = formFetcher();
  const { wrapper, router } = await fillForm(fetcher, '5', minimum);
  expect(saved(fetcher)).toEqual([]);
  expect(wrapper.find('[role=alert]').text()).toBe('Enter a minimum above zero, or leave it empty.');
  expect(router.currentRoute.value.path).toBe('/owner/items/new');
});

it("shows the owner the server's refusal of the prices and stays on the form", async () => {
  const fetcher = formFetcher('Set an expected amount of £500 or less.');
  const { wrapper, router } = await fillForm(fetcher, '500.01', '');
  expect(saved(fetcher)).toEqual([expect.objectContaining({ askingPence: 50_001 })]);
  expect(wrapper.find('[role=alert]').text()).toBe('Your item was not saved. Set an expected amount of £500 or less.');
  expect(router.currentRoute.value.path).toBe('/owner/items/new');
});

it('never sends a floor typed for a haggle item as the public minimum', async () => {
  const fetcher = formFetcher();
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Seed tins');
  await chooseMode(wrapper, 'Take offers');
  await wrapper.findAll('input')[3]!.setValue('5');
  await wrapper.findAll('input')[4]!.setValue('3');
  await chooseMode(wrapper, 'Pay what you want');
  expect(wrapper.findAll('input')[4]!.element.value).toBe('');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toEqual([expect.objectContaining({ mode: 'pwyw', minimumPence: null, floorPence: null })]);
});
