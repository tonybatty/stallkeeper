import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as unknown as { PayPal?: unknown }).PayPal; });

async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return wrapper;
}
const charity = { name: 'Garden Rescue', percent: 10, seeded: false, basisPence: 2800, pledgePence: 280, donations: [] as Array<{ transactionId: string; amountPence: number; currency: string; recordedAt: string }> };
const report = (overrides: object = {}) => ({ sessionId: 'session', sessionStatus: 'closed', status: 'final', paymentAsOf: '2026-11-06T12:00:00Z', recordedSalesPence: 2800, refundedPence: 0, paidCheckouts: 1, itemsSold: 1,
  items: [], groups: [], removed: [], charity, ...overrides });

it('shows the buyer line on the item page, without a seeded label for the seeded pledge', async () => {
  const item = { code: 'K7Q2', name: 'Lamp', notes: 'Tested', mode: 'fixed', askingPence: 2800, seeded: false, photoUrl: null };
  const load = (seeded: boolean) => vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/config' ? { clientId: 'test' }
    : { item, stallName: 'Garden stall', availability: 'closed', checkout: null, charity: { line: "10% of today's takings go to Garden Rescue.", seeded } })));
  load(false);
  let wrapper = await open('/i/K7Q2');
  expect(wrapper.find('[data-test="charity-line"]').text()).toBe("10% of today's takings go to Garden Rescue.");
  load(true);
  wrapper = await open('/i/K7Q2');
  expect(wrapper.find('[data-test="charity-line"]').text()).toBe("10% of today's takings go to Garden Rescue.");
});
it('shows no charity line when the stall has no pledge', async () => {
  const item = { code: 'K7Q2', name: 'Lamp', notes: 'Tested', mode: 'fixed', askingPence: 2800, seeded: false, photoUrl: null };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, stallName: 'Garden stall', availability: 'closed', checkout: null, charity: null })));
  expect((await open('/i/K7Q2')).find('[data-test="charity-line"]').exists()).toBe(false);
});

const pledge = { name: 'Garden Rescue', percent: 10, seeded: false };
it('saves a changed pledge and removes it from the settings page', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    if (url === '/api/owner/stall') return Response.json({ name: 'Front-garden stall' });
    if (url === '/api/owner/stall/charity') return Response.json({ charity: init?.method === 'DELETE' ? null : init?.method === 'PUT' ? { ...pledge, percent: 25 } : pledge });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const wrapper = await open('/owner/settings');
  expect(wrapper.find('[aria-labelledby="charity-heading"] input[type=number]').attributes()).toMatchObject({ min: '1', max: '100', step: '1' });
  await wrapper.find('input[type=number]').setValue('25');
  await wrapper.find('[aria-labelledby="charity-heading"] form').trigger('submit'); await flushPromises();
  expect(JSON.parse(String(calls.find(([, init]) => init?.method === 'PUT')![1]!.body))).toEqual({ name: 'Garden Rescue', percent: 25 });
  expect(wrapper.text()).toContain('Charity pledge saved.');
  await wrapper.findAll('button').find(entry => entry.text() === 'Remove pledge')!.trigger('click'); await flushPromises();
  expect(calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
  // With no pledge left the card goes, as it does for a stall that never had one.
  expect(wrapper.find('[aria-labelledby="charity-heading"]').exists()).toBe(false);
});
it('shows no pledge card on the owner home or the settings page for a stall with no pledge', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Front-garden stall' });
    if (url === '/api/owner/items') return Response.json({ items: [], sessionStatus: 'closed' });
    return Response.json({ charity: null, sessionFixed: false, donateButton: true });
  }));
  for (const path of ['/owner', '/owner/settings']) {
    const wrapper = await open(path);
    expect(wrapper.find('[aria-labelledby="charity-heading"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Charity pledge');
  }
});
it('mentions the Donate button on the settings page only when the server has one', async () => {
  const load = (donateButton: boolean) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Front-garden stall' });
    return Response.json({ charity: pledge, sessionFixed: false, donateButton });
  }));
  load(false);
  expect((await open('/owner/settings')).find('[aria-labelledby="charity-heading"]').text()).not.toContain('Donate button');
  load(true);
  expect((await open('/owner/settings')).find('[aria-labelledby="charity-heading"]').text()).toContain('offers a PayPal Donate button.');
});
it('tells the owner when a pledge change waits for the next session', async () => {
  let fixed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Front-garden stall' });
    if (init?.method === 'PUT') fixed = true;
    return Response.json({ charity: { name: 'Garden Rescue', percent: 25, seeded: false }, sessionFixed: fixed });
  }));
  const wrapper = await open('/owner/settings');
  expect(wrapper.find('[data-test="pledge-fixed"]').exists()).toBe(false);
  await wrapper.find('[aria-labelledby="charity-heading"] form').trigger('submit'); await flushPromises();
  expect(wrapper.find('[data-test="pledge-fixed"]').text()).toBe('This session has a recorded sale, so it keeps its pledge. Changes here apply from the next session.');
});
it('explains a refused pledge without raw error text', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Front-garden stall' });
    return init?.method === 'PUT' ? Response.json({ error: 'raw detail' }, { status: 400 }) : Response.json({ charity: pledge });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const wrapper = await open('/owner/settings');
  await wrapper.find('[aria-labelledby="charity-heading"] form').trigger('submit'); await flushPromises();
  expect(wrapper.find('[aria-labelledby="charity-heading"] [role="status"]').text()).toContain('could not be saved');
  expect(wrapper.text()).not.toContain('raw detail');
});

function closing(options: { donateButtonId: string | null; data?: () => object; onDonation?: (init: RequestInit) => Response }) {
  const data = options.data ?? (() => report());
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/config') return Response.json({ clientId: 'test', donateButtonId: options.donateButtonId });
    if (url === '/api/owner/closing/donation') return options.onDonation?.(init!) ?? Response.json({ donations: [] });
    return Response.json({ closing: data() });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function stubSdk() {
  const rendered: Array<{ options: Record<string, unknown>; selector: string }> = [];
  (window as unknown as { PayPal: unknown }).PayPal = { Donation: { Button: (options: Record<string, unknown>) => ({ render: (selector: string) => { rendered.push({ options, selector }); } }) } };
  return rendered;
}

it('states the pledge and its basis on the closing report and renders the sandbox Donate button', async () => {
  closing({ donateButtonId: 'SANDBOXBTN' });
  const rendered = stubSdk();
  const wrapper = await open('/owner/closing');
  const section = wrapper.find('[data-test="charity"]').text();
  expect(section).toContain('10% of recorded sales to Garden Rescue');
  expect(section).toContain('Pledged: £2.80');
  expect(section).toContain('Basis: 10% of £28 recorded sales, paid in PayPal less refunds, this trading session');
  expect(rendered).toHaveLength(1);
  expect(rendered[0]).toMatchObject({ selector: '#paypal-donate-button-container', options: { env: 'sandbox', hosted_button_id: 'SANDBOXBTN', amount: '2.80', currency_code: 'GBP' } });
});
it('labels a provisional figure and says nothing of a seeded pledge', async () => {
  closing({ donateButtonId: null, data: () => report({ status: 'provisional', charity: { ...charity, seeded: true } }) });
  const section = (await open('/owner/closing')).find('[data-test="charity"]').text();
  expect(section).not.toMatch(/seeded/i); expect(section).toContain('provisional, so this figure can still change');
});
it('shows the pledge with a neutral note when no Donate button is configured', async () => {
  closing({ donateButtonId: null });
  const wrapper = await open('/owner/closing');
  expect(wrapper.find('[data-test="charity"]').text()).toContain('Pledged: £2.80');
  expect(wrapper.text()).toContain('The Donate button is not set up on this server.');
});
it('offers no Donate button, and no charity block, when there is nothing to donate', async () => {
  closing({ donateButtonId: 'SANDBOXBTN', data: () => report({ recordedSalesPence: 0, charity: { ...charity, basisPence: 0, pledgePence: 0 } }) });
  const rendered = stubSdk();
  const wrapper = await open('/owner/closing');
  expect(rendered).toHaveLength(0); expect(wrapper.text()).toContain('Nothing is pledged yet');
  closing({ donateButtonId: 'SANDBOXBTN', data: () => report({ charity: null }) });
  expect((await open('/owner/closing')).find('[data-test="charity"]').exists()).toBe(false);
});
it('says a pledge rounded down to nothing is not a lack of sales, and offers no Donate button', async () => {
  closing({ donateButtonId: 'SANDBOXBTN', data: () => report({ recordedSalesPence: 50, charity: { ...charity, percent: 1, basisPence: 50, pledgePence: 0 } }) });
  const rendered = stubSdk();
  const section = (await open('/owner/closing')).find('[data-test="charity"]').text();
  expect(rendered).toHaveLength(0);
  expect(section).toContain('the pledge rounds down to less than a penny');
  expect(section).not.toContain('no recorded sales');
});
it('posts the callback to the API and refreshes the report, which lists the donation apart from sales', async () => {
  let donated = false;
  const fetcher = closing({ donateButtonId: 'SANDBOXBTN', onDonation: () => { donated = true; return Response.json({ donations: [] }); },
    data: () => report({ charity: { ...charity, donations: donated ? [{ transactionId: 'TX1234567', amountPence: 280, currency: 'GBP', recordedAt: '2026-11-06T12:05:00Z' }] : [] } }) });
  const rendered = stubSdk();
  const wrapper = await open('/owner/closing');
  (rendered[0]!.options.onComplete as (params: object) => void)({ tx: 'TX1234567', st: 'Completed', amt: '2.80', cc: 'GBP' }); await flushPromises();
  const post = fetcher.mock.calls.find(([url]) => url === '/api/owner/closing/donation')!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({ sessionId: 'session', transactionId: 'TX1234567', status: 'Completed', amount: '2.80', currency: 'GBP' });
  const section = wrapper.find('[data-test="charity"]').text();
  expect(section).toContain('£2.80 · transaction TX1234567');
  expect(section).toContain('kept apart from sales and change no sales figure');
  expect(wrapper.find('.metrics').text()).toContain('£28');
});
it('leaves the report unchanged and shows a neutral message when the donation cannot be recorded', async () => {
  const fetcher = closing({ donateButtonId: 'SANDBOXBTN', onDonation: () => Response.json({ error: 'raw detail' }, { status: 422 }) });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const rendered = stubSdk();
  const wrapper = await open('/owner/closing');
  const before = wrapper.find('.metrics').text();
  (rendered[0]!.options.onComplete as (params: object) => void)({ tx: 'TX1234567', st: 'Pending', amt: '2.80', cc: 'GBP' }); await flushPromises();
  expect(wrapper.text()).toContain('The donation could not be recorded here. Your report is unchanged.');
  expect(wrapper.text()).not.toContain('raw detail');
  expect(wrapper.find('.metrics').text()).toBe(before);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/owner/closing')).toHaveLength(1);
});
it('shows a neutral message when the Donate SDK cannot load', async () => {
  closing({ donateButtonId: 'SANDBOXBTN' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const append = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => { for (const node of nodes) (node as HTMLScriptElement).onerror?.(new Event('error')); });
  const wrapper = await open('/owner/closing');
  expect(append).toHaveBeenCalled();
  expect(wrapper.text()).toContain('The Donate button could not load. Your report is unchanged.');
  expect(wrapper.find('[data-test="charity"]').text()).toContain('Pledged: £2.80');
});
