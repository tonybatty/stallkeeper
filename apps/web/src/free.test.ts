import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import type { Take } from './items.js';
import { routes } from './router.js';
const chooseMode = async (wrapper: { findAll: (s: string) => Array<{ text: () => string; trigger: (e: string) => Promise<unknown> }> }, label: string) => { await wrapper.findAll('button').find(button => button.text() === label)!.trigger('click'); };
enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());
const item = { code: 'F4EE', name: 'Cookbooks', notes: 'Well used. A box.', askingPence: 200, minimumPence: null, mode: 'free', seeded: false };
const taken: Take = { takenAt: '2026-11-06T12:00:00Z', message: null };
const tipCheckout = (state: string, totalPence = 350) => ({ checkoutId: 'tip1', state, paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 300_000).toISOString(), totalPence, reviewRequired: false, kind: 'tip' });
const page = (extra: object = {}) => ({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout: null, take: null, card: null, agreedPrice: null, ...extra });
let callbacks: { onApprove: (data: { orderId: string }) => Promise<void>; onCancel: () => Promise<void> };
const start = vi.fn();
beforeEach(() => {
  start.mockReset().mockImplementation(async (_options: unknown, order: Promise<unknown>) => { await order; });
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: (value: typeof callbacks) => { callbacks = value; return { start }; } }) });
});
async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return { router, wrapper };
}
// Answers by URL and method, and keeps every call in order so a test can read the sequence.
function server(handlers: Record<string, () => Response>, first: object = page()) {
  const calls: string[] = [];
  let current: object = first;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (key === 'GET /api/i/F4EE') return Response.json(current);
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected request ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, fetcher, set: (value: object) => { current = value; } };
}

it('opens a free item on Take it alone, with the message and the tip saved for after and no chat', async () => {
  server({});
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.find('.price-chip').text()).toBe('Free');
  expect(wrapper.text()).toContain('Free, take it');
  expect(wrapper.text()).toContain('Free, a tip is optional');
  expect(wrapper.text()).toContain('No payment. You can leave a message and a tip after.');
  expect(wrapper.find('.free-take button').text()).toBe('Take it');
  expect(wrapper.find('.free-take input').exists()).toBe(false);
  expect(wrapper.find('.checkout').exists()).toBe(false);
  expect(wrapper.find('paypal-button').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Make an offer');
  expect(wrapper.text()).not.toContain('Ask a question');
  expect(wrapper.text()).not.toContain('Paid, take it');
});

it('takes the item with no message and no payment call, then shows the message box and the tip together', async () => {
  const api = server({ 'POST /api/i/F4EE/take': () => Response.json({ take: taken }, { status: 201 }) });
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  expect(JSON.parse(String(api.fetcher.mock.calls.find(([url]) => url.endsWith('/take'))![1]!.body))).toEqual({});
  expect(api.calls).not.toContain('POST /api/i/F4EE/checkout');
  expect(wrapper.text()).toContain("It's yours, take it");
  expect(wrapper.text()).toContain('The item itself was free.');
  const input = wrapper.find('.free-take input');
  expect(input.attributes('maxlength')).toBe('280');
  expect(wrapper.find(`label[for="${input.attributes('id')}"]`).text()).toBe('A message for the stallholder, optional');
  expect(wrapper.text()).toContain('Leave a tip (optional)');
  expect(wrapper.find('.amount input').element).toHaveProperty('value', '');
  expect(wrapper.text()).not.toMatch(/suggest|£2/);
  expect(wrapper.text()).toContain('the item is yours either way');
  expect(wrapper.find('paypal-button').exists()).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it('sends the typed message after the take and keeps the tip on offer', async () => {
  const api = server({ 'POST /api/i/F4EE/take/message': () => Response.json({ take: { ...taken, message: 'Thank you' } }) }, page({ availability: 'taken', take: taken }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.find('.free-take button').attributes('disabled')).toBeDefined();
  await wrapper.find('.free-take input').setValue('Thank you');
  await wrapper.find('.free-take form').trigger('submit'); await flushPromises();
  expect(JSON.parse(String(api.fetcher.mock.calls.find(([url]) => url.endsWith('/take/message'))![1]!.body))).toEqual({ message: 'Thank you' });
  expect(wrapper.find('.free-take').text()).toContain('Your message is with the stallholder.');
  expect(wrapper.find('.free-take input').exists()).toBe(false);
  expect(wrapper.text()).toContain('Leave a tip (optional)');
  expect(api.calls).not.toContain('POST /api/i/F4EE/checkout');
});

it('keeps the typed message and says why when it is refused', async () => {
  server({ 'POST /api/i/F4EE/take/message': () => Response.json({ error: 'This stall has closed, so messages are no longer taken.' }, { status: 409 }) }, page({ availability: 'taken', take: taken }));
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take input').setValue('Thank you');
  await wrapper.find('.free-take form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.free-take [role="alert"]').text()).toBe('This stall has closed, so messages are no longer taken.');
  expect(wrapper.find('.free-take input').element).toHaveProperty('value', 'Thank you');
});

it('sends a typed message that was never sent before the tip order is made', async () => {
  const api = server({
    'POST /api/i/F4EE/take/message': () => Response.json({ take: { ...taken, message: 'Thanks!' } }),
    'POST /api/i/F4EE/checkout': () => Response.json(tipCheckout('awaiting_approval', 200)),
  }, page({ availability: 'taken', take: taken }));
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take input').setValue('Thanks!');
  await wrapper.find('.amount input').setValue('2');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(api.calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/i/F4EE/take/message', 'POST /api/i/F4EE/checkout']);
  expect(JSON.parse(String(api.fetcher.mock.calls.find(([url]) => url.endsWith('/take/message'))![1]!.body))).toEqual({ message: 'Thanks!' });
  expect(start).toHaveBeenCalledOnce();
  expect(wrapper.find('.free-take').text()).toContain('Your message is with the stallholder.');
  expect(wrapper.find('.free-take input').exists()).toBe(false);
  expect(wrapper.text()).toContain('Tip £2');
});

it('starts no tip order while a typed message is refused, keeps the message and says why', async () => {
  const api = server({ 'POST /api/i/F4EE/take/message': () => Response.json({ error: 'This stall has closed, so messages are no longer taken.' }, { status: 409 }) }, page({ availability: 'taken', take: taken }));
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take input').setValue('Thanks!');
  await wrapper.find('.amount input').setValue('2');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(api.calls).not.toContain('POST /api/i/F4EE/checkout');
  expect(wrapper.find('.free-take [role="alert"]').text()).toBe('This stall has closed, so messages are no longer taken.');
  expect(wrapper.find('.free-take input').element).toHaveProperty('value', 'Thanks!');
  expect(wrapper.find('.checkout [role="status"]').text()).toBe('Your message was not sent, so the tip did not start.');
  expect(wrapper.text()).not.toContain('could not be confirmed');
  expect(wrapper.find('.amount input').element).toHaveProperty('value', '2');
});

it('sends the message once when the tip starts while Send message is still in flight', async () => {
  let answer!: (value: Response) => void;
  const api = server({ 'POST /api/i/F4EE/checkout': () => Response.json(tipCheckout('awaiting_approval', 200)) }, page({ availability: 'taken', take: taken }));
  const answered = api.fetcher.getMockImplementation()!;
  api.fetcher.mockImplementation((url, init) => {
    if (!url.endsWith('/take/message')) return answered(url, init);
    api.calls.push(`POST ${url}`);
    return new Promise<Response>(resolve => { answer = resolve; });
  });
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take input').setValue('Thanks!');
  await wrapper.find('.amount input').setValue('2');
  await wrapper.find('.free-take form').trigger('submit');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(api.calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/i/F4EE/take/message']);
  answer(Response.json({ take: { ...taken, message: 'Thanks!' } })); await flushPromises();
  expect(api.calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/i/F4EE/take/message', 'POST /api/i/F4EE/checkout']);
  expect(wrapper.find('.free-take').text()).toContain('Your message is with the stallholder.');
});

it('puts the demo owner shortcut after the optional tip card', async () => {
  server({}, page({ availability: 'taken', take: taken, demoStall: true }));
  const { wrapper } = await open('/i/F4EE');
  const checkout = wrapper.find('.checkout').element;
  const shortcut = wrapper.find('.owner-shortcut');
  expect(shortcut.text()).toBe('Next: see this take as the owner');
  expect(shortcut.attributes('href')).toBe('/demo#try-owner-heading');
  expect(checkout.compareDocumentPosition(shortcut.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('offers the tip checkout only after the take, and sends the typed tip in pence', async () => {
  const api = server({
    'POST /api/i/F4EE/take': () => Response.json({ take: taken }, { status: 201 }),
    'POST /api/i/F4EE/checkout': () => Response.json(tipCheckout('awaiting_approval')),
  });
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  await wrapper.find('.amount input').setValue('3.50');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(api.calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/i/F4EE/take', 'POST /api/i/F4EE/checkout']);
  expect(JSON.parse(String(api.fetcher.mock.calls.find(([url]) => url.endsWith('/checkout'))![1]!.body))).toEqual({ amountPence: 350 });
  expect(start).toHaveBeenCalledOnce();
  expect(wrapper.text()).toContain("It's yours, take it");
  expect(wrapper.text()).toContain('Tip £3.50');
});

it('leaves the item taken and says so when the tip is cancelled at PayPal', async () => {
  server({
    'POST /api/i/F4EE/take': () => Response.json({ take: taken }, { status: 201 }),
    'POST /api/i/F4EE/checkout': () => Response.json(tipCheckout('awaiting_approval')),
    'POST /api/checkouts/tip1/sdk-cancel': () => Response.json(tipCheckout('cancelled')),
    'GET /api/checkouts/tip1': () => Response.json(tipCheckout('cancelled')),
  });
  const { wrapper } = await open('/i/F4EE');
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  await wrapper.find('.amount input').setValue('2');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await callbacks.onCancel(); await flushPromises();
  expect(wrapper.text()).toContain('Tip cancelled and nothing was taken. The item is still yours.');
  expect(wrapper.text()).toContain("It's yours, take it");
  expect(wrapper.text()).toContain('Try a tip again');
  expect(wrapper.text()).not.toContain('Paid, take it');
  expect(wrapper.text()).not.toContain('Checkout cancelled');
});

it('thanks the buyer for a paid tip without saying the item was paid for', async () => {
  server({}, page({ availability: 'taken', take: taken, checkout: tipCheckout('paid', 500) }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.text()).toContain('Thank you for the tip');
  expect(wrapper.text()).toContain('Thank you. Your tip of £5 was received.');
  expect(wrapper.text()).toContain("It's yours, take it");
  expect(wrapper.text()).toContain('The item itself was free.');
  expect(wrapper.text()).not.toContain('Nothing was charged');
  expect(wrapper.text()).not.toContain('Paid, take it');
  expect(wrapper.text()).not.toContain('Checkout total');
  expect(wrapper.find('paypal-button').exists()).toBe(false);
});

it('tells a buyer whose tip was refunded that it is settled and the item is still theirs, and nothing says checking', async () => {
  server({}, page({ availability: 'taken', take: taken, checkout: { ...tipCheckout('paid', 500), reviewRequired: true, tipRefunded: true } }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.find('.checkout h2').text()).toBe('Tip refunded');
  expect(wrapper.text()).toContain('Your tip was refunded. The item is still yours.');
  expect(wrapper.text().toLowerCase()).not.toContain('checking');
  expect(wrapper.find('paypal-button').exists()).toBe(false);
});

it('still says a tip under review needs checking when it was not refunded', async () => {
  server({}, page({ availability: 'taken', take: taken, checkout: { ...tipCheckout('paid', 500), reviewRequired: true, tipRefunded: false } }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.find('.checkout h2').text()).toBe('Tip needs checking');
  expect(wrapper.text()).toContain('Your tip needs checking. The item is still yours.');
});

it("tells the second phone the item has gone, shows no tip and does not call it the buyer's", async () => {
  const api = server({ 'POST /api/i/F4EE/take': () => Response.json({ error: 'Someone else has already taken this. Please leave it for them.' }, { status: 409 }) });
  const { wrapper } = await open('/i/F4EE');
  api.set(page({ availability: 'taken' }));
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Someone else has already taken this. Please leave it for them.');
  expect(wrapper.text()).not.toContain("It's yours");
  expect(wrapper.find('paypal-button').exists()).toBe(false);
  expect(wrapper.find('.free-take').exists()).toBe(false);
});

const nowPriced = (mode: string) => page({ item: { ...item, mode, askingPence: 900 } });
const notFree = () => Response.json({ error: 'This item is not free to take.' }, { status: 404 });

it('tells a buyer on a stale page that Take it was refused, and drops the tip promise once the item has a price', async () => {
  const api = server({ 'POST /api/i/F4EE/take': notFree });
  const { wrapper } = await open('/i/F4EE');
  api.set(nowPriced('fixed'));
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  expect(wrapper.find('[role=alert]').text()).toBe('This item is not free to take.');
  expect(wrapper.find('.price-chip').text()).toBe('£9');
  expect(wrapper.find('.checkout').exists()).toBe(true);
  expect(wrapper.text()).toContain('Take it only when this page says Paid.');
  expect(wrapper.text()).not.toContain('yours either way');
  expect(wrapper.text()).not.toContain('Your tip could not be confirmed');
  expect(api.calls).not.toContain('POST /api/i/F4EE/checkout');
  expect(start).not.toHaveBeenCalled();
});

it('offers an empty amount field when a refused item is now pay what you want', async () => {
  const api = server({ 'POST /api/i/F4EE/take': notFree });
  const { wrapper } = await open('/i/F4EE');
  api.set(nowPriced('pwyw'));
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  expect(wrapper.find('.amount input').element).toHaveProperty('value', '');
  expect(wrapper.text()).toContain('Your amount');
  expect(wrapper.text()).toContain('This item is not free to take.');
});

it('drops the refusal once the buyer has a checkout for the new price', async () => {
  const sale = { ...tipCheckout('awaiting_approval', 900), kind: 'sale' };
  const api = server({ 'POST /api/i/F4EE/take': notFree, 'POST /api/i/F4EE/checkout': () => Response.json(sale), 'GET /api/checkouts/tip1': () => Response.json(sale) });
  const { wrapper } = await open('/i/F4EE');
  api.set(nowPriced('fixed'));
  await wrapper.find('.free-take button').trigger('click'); await flushPromises();
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Reserved for you');
  expect(wrapper.text()).not.toContain('This item is not free to take.');
});

it('shows a visitor who opens a taken free item the same notice', async () => {
  server({}, page({ availability: 'taken' }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.text()).toContain('Someone else has already taken this. Please leave it for them.');
  expect(wrapper.find('.free-take').exists()).toBe(false);
  expect(wrapper.find('paypal-button').exists()).toBe(false);
});

it('tells a taker whose take carried a message that it is with the owner, and offers no way to change it', async () => {
  server({}, page({ availability: 'taken', take: { ...taken, message: 'Lovely, thanks' } }));
  const { wrapper } = await open('/i/F4EE');
  expect(wrapper.find('.free-take').text()).toContain('Your message is with the stallholder.');
  expect(wrapper.find('.free-take input').exists()).toBe(false);
  expect(wrapper.find('.free-take button').exists()).toBe(false);
});

it('renders a buyer message as text on the live feed, not as markup', async () => {
  class Stream { static OPEN = 1; readyState = 1; addEventListener() { /* no events in this test */ } close() { /* nothing to close */ } }
  vi.stubGlobal('EventSource', Stream);
  const markup = '<img src=x onerror="alert(1)"><b>hello</b>';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ session: { id: 's', status: 'open' }, recordedSalesPence: 350, itemsSold: 0, itemsTaken: 1, unsoldRecords: 0, updatedAt: '2026-11-06T12:00:00Z',
    takes: [{ id: 'take1', name: 'Cookbooks', code: 'F4EE', message: markup, time: '2026-11-06T11:59:00Z', seeded: true }],
    sales: [{ id: 'tip', kind: 'tip', name: 'Tip for Cookbooks', code: 'F4EE', amountPence: 350, time: '2026-11-06T11:59:30Z', webhookVerifiedAt: '2026-11-06T11:59:40Z', refundedPence: 0, seeded: true }],
    flaggedPayments: [], minorActivity: [], buyerQuestions: [] })));
  const { wrapper } = await open('/owner/feed');
  expect(wrapper.text()).toContain(`Message from the buyer: ${markup}`);
  expect(wrapper.find('.feed-list img').exists()).toBe(false);
  expect(wrapper.find('.thanks').element.children).toHaveLength(0);
  expect(wrapper.text()).toContain('Tip, money received for a free item');
  expect(wrapper.text()).toContain('Taken free');
});

it('lists a taken free item and its tip in the closing report, with the message as text and a note on the cross-check', async () => {
  const markup = '<script>alert(1)</script>';
  const items = [{ id: 'a', name: 'Cookbooks', code: 'F4EE', seeded: true, observation: 'absent', reason: null, refunded: false, taken: true, tipPence: 350, message: markup }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { sessionId: 's', sessionStatus: 'closed', status: 'final', paymentAsOf: '2026-11-06T12:00:00Z', recordedSalesPence: 350, refundedPence: 0, paidCheckouts: 0, itemsSold: 0, itemsTaken: 1, tipsPence: 350, tipCount: 1, items,
    groups: [{ key: 'takenAbsent', label: 'Taken free, not on the shelf', items }], removed: [], earlierClosedAt: null } })));
  const { wrapper } = await open('/owner/closing');
  expect(wrapper.text()).toContain('Taken free, not on the shelf');
  expect(wrapper.text()).toContain('Cookbooks · F4EE · Tip £3.50');
  expect(wrapper.text()).toContain(`Message from the buyer: ${markup}`);
  expect(wrapper.text()).toContain('No payment. £0 recorded.');
  expect(wrapper.text()).toContain('Free takes have no PayPal order');
  expect(wrapper.text()).not.toContain('no confirmed payment');
  expect(wrapper.find('script').exists()).toBe(false);
});

it('saves a free item with an optional expected tip in pence and no floor or minimum', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
    if (url === '/api/owner/items' && init?.method === 'POST') return Response.json({ id: 'new-item' }, { status: 201 });
    return Response.json({ items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Cookbooks');
  await chooseMode(wrapper, 'Free');
  expect(wrapper.text()).toContain('Expected tip, £, for your recordsOptional. Buyers do not see this.');
  expect(wrapper.text()).not.toContain("Lowest you'd take");
  await wrapper.findAll('input')[3]!.setValue('2');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  const body = JSON.parse(String(fetcher.mock.calls.find(call => call[0] === '/api/owner/items' && call[1]?.method === 'POST')![1]!.body));
  expect(body).toMatchObject({ mode: 'free', askingPence: 200, floorPence: null, minimumPence: null });
});
