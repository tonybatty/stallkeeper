import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import FeedView from './views/FeedView.vue';
class Stream {
  static OPEN = 1;
  static CLOSED = 2;
  static all: Stream[] = [];
  readyState = 1;
  onopen?: () => void;
  onerror?: () => void;
  listeners: Record<string, () => void> = {};
  close = vi.fn(() => { this.readyState = Stream.CLOSED; });
  constructor() { Stream.all.push(this); }
  addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
}
const snapshot = { session: { id: 'session', status: 'open' }, recordedSalesPence: 0, itemsSold: 0, itemsTaken: 0, takes: [], unsoldRecords: 0, updatedAt: '2026-11-05T12:00:00Z', sales: [], buyerQuestions: [] };
let wrapper: ReturnType<typeof mount>;
async function mountFeed() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: FeedView }, { path: '/owner', component: FeedView }, { path: '/owner/items/new', component: FeedView }, { path: '/owner/login', component: { template: '<p>Log in</p>' } }] });
  await router.push('/'); await router.isReady();
  wrapper = mount(FeedView, { global: { plugins: [router] } }); await flushPromises();
  return router;
}
beforeEach(() => { Stream.all = []; vi.stubGlobal('EventSource', Stream); });
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('refreshes on reconnect, updates the existing sale mark and reports paused updates', async () => {
  const data = { session: { id: 'session', status: 'open' }, recordedSalesPence: 2800, itemsSold: 1, itemsTaken: 0, takes: [], unsoldRecords: 2, updatedAt: '2026-11-05T12:00:00Z', sales: [{ id: 'sale', name: 'Lamp', code: 'K7Q2', amountPence: 2800, time: '2026-11-05T11:59:00Z', webhookVerifiedAt: null as string | null, refundedPence: 0, seeded: true }], buyerQuestions: [] };
  const fetcher = vi.fn(async () => Response.json(data)); vi.stubGlobal('fetch', fetcher);
  await mountFeed();
  const stream = Stream.all[0]!;
  expect(wrapper.text()).toContain('Recorded sales, this trading session'); expect(wrapper.text()).toContain('£28');
  expect(wrapper.text()).toContain('1 sold · 0 taken free · 2 for sale'); expect(wrapper.text()).not.toContain('Unsold records');
  expect(wrapper.find('[role=status]').attributes('title')).toContain('Last updated'); expect(wrapper.text()).not.toContain('Seeded');
  expect(wrapper.findAll('li')).toHaveLength(1);
  stream.readyState = 0; stream.onerror?.(); await flushPromises();
  expect(wrapper.text()).toContain('Updates paused');
  data.sales[0]!.webhookVerifiedAt = '2026-11-05T12:00:01Z';
  stream.readyState = 1; stream.onopen?.(); await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(2); expect(wrapper.text()).toContain('Confirmed by PayPal');
  expect(wrapper.findAll('li')).toHaveLength(1); expect(wrapper.text()).not.toContain('Updates paused');
  data.recordedSalesPence = 1800; data.sales[0]!.refundedPence = 1000;
  stream.listeners.update?.(); await flushPromises();
  // The total counts down to its new figure over a short animation.
  await vi.waitFor(() => expect(wrapper.find('.takings b').text()).toBe('£18')); expect(wrapper.text()).toContain('Collection withdrawn');
  wrapper.unmount(); expect(stream.close).toHaveBeenCalled();
});
it('highlights a sale that lands while the feed is open, not the rows already there, and jumps the total under reduced motion', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes(': reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
  const sale = (id: string, amountPence: number) => ({ id, name: `Item ${id}`, code: 'K7Q2', amountPence, time: `2026-11-05T11:5${id}:00Z`, webhookVerifiedAt: null, refundedPence: 0, seeded: false, kind: 'sale', price: null });
  const data = { session: { id: 'session', status: 'open' }, recordedSalesPence: 1000, itemsSold: 1, itemsTaken: 0, takes: [], unsoldRecords: 2, updatedAt: '2026-11-05T12:00:00Z', sales: [sale('1', 1000)], buyerQuestions: [] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  expect(wrapper.findAll('li.fresh')).toHaveLength(0);
  data.sales = [sale('2', 2500), sale('1', 1000)]; data.recordedSalesPence = 3500;
  Object.assign(data, { minorActivity: [{ id: 'offer', itemName: 'Lamp', code: 'K7Q2', offeredPence: 500, reason: 'not_agreed', at: '2026-11-05T11:59:00Z' }] });
  Stream.all[0]!.listeners.update?.(); await flushPromises();
  // A refused offer lands as a row too, but only money arriving is highlighted.
  expect(wrapper.text()).toContain('Offer refused, £5');
  expect(wrapper.findAll('li.fresh').map(row => row.find('b').text())).toEqual(['Item 2']);
  expect(wrapper.find('.takings b').text()).toBe('£35');
  wrapper.unmount();
});
it('opens a new stream and refetches after the browser gives up on the old one', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal('fetch', fetcher);
  await mountFeed();
  const first = Stream.all[0]!;
  first.readyState = Stream.CLOSED; first.onerror?.(); await flushPromises();
  expect(wrapper.text()).toContain('Updates paused');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(Stream.all).toHaveLength(2);
  fetcher.mockClear();
  Stream.all[1]!.onopen?.(); await flushPromises();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(wrapper.text()).toContain('Live updates');
});
it('sends the owner to login when the stream closes after the session ends', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetcher = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal('fetch', fetcher);
  const router = await mountFeed();
  fetcher.mockImplementation(async () => Response.json({ error: 'Log in to continue.' }, { status: 401 }));
  const stream = Stream.all[0]!;
  stream.readyState = Stream.CLOSED; stream.onerror?.(); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/owner/login');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(Stream.all).toHaveLength(1);
});
it('reports paused updates and reconnects when heartbeats stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  await mountFeed();
  const first = Stream.all[0]!;
  await vi.advanceTimersByTimeAsync(30_000);
  first.listeners.heartbeat?.();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(wrapper.text()).toContain('Live updates');
  await vi.advanceTimersByTimeAsync(10_000); await flushPromises();
  expect(wrapper.text()).toContain('Updates paused');
  expect(first.close).toHaveBeenCalled(); expect(Stream.all).toHaveLength(2);
});
it('clears paused updates on the next heartbeat after a failed snapshot', async () => {
  const fetcher = vi.fn(async () => Response.json(snapshot)); vi.stubGlobal('fetch', fetcher);
  await mountFeed();
  fetcher.mockImplementationOnce(async () => Response.json({}, { status: 500 }));
  Stream.all[0]!.listeners.update?.(); await flushPromises();
  expect(wrapper.text()).toContain('Updates paused');
  Stream.all[0]!.listeners.heartbeat?.(); await flushPromises();
  expect(wrapper.text()).toContain('Live updates');
});
it('says the feed is loading, not paused, before the first answer, and still reports a first load that fails after the stream drops', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let fail: (error: Error) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; })));
  await mountFeed();
  expect(wrapper.find('[role=status]').text()).toBe('Loading…');
  expect(wrapper.find('[role=alert]').exists()).toBe(false);
  const stream = Stream.all[0]!;
  stream.readyState = 0; stream.onerror?.();
  fail(new TypeError('Network lost')); await flushPromises();
  expect(wrapper.find('[role=alert]').text()).toBe('The live feed could not load. It will try again by itself.');
});
it('says a first load failed and offers to try again, then shows the feed once it loads', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn(async () => Response.json({}, { status: 500 })); vi.stubGlobal('fetch', fetcher);
  await mountFeed();
  expect(wrapper.find('[role=alert]').text()).toBe('The live feed could not load. It will try again by itself.');
  expect(wrapper.find('[role=status]').text()).toBe('Updates paused');
  fetcher.mockImplementation(async () => Response.json(snapshot));
  await wrapper.findAll('button').find(button => button.text() === 'Try again')!.trigger('click'); await flushPromises();
  expect(wrapper.find('[role=alert]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Recorded sales, this trading session');
  expect(wrapper.find('[role=status]').text()).toBe('Live updates');
});
it('shows flagged payment reasons and asks the server for a fresh payment check', async () => {
  vi.stubGlobal('EventSource', Stream);
  const data = { session: null, recordedSalesPence: 0, itemsSold: 0, itemsTaken: 0, takes: [], unsoldRecords: 0, updatedAt: '2026-11-05T12:00:00Z', sales: [], buyerQuestions: [],
    flaggedPayments: [{ checkoutId: 'payment', name: 'Lamp', code: 'K7Q2', totalPence: 2800, reason: 'Payment is still unresolved after 30 minutes.', seeded: true }] };
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/recheck')) { data.flaggedPayments = []; return Response.json({ checked: true }); }
    return Response.json(data);
  });
  vi.stubGlobal('fetch', fetcher);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: FeedView }] });
  await router.push('/'); await router.isReady();
  wrapper = mount(FeedView, { global: { plugins: [router] } }); await flushPromises();
  expect(wrapper.text()).toContain('Payments needing review');
  expect(wrapper.text()).toContain('Payment is still unresolved after 30 minutes.');
  expect(wrapper.text()).toContain('K7Q2');
  await wrapper.findAll('button').find(button => button.text() === 'Check payment again')!.trigger('click');
  await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/owner/checkouts/payment/recheck', expect.objectContaining({ method: 'POST' }));
  expect(wrapper.text()).not.toContain('Payments needing review');
  expect(wrapper.text()).toContain('Payment check finished');
});
it('keeps a flagged payment listed and says so when the payment check fails', async () => {
  const data = { ...snapshot, flaggedPayments: [{ checkoutId: 'payment', name: 'Lamp', code: 'K7Q2', totalPence: 2800, reason: 'Payment is still unresolved after 30 minutes.', seeded: false }] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/recheck') ? Response.json({ error: 'Unavailable' }, { status: 502 }) : Response.json(data)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await mountFeed();
  await wrapper.findAll('button').find(button => button.text() === 'Check payment again')!.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Unable to check payment');
  expect(wrapper.text()).toContain('Payments needing review');
});
it('lists a refused offer as a row in the one list as soon as the stream reports it', async () => {
  const refused = { id: 'event', itemName: 'Brass lamp', code: 'K7Q2', offeredPence: 28000, reason: 'above_asking', at: '2026-11-05T12:01:00Z' };
  const sale = { id: 'sale', name: 'Lamp', code: 'K7Q3', amountPence: 2800, time: '2026-11-05T12:00:00Z', webhookVerifiedAt: null, refundedPence: 0, seeded: false };
  let minorActivity: typeof refused[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, itemsSold: 1, sales: [sale], flaggedPayments: [], minorActivity })));
  await mountFeed();
  expect(wrapper.findAll('li')).toHaveLength(1); expect(wrapper.text()).not.toContain('Offer refused');
  minorActivity = [refused, { ...refused, id: 'event2', offeredPence: 500, reason: 'not_agreed', at: '2026-11-05T11:50:00Z' }];
  Stream.all[0]!.listeners.update!(); await flushPromises();
  const rows = wrapper.findAll('li');
  expect(rows).toHaveLength(3);
  expect(rows[0]!.text()).toContain('Offer refused, £280'); expect(rows[0]!.text()).toContain('Brass lamp · K7Q2 · Above asking price, review');
  expect(rows[1]!.text()).toContain('Lamp'); expect(rows[1]!.text()).toContain('Paid');
  expect(rows[2]!.text()).toContain('Offer refused, £5'); expect(rows[2]!.text()).not.toContain('Above asking');
});
it('folds buyer questions to a count and lists them as plain text by item', async () => {
  const data = { ...snapshot, minorActivity: [], flaggedPayments: [],
    buyerQuestions: [
      { itemId: 'lamp', name: 'Lamp', code: 'K7Q2', seeded: false, questions: [{ id: '2', text: '<b>Is it from 1970?</b>', at: '2026-11-05T11:59:00Z' }, { id: '1', text: 'Does it work?', at: '2026-11-05T11:00:00Z' }] },
      { itemId: 'clock', name: 'Clock', code: 'M3P9', seeded: true, questions: [{ id: '3', text: 'Is it keeping time?', at: '2026-11-05T10:00:00Z' }] },
    ] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  const fold = wrapper.find('details.questions');
  expect(fold.find('summary').text()).toBe('3 questions buyers asked'); expect(fold.attributes('open')).toBeUndefined();
  const questions = fold.findAll('article p').map(p => p.text());
  expect(questions[0]).toContain('<b>Is it from 1970?</b>'); expect(questions[1]).toContain('Does it work?');
  expect(fold.find('b').exists()).toBe(false);
  expect(fold.findAll('h3').map(h => h.text())).toEqual(['Lamp · K7Q2', 'Clock · M3P9']);
  expect(wrapper.text()).not.toContain('AI spend');
});
it('says one question in the singular', async () => {
  const data = { ...snapshot, minorActivity: [], flaggedPayments: [], buyerQuestions: [{ itemId: 'lamp', name: 'Lamp', code: 'K7Q2', seeded: false, questions: [{ id: '1', text: 'Does it work?', at: '2026-11-05T11:00:00Z' }] }] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  expect(wrapper.find('details.questions summary').text()).toBe('1 question buyers asked');
});
it('links each questioned item to its edit page with the notes field requested', async () => {
  const data = { ...snapshot, minorActivity: [], flaggedPayments: [],
    buyerQuestions: [{ itemId: 'lamp', name: 'Lamp', code: 'K7Q2', seeded: false, questions: [{ id: '1', text: 'Does it work?', at: '2026-11-05T11:00:00Z' }] },
      { itemId: 'clock', name: 'Clock', code: 'M3P9', seeded: true, questions: [{ id: '2', text: 'Is it keeping time?', at: '2026-11-05T10:00:00Z' }] }] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  const links = wrapper.findAll('details.questions article').map(article => article.find('a'));
  expect(links.map(link => link.text())).toEqual(['Add to notes', 'Add to notes']);
  expect(links.map(link => link.attributes('href'))).toEqual(['/owner/items/lamp?focus=notes', '/owner/items/clock?focus=notes']);
});
it('leaves out the questions fold when no buyer has asked anything', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  await mountFeed();
  expect(wrapper.text()).not.toContain('questions buyers asked');
});
it('lists a free take in the same list as sales, with the buyer message as text', async () => {
  const take = { id: 't', name: 'Cookbooks', code: '9WCY', message: '<i>Thank you</i>', time: '2026-11-05T11:59:00Z', seeded: true };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, itemsTaken: 1, takes: [take] })));
  await mountFeed();
  const row = wrapper.find('li');
  expect(row.text()).toContain('Cookbooks'); expect(row.text()).toContain('Taken free'); expect(row.text()).toContain('Message from the buyer: <i>Thank you</i>');
  expect(row.find('i').exists()).toBe(false); expect(wrapper.findAll('ol')).toHaveLength(1);
});
it('lists each price drop with its old price, new price and reason', async () => {
  const drop = { id: 'drop', name: 'Lamp', code: 'K7Q2', seeded: true, oldPence: 2800, newPence: 2400, reason: 'Plenty of views and no offers.', at: '2026-11-05T15:30:00Z' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, priceDrops: [drop], priceReview: { outcome: 'ran', at: drop.at } })));
  await mountFeed();
  const section = wrapper.find('[aria-label="Price drops"]');
  expect(section.text()).toContain('Lamp · K7Q2'); expect(section.text()).toContain('£28 to £24');
  expect(section.text()).toContain('Plenty of views and no offers.'); expect(section.text()).not.toContain('Seeded demo item');
  expect(section.find('[data-test=server-check]').text()).toBe('AI suggested it. Server checked it against your limits.');
  expect(wrapper.find('[data-test=review-skipped]').exists()).toBe(false);
});
it.each([['unavailable', 'because the AI was unavailable'], ['over_budget', "because today's AI budget is used up"]])('says a review that could not run changed nothing: %s', async (outcome, copy) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, priceDrops: [], priceReview: { outcome, at: '2026-11-05T15:30:00Z' } })));
  await mountFeed();
  const line = wrapper.find('[data-test=review-skipped]');
  expect(line.text()).toContain(copy); expect(line.text()).toContain('No prices changed.');
});
it('points an empty feed to the stall ledger only when an earlier session has a ledger row', async () => {
  const data = { ...snapshot, earlierLedger: false };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  expect(wrapper.text()).toContain('Nothing sold or taken yet');
  expect(wrapper.find('[data-test="earlier-ledger"]').exists()).toBe(false);
  wrapper.unmount();
  data.earlierLedger = true;
  await mountFeed();
  const link = wrapper.find('[data-test="earlier-ledger"]');
  expect(link.text()).toBe('Earlier sessions are in the stall ledger.');
  expect(link.attributes('href')).toBe('/owner/ledger');
});
it('leaves the ledger pointer off once the session has a sale', async () => {
  const data = { ...snapshot, earlierLedger: true, itemsSold: 1, sales: [{ id: 's', kind: 'sale', name: 'Lamp', code: 'K7Q2', amountPence: 2800, time: '2026-11-05T11:59:00Z', webhookVerifiedAt: null, refundedPence: 0, seeded: false }] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  expect(wrapper.find('[data-test="earlier-ledger"]').exists()).toBe(false);
});
it('says how each sale price was agreed and adds the line on a live update without a reload', async () => {
  const sale = (id: string, name: string, code: string, amountPence: number, price: unknown) => ({ id, name, code, amountPence, time: '2026-11-05T11:59:00Z', webhookVerifiedAt: null, refundedPence: 0, seeded: false, kind: 'sale', price });
  const data = { ...snapshot, itemsSold: 1, sales: [sale('a', 'Mirror', 'M38J', 1600, { source: 'offer', askingPence: 1800, offeredPence: 1000, droppedFromPence: null })] as unknown[],
    minorActivity: [{ id: 'm', itemName: 'Mirror', code: 'M38J', offeredPence: 1000, counterPence: 1600, reason: 'not_agreed', at: '2026-11-05T11:58:00Z', becameSalePence: 1600 }, { id: 'n', itemName: 'Lamp', code: 'VPAP', offeredPence: 900, reason: 'not_agreed', at: '2026-11-05T11:57:00Z', becameSalePence: null }] };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  await mountFeed();
  const lines = () => wrapper.findAll('[data-test="price-line"]').map(node => node.text());
  expect(lines()).toEqual(['Asking £18 · offered £10 · agreed £16']);
  expect(wrapper.text()).toContain('Offer £10, countered at £16'); expect(wrapper.text()).not.toContain('Offer refused, £10'); expect(wrapper.text()).toContain('Mirror · M38J · became a sale at £16');
  expect(wrapper.text()).toContain('Offer refused, £9'); expect(wrapper.text()).toContain('Lamp · VPAP'); expect(wrapper.text()).not.toContain('VPAP · became');
  const checks = wrapper.findAll('li').map(row => row.find('[data-test=server-check]'));
  expect(checks.map(check => check.exists() && check.text())).toEqual([false, 'Server set the counter-offer, inside your limits.', false]);
  data.sales.unshift(sale('b', 'Poster', 'PWYZ', 325, { source: 'pwyw', askingPence: 500, offeredPence: null, droppedFromPence: null }),
    sale('c', 'Kettle', 'FXKT', 900, { source: 'listed', askingPence: 900, offeredPence: null, droppedFromPence: 1000 }),
    { ...sale('d', 'Clock', 'KLKS', 100, null), kind: 'tip' },
    sale('e', 'Seed tins', 'T1N5', 275, { source: 'pwyw', askingPence: null, offeredPence: null, droppedFromPence: null }));
  Stream.all[0]!.listeners.update?.(); await flushPromises();
  expect(lines()).toEqual(['Expected £5 · buyer chose £3.25', 'Listed price after a price drop from £10', 'Buyer chose £2.75', 'Asking £18 · offered £10 · agreed £16']);
});
