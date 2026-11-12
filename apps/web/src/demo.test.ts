import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
const data = {
  name: 'Garden stall', filmUrl: null as string | null, repoUrl: null as string | null, buyer: null,
  owner: { loginUrl: '/owner/login', password: 'demo-fixture' }, reset: { schedule: '03:00 Europe/London', idleMinutes: 20 },
  items: [{ code: 'AAAA', name: 'Lamp', mode: 'haggle', askingPence: 2800, seeded: true, illustration: 'lamp', availability: 'available', url: 'https://stall.example/i/AAAA', qrPng: 'data:image/png;base64,fixture' }],
};
class Stream { static OPEN = 1; static CLOSED = 2; readyState = 1; close() { this.readyState = 2; } addEventListener() { /* the owner feed only needs a stream to exist */ } }
beforeEach(() => vi.stubGlobal('EventSource', Stream));
afterEach(() => vi.unstubAllGlobals());
async function open() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/demo'); await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } }); await flushPromises();
  return { wrapper, router };
}
const stock = (...items: Array<[code: string, mode: string, illustration: string, availability: string]>) => ({ ...data, items: items.map(([code, mode, illustration, availability]) => ({ ...data.items[0]!, code, name: `Item ${code}`, mode, illustration, availability, url: `https://stall.example/i/${code}` })) });
const fold = (wrapper: ReturnType<typeof mount>, title: string) => wrapper.findAll('details').find(details => details.find('summary').text().startsWith(title))!;
it('keeps the reset link off the page while the stall is open, and shows it once the stall closes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, open: true })));
  expect((await open()).wrapper.find('.reset-line').exists()).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, open: false })));
  expect((await open()).wrapper.find('.reset-line').text()).toContain('Reset stall');
});
it('opens the page cold with illustrations, QR links and unavailable buyer access, and none of the demo wording', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const { wrapper } = await open();
  expect(wrapper.text()).not.toMatch(/sandbox|seeded|demo (item|stall)/i);
  expect(wrapper.text()).toContain('PayPal login details for buyers are not configured yet.');
  expect(wrapper.text()).toContain('demo-fixture');
  expect(wrapper.find('a[href="https://stall.example/i/AAAA"]').text()).toBe('Open tag AAAA');
  expect(wrapper.find('img').attributes('alt')).toContain('tag AAAA');
  expect(wrapper.find('svg[aria-label]').attributes('aria-label')).toContain('not a photograph');
  wrapper.unmount();
});
it('shows two roles up front, buyer first, with the PayPal login and steps behind folds that start closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, buyer: { email: 'judge@example.invalid', password: 'buyer-fixture' } })));
  const { wrapper } = await open();
  const roles = wrapper.find('[aria-label="Choose a role"]');
  expect(roles.findAll('.btn').map(button => button.text())).toEqual(['Be a buyer', 'Be the owner']);
  expect(roles.find('a').attributes('href')).toBe('/i/AAAA');
  const login = fold(wrapper, 'PayPal login for buyers');
  expect(login.attributes('open')).toBeUndefined();
  expect(login.text()).toContain('buyer-fixture');
  expect([...login.element.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Copy email', 'Copy password']);
  expect(wrapper.findAll('.sandbox-buyer')).toHaveLength(1);
  expect(wrapper.text()).not.toContain('not configured');
  expect(fold(wrapper, 'Owner password').text()).toContain('demo-fixture');
  expect(wrapper.findAll('a').filter(link => link.text() === 'Enter the password yourself')).toHaveLength(1);
  expect(wrapper.findAll('button').filter(button => button.text() === 'Be the owner')).toHaveLength(1);
  wrapper.unmount();
});
it('keeps the walkthrough to three steps on the page and points to the configured README for the rest', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, repoUrl: 'https://example.test/repo' })));
  const { wrapper } = await open();
  const steps = fold(wrapper, 'What to try, in three steps');
  expect(steps.attributes('open')).toBeUndefined();
  expect(steps.findAll('li')).toHaveLength(3);
  expect(steps.text()).toContain('If chat is unavailable, keep the asking price.');
  expect(steps.find('a').attributes('href')).toBe('https://example.test/repo#demo-walkthrough');
  expect(steps.findAll('li')[1]!.text()).toContain('try to talk it down to £1');
  expect(steps.findAll('li')[1]!.text()).toContain('Tap Accept on its offer.');
  expect(wrapper.text().match(/What to try/g)).toHaveLength(1);
  wrapper.unmount();
});
it('shows a short front grid of items that take offers or have a fixed price, and leaves pay what you want and free off it', async () => {
  const items = stock(['A1', 'haggle', 'lamp', 'available'], ['B2', 'pwyw', 'pot', 'available'], ['C3', 'free', 'books', 'available'], ['D4', 'fixed', 'pot', 'available'], ['E5', 'haggle', 'mirror', 'available'], ['F6', 'haggle', 'camera', 'available'], ['G7', 'fixed', 'pot', 'available']);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(items)));
  const { wrapper } = await open();
  const grid = wrapper.find('.front-grid');
  expect(grid.findAll('a').map(link => link.attributes('href'))).toEqual(['/i/A1', '/i/D4', '/i/E5', '/i/F6']);
  expect(grid.findAll('a')[0]!.text()).toContain('£28 · Offers');
  expect(grid.findAll('a')[1]!.text()).toContain('Fixed price');
  const all = fold(wrapper, 'All 5 items');
  expect(all.attributes('open')).toBeUndefined();
  expect(all.findAll('article').map(card => card.find('h2').text())).toEqual(['Item A1', 'Item D4', 'Item E5', 'Item F6', 'Item G7']);
  expect(all.findAll('article').map(card => card.text().includes('Stallkeeper'))).toEqual([true, false, true, true, false]);
  expect(wrapper.text()).not.toMatch(/pay what you want|Free to take|Item B2|Item C3/i);
  wrapper.unmount();
});
it('logs in as the owner with only the demo password and lands on the live feed', async () => {
  const feed = { session: { id: 'session', status: 'open' }, recordedSalesPence: 0, itemsSold: 0, itemsTaken: 0, takes: [], unsoldRecords: 0, updatedAt: '2026-11-05T12:00:00Z', sales: [], flaggedPayments: [], minorActivity: [], buyerQuestions: [], aiSpend: { spentUsd: 0, capUsd: 3 } };
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/demo' ? data : url === '/api/owner/items' ? { items: [], sessionStatus: 'open' } : url === '/api/owner/feed' ? feed : { name: 'Demo stall' }));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open();
  await wrapper.findAll('button').find(button => button.text() === 'Be the owner')!.trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/owner/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'demo-fixture' }) }));
  expect(router.currentRoute.value.path).toBe('/owner/feed');
  expect(wrapper.text()).toContain('Live updates');
  wrapper.unmount();
});
it.each([[500, 'Login is not working right now.'], [429, 'Too many tries.']])('shows a %i login failure in the roles row, beside the button', async (status, copy) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/demo' ? Response.json(data) : Response.json({}, { status })));
  const { wrapper, router } = await open();
  await wrapper.findAll('button').find(button => button.text() === 'Be the owner')!.trigger('click'); await flushPromises();
  const alert = wrapper.find('[role="alert"]');
  expect(alert.text()).toContain(copy);
  expect(alert.element.parentElement).toBe(wrapper.find('[aria-label="Choose a role"]').element);
  expect(router.currentRoute.value.path).toBe('/demo');
  wrapper.unmount();
});
it('points Be a buyer at the lamp when it is available, wherever it sits in the list', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(stock(['MIRR', 'haggle', 'mirror', 'available'], ['LAMP', 'haggle', 'lamp', 'available']))));
  const { wrapper } = await open();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/LAMP');
  expect(wrapper.find('.notice').exists()).toBe(false);
  wrapper.unmount();
});
it('points Be a buyer at the first available item that takes offers once the lamp has sold', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(stock(['LAMP', 'haggle', 'lamp', 'sold'], ['MIRR', 'haggle', 'mirror', 'sold'], ['CAMR', 'haggle', 'camera', 'available'], ['POTT', 'fixed', 'pot', 'available']))));
  const { wrapper } = await open();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/CAMR');
  expect(wrapper.find('.notice').exists()).toBe(false);
  wrapper.unmount();
});
it.each([
  ['every item that takes offers has sold', stock(['LAMP', 'haggle', 'lamp', 'sold'], ['POTT', 'fixed', 'pot', 'available'])],
  ['the stall is closed', stock(['LAMP', 'haggle', 'lamp', 'closed'], ['POTT', 'fixed', 'pot', 'closed'])],
])('replaces Be a buyer with a reset notice when %s, keeping the owner button', async (_case, page) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(page)));
  const { wrapper } = await open();
  expect(wrapper.findAll('a').some(link => link.text() === 'Be a buyer')).toBe(false);
  expect(wrapper.findAll('button').some(button => button.text() === 'Be the owner')).toBe(true);
  expect(wrapper.find('.notice').text()).toContain('needs a reset');
  expect(wrapper.find('.notice').text()).toContain('resets itself 20 minutes after it closes');
  expect(wrapper.find('.notice button').text()).toBe('Reset stall');
  // A phone's first screen ends soon after the roles, so the way out has to come before them.
  expect(wrapper.find('.notice button').element.compareDocumentPosition(wrapper.find('[aria-label="Choose a role"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  wrapper.unmount();
});
it('resets from the notice at the top, then shows the answer there and the new Be a buyer link', async () => {
  let reset = false;
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/demo') return Response.json(reset ? data : stock(['LAMP', 'haggle', 'lamp', 'closed']));
    if (url === '/api/owner/demo/reset') reset = true;
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open();
  await wrapper.find('.notice button').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/owner/login', expect.objectContaining({ method: 'POST' }));
  expect(fetcher).toHaveBeenCalledWith('/api/owner/demo/reset', { method: 'POST' });
  expect(wrapper.find('.notice').exists()).toBe(false);
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/AAAA');
  expect(wrapper.find('[aria-label="Choose a role"]').element.previousElementSibling!.textContent).toContain('Fresh items are ready.');
  expect(wrapper.find('.reset-line').element.nextElementSibling).toBeNull();
  wrapper.unmount();
});
it('keeps a busy refusal beside the notice button, not at the bottom of the page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/demo' ? Response.json(stock(['LAMP', 'haggle', 'lamp', 'closed'])) : Response.json({}, { status: url === '/api/owner/demo/reset' ? 409 : 200 })));
  const { wrapper } = await open();
  await wrapper.find('.notice button').trigger('click'); await flushPromises();
  expect(wrapper.find('.notice').element.nextElementSibling!.textContent).toContain('A payment is in progress.');
  expect(wrapper.find('.reset-line').element.nextElementSibling).toBeNull();
  expect(wrapper.find('.notice').exists()).toBe(true);
  wrapper.unmount();
});
it('points Be a buyer at the lamp\'s new code after a reset', async () => {
  let loads = 0;
  const lamp = (code: string) => ({ ...data.items[0]!, code, url: `https://stall.example/i/${code}` });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/demo' ? Response.json({ ...data, items: [lamp(++loads > 1 ? 'BBBB' : 'AAAA')] }) : Response.json({})));
  const { wrapper } = await open();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/AAAA');
  await wrapper.findAll('button').find(button => button.text() === 'Reset stall')!.trigger('click'); await flushPromises();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/BBBB');
  wrapper.unmount();
});
it.each([409, 429, 500, 200])('handles reset status %i without losing payment safety copy', async status => {
  let loads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/demo') { loads++; return Response.json({ ...data, items: [{ ...data.items[0], code: loads > 1 ? 'BBBB' : 'AAAA', url: loads > 1 ? 'https://stall.example/i/BBBB' : data.items[0]!.url }] }); }
    return Response.json({ error: 'private technical detail' }, { status: url === '/api/owner/demo/reset' ? status : 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open();
  await wrapper.findAll('button').find(button => button.text() === 'Reset stall')!.trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/owner/demo/reset', { method: 'POST' });
  expect(wrapper.text()).not.toContain('private technical detail');
  expect(wrapper.text()).toContain(status === 409 ? 'A payment is in progress.' : status === 429 ? 'This stall has been reset many times this hour.' : status === 200 ? 'Fresh items are ready.' : 'The request could not finish.');
  expect(wrapper.text()).toContain(status === 200 ? 'Open tag BBBB' : 'Open tag AAAA');
  wrapper.unmount();
});
it('says what Stallkeeper is under the heading, and links the film only once there is one', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const without = (await open()).wrapper;
  expect(without.find('h1').element.nextElementSibling!.textContent).toContain('ask Stallkeeper');
  expect(without.findAll('a').some(link => link.text() === 'Watch the film')).toBe(false);
  without.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, filmUrl: 'https://video.example/film' })));
  const withFilm = (await open()).wrapper;
  expect(withFilm.find('a[href="https://video.example/film"]').text()).toBe('Watch the film');
  expect(withFilm.find('h1').element.nextElementSibling!.textContent).toContain('pay in PayPal. Watch the film');
  withFilm.unmount();
});
it('keeps each QR code on a desktop and puts it behind a control on a phone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
  const desktop = (await open()).wrapper;
  expect(desktop.find('.demo-stock img.demo-qr').exists()).toBe(true);
  expect(desktop.find('details.qr-toggle').exists()).toBe(false);
  desktop.unmount();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query }));
  const phone = (await open()).wrapper;
  const toggle = phone.find('details.qr-toggle');
  expect(toggle.attributes('open')).toBeUndefined();
  expect(toggle.find('summary').text()).toBe('Show QR code');
  expect(toggle.find('img').attributes('alt')).toContain('tag AAAA');
  expect(phone.findAll('.demo-stock img.demo-qr')).toHaveLength(1);
  phone.unmount();
});
it('scrolls to the role buttons with Be the owner when a link targets the owner anchor, once, and not again after a reset', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/demo#try-owner-heading'); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } }); await flushPromises();
  expect(scrolled).toHaveBeenCalledTimes(1);
  expect(scrolled.mock.contexts[0]).toBe(document.getElementById('try-owner-heading'));
  expect(document.getElementById('try-owner-heading')!.textContent).toContain('Be the owner');
  await wrapper.findAll('button').find(button => button.text() === 'Reset stall')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Fresh items are ready.');
  expect(scrolled).toHaveBeenCalledTimes(1);
  wrapper.unmount();
});
it('shows the not-configured text once and no sandbox box when /api/demo has no buyer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const { wrapper } = await open();
  expect(wrapper.findAll('.sandbox-buyer')).toHaveLength(0);
  expect(wrapper.text().match(/PayPal login details for buyers are not configured yet\./g)).toHaveLength(1);
  wrapper.unmount();
});

it('omits the README link and leaves a complete sentence when no repository is configured', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  const { wrapper } = await open();
  const steps = fold(wrapper, 'What to try');
  expect(steps.find('a').exists()).toBe(false);
  expect(steps.find('p').text()).toBe('If chat is unavailable, keep the asking price.');
  wrapper.unmount();
});
it.each([
  ['available', true, '/i/MIRR'],
  ['sold', true, '/i/LAMP'],
  ['reserved', true, '/i/LAMP'],
  ['available', false, '/i/LAMP'],
])('selects the buyer start with a %s reference, saved=%s', async (availability, newFrom, expected) => {
  const items = stock(['CAMR', 'haggle', 'camera', 'available'], ['LAMP', 'haggle', 'lamp', 'available'], ['MIRR', 'haggle', 'mirror', availability]);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...items, items: items.items.map(item => ({ ...item, newFrom: item.code === 'MIRR' && newFrom })) })));
  const { wrapper } = await open();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe(expected);
  expect(wrapper.findAll('.front-grid a').map(link => link.attributes('href'))).toEqual(['/i/CAMR', '/i/LAMP', '/i/MIRR']);
  wrapper.unmount();
});
it('skips a fixed-price reference and falls back to the first available haggle item without a lamp', async () => {
  const items = stock(['POTT', 'fixed', 'pot', 'available'], ['CAMR', 'haggle', 'camera', 'available']);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...items, items: items.items.map(item => ({ ...item, newFrom: item.code === 'POTT' })) })));
  const { wrapper } = await open();
  expect(wrapper.find('[aria-label="Choose a role"] a').attributes('href')).toBe('/i/CAMR');
  wrapper.unmount();
});
