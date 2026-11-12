import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createMemoryHistory, createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { reloadOnStaleChunk, routes } from './router.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubApi(replies: Record<string, Response>) {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const defaults: Record<string, () => Response> = { '/api/owner/items': () => Response.json({ items: [], sessionStatus: 'closed' }), '/api/owner/stall/charity': () => Response.json({ charity: null }) };
    const reply = replies[String(input)] ?? defaults[String(input)]?.();
    if (!reply) throw new Error(`Unexpected request: ${String(input)}`);
    // A clone, so a page that asks for the same thing twice reads a fresh body each time.
    return reply.clone();
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function open(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return { router, wrapper };
}

describe('owner login', () => {
  it('sends the password and lands on the empty owner page', async () => {
    const fetcher = stubApi({
      '/api/owner/login': Response.json({ name: 'Demo stall' }),
      '/api/owner/stall': Response.json({ name: 'Demo stall' }),
    });
    const { router, wrapper } = await open('/owner/login');
    await wrapper.find('input[type=password]').setValue('demo-password');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ password: 'demo-password' }) });
    expect(router.currentRoute.value.path).toBe('/owner');
    expect(wrapper.find('h1').text()).toBe('Overview');
    expect(wrapper.find('[data-test=settings-link]').text()).toBe('Settings');
    expect(wrapper.text()).toContain('No items yet.');
  });

  it.each([
    [401, 'That password does not open a stall.'],
    [429, 'Too many tries. Wait a few minutes and try again.'],
    [500, 'Login is not working right now. Please try again.'],
  ])('stays on the login page and explains a %i', async (status, copy) => {
    stubApi({ '/api/owner/login': Response.json({ error: 'raw detail' }, { status }) });
    const { router, wrapper } = await open('/owner/login');
    await wrapper.find('input[type=password]').setValue('wrong');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/owner/login');
    expect(wrapper.find('[role=alert]').text()).toBe(copy);
  });
});

describe('owner page', () => {
  it('sends a logged-out visitor to the login page', async () => {
    stubApi({ '/api/owner/stall': Response.json({ error: 'Log in to continue.' }, { status: 401 }) });
    const { router } = await open('/owner');
    expect(router.currentRoute.value.path).toBe('/owner/login');
  });

  it('logs out back to the login page', async () => {
    stubApi({ '/api/owner/stall': Response.json({ name: 'Demo stall' }), '/api/owner/logout': new Response(null, { status: 204 }) });
    const { router, wrapper } = await open('/owner/settings');
    await wrapper.find('[data-test=logout]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/owner/login');
  });
});

it.each(['/owner/login', '/owner', '/owner/settings'])('shows no sandbox banner on %s', async path => {
  stubApi({ '/api/owner/stall': Response.json({ name: 'Demo stall' }) });
  const { wrapper } = await open(path);
  expect(wrapper.text()).not.toMatch(/sandbox/i);
});

describe('price drops', () => {
  const lamp = { id: 'lamp', code: 'K7Q2', name: 'Brass lamp', notes: 'Tested', mode: 'haggle', askingPence: 2400, minimumPence: null, floorPence: 1800, seeded: false, status: 'available', removedReason: null, retailReference: null, photoUrl: null, priceVersion: 2, priceDrops: true, views: 3 };

  it('keeps the closing time form on the settings page, not the owner home', async () => {
    const fetcher = stubApi({
      '/api/owner/stall': Response.json({ name: 'Front-garden stall', closingTime: '17:00', demo: false }),
      '/api/owner/items': Response.json({ items: [lamp], sessionStatus: 'open' }),
      '/api/owner/stall/closing-time': Response.json({ closingTime: '16:30' }),
    });
    expect((await open('/owner')).wrapper.find('[aria-labelledby=drops-heading]').exists()).toBe(false);
    const { wrapper } = await open('/owner/settings');
    const time = wrapper.find('input[type=time]');
    expect((time.element as HTMLInputElement).value).toBe('17:00');
    await time.setValue('16:30');
    await wrapper.find('[aria-labelledby=drops-heading] form').trigger('submit');
    await flushPromises();
    expect(fetcher.mock.calls.find(call => call[0] === '/api/owner/stall/closing-time')?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ closingTime: '16:30' }) });
    expect(wrapper.text()).toContain('Closing time saved.');
  });

  it('has no tools on a main stall', async () => {
    stubApi({ '/api/owner/stall': Response.json({ name: 'Front-garden stall', closingTime: null, demo: false }), '/api/owner/items': Response.json({ items: [lamp], sessionStatus: 'open' }) });
    const { wrapper } = await open('/owner/settings');
    expect(wrapper.find('[data-test=demo-controls]').exists()).toBe(false);
    expect(wrapper.find('[data-test=run-review]').exists()).toBe(false);
  });

  it('keeps tools off the owner home, which still has Close stall and the ledger', async () => {
    stubApi({ '/api/owner/stall': Response.json({ name: 'Market stall', closingTime: null, demo: true }), '/api/owner/items': Response.json({ items: [lamp], sessionStatus: 'open' }) });
    const { wrapper } = await open('/owner');
    expect(wrapper.find('[data-test=demo-controls]').exists()).toBe(false);
    expect(wrapper.find('[data-test=close-stall]').exists()).toBe(true);
    expect(wrapper.find('a[href="/owner/ledger"]').exists()).toBe(true);
  });

  it.each([
    [{ outcome: 'ran', reduced: [{}], kept: 5, held: 1 }, 200, 'Price review finished: 1 reduced, 5 left as they were, 1 held for a buyer.'],
    [{ outcome: 'unavailable', reduced: [], kept: 0, held: 0 }, 200, 'The review could not run, so no prices changed.'],
    [{ outcome: 'over_budget', reduced: [], kept: 0, held: 0 }, 200, "Today's AI budget is used up, so the review did not run and no prices changed."],
    [{ error: 'This trading session has had both its price reviews. Reset the stall to try again.' }, 409, 'This trading session has had both its price reviews.'],
  ])('keeps the review in a Tools fold on the settings page and says what it did', async (reply, status, copy) => {
    const fetcher = stubApi({
      '/api/owner/stall': Response.json({ name: 'Demo stall', closingTime: null, demo: true }),
      '/api/owner/items': Response.json({ items: [lamp], sessionStatus: 'open' }),
      '/api/owner/demo/price-review': Response.json(reply, { status }),
    });
    const { wrapper } = await open('/owner/settings');
    const fold = wrapper.find('details[data-test=demo-controls]');
    expect(fold.find('summary').text()).toBe('Tools');
    expect((fold.element as HTMLDetailsElement).open).toBe(false);
    await wrapper.find('[data-test=run-review]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test=demo-controls]').text()).toContain(copy);
    expect(fetcher.mock.calls.find(call => call[0] === '/api/owner/demo/price-review')?.[1]).toMatchObject({ method: 'POST' });
  });
});

describe('tools', () => {
  it.each([[200, 'Fresh items are ready.'], [409, 'A payment is in progress.'], [429, 'This stall has been reset many times this hour.']])('resets the stall from Tools and says what happened (%i)', async (status, copy) => {
    const fetcher = stubApi({
      '/api/owner/stall': Response.json({ name: 'Garden stall', closingTime: null, demo: true }),
      '/api/owner/items': Response.json({ items: [], sessionStatus: 'open' }),
      '/api/owner/demo/reset': status === 200 ? Response.json({ reset: true }) : Response.json({ error: `${copy} Try again later.` }, { status }),
    });
    const { wrapper } = await open('/owner/settings');
    await wrapper.find('[data-test=reset-stall]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test=demo-controls]').text()).toContain(copy);
    expect(fetcher.mock.calls.find(call => call[0] === '/api/owner/demo/reset')?.[1]).toMatchObject({ method: 'POST' });
  });
  it('shows the cleared closing time and pledge after a reset', async () => {
    let reset = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall', closingTime: reset ? null : '17:00', demo: true });
      if (url === '/api/owner/items') return Response.json({ items: [], sessionStatus: 'open' });
      if (url === '/api/owner/stall/charity') return Response.json({ charity: reset ? null : { name: 'Food bank', percent: 10, seeded: false } });
      if (url === '/api/owner/demo/reset') { reset = true; return Response.json({ reset: true }); }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const { wrapper } = await open('/owner/settings');
    expect((wrapper.find('input[type=time]').element as HTMLInputElement).value).toBe('17:00');
    expect(wrapper.find('[aria-labelledby=charity-heading]').exists()).toBe(true);
    await wrapper.find('[data-test=reset-stall]').trigger('click');
    await flushPromises();
    expect((wrapper.find('input[type=time]').element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('[aria-labelledby=charity-heading]').exists()).toBe(false);
  });
});

describe('owner home', () => {
  const base = { code: 'A1', notes: 'Tested', mode: 'fixed', askingPence: 500, minimumPence: null, floorPence: 1800, seeded: false, removedReason: null, retailReference: null, photoUrl: null, priceVersion: 1, priceDrops: false, views: 0 };
  const items = [
    { ...base, id: 'a', name: 'Live lamp', status: 'available', mode: 'haggle', askingPence: 1800 },
    { ...base, id: 'b', name: 'Held vase', status: 'reserved', seeded: true },
    { ...base, id: 'c', name: 'Sold chair', status: 'sold', soldPence: 2400 },
    { ...base, id: 'd', name: 'Removed clock', status: 'removed', removedReason: 'Broken' },
    { ...base, id: 'e', name: 'Removed jug', status: 'removed', removedReason: 'Reset' },
  ];
  const stallReplies = () => ({ '/api/owner/stall': Response.json({ name: 'Demo stall', closingTime: null, demo: true }), '/api/owner/items': Response.json({ items, sessionStatus: 'open', takenPence: 2400, itemsSold: 1, itemsTaken: 0 }) });

  it('shows three tiles: takings this session, sold and for sale', async () => {
    stubApi(stallReplies());
    const { wrapper } = await open('/owner');
    expect(wrapper.findAll('[data-test=tiles] .tile').map(tile => tile.text())).toEqual(['£24Recorded sales, this session', '1Sold', '2For sale']);
    expect(wrapper.find('[data-test=stall-status]').text()).toContain('Open');
  });

  it('never counts a free take as sold, and shows it as taken free', async () => {
    const taken = { ...base, id: 'f', name: 'Taken pot', status: 'sold', mode: 'free', askingPence: 0 };
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items: [...items, taken], sessionStatus: 'open', takenPence: 2400, itemsSold: 1, itemsTaken: 1 }) });
    const { wrapper } = await open('/owner');
    expect(wrapper.findAll('[data-test=tiles] .tile').map(tile => tile.text())).toEqual(['£24Recorded sales, this session', '1Sold', '1Taken free', '2For sale']);
  });

  // An item keeps its sold status after its session ends, so the tiles show the server's session counts, not the sold items.
  it('shows the session counts in the Sold and Taken free tiles, whatever earlier items are marked sold', async () => {
    const earlier = [{ ...base, id: 'g', name: 'Refunded can', status: 'sold' }, { ...base, id: 'h', name: 'Old pot', status: 'sold', mode: 'free', askingPence: 0 }];
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items: [...items, ...earlier], sessionStatus: 'open', takenPence: 0, itemsSold: 0, itemsTaken: 0 }) });
    expect((await open('/owner')).wrapper.findAll('[data-test=tiles] .tile').map(tile => tile.text())).toEqual(['£0Recorded sales, this session', '0Sold', '2For sale']);
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items: [...items, ...earlier], sessionStatus: 'open', takenPence: 3600, itemsSold: 2, itemsTaken: 3 }) });
    expect((await open('/owner')).wrapper.findAll('[data-test=tiles] .tile').map(tile => tile.text())).toEqual(['£36Recorded sales, this session', '2Sold', '3Taken free', '2For sale']);
  });

  it('shows 0 Sold, not a blank tile, on a closed stall with no counts', async () => {
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items, sessionStatus: 'closed' }) });
    expect((await open('/owner')).wrapper.findAll('[data-test=tiles] .tile').map(tile => tile.text())).toEqual(['£0Recorded sales, this session', '0Sold', '2For sale']);
  });

  it('lists live stock on the Items tab as short rows, then folded earlier stock, with no per-item removal or floor', async () => {
    stubApi(stallReplies());
    const { wrapper } = await open('/owner/items');
    const live = wrapper.find('[data-test=stock-list]');
    expect(live.findAll('.stock-row b').map(b => b.text())).toEqual(['Live lamp', 'Held vase']);
    expect(live.text()).toContain('Offers · £18');
    expect(live.text()).not.toMatch(/seeded|demo/i);
    const earlier = wrapper.find('[data-test=earlier-stock]');
    expect(earlier.find('summary').text()).toBe('Earlier stock (3)');
    expect((earlier.element as HTMLDetailsElement).open).toBe(false);
    expect(earlier.findAll('.stock-row b').map(b => b.text())).toEqual(['Sold chair', 'Removed clock', 'Removed jug']);
    expect(earlier.text()).toContain('Sold · £24');
    expect(wrapper.text()).not.toContain('Remove item');
    expect(wrapper.text()).not.toContain('Private floor');
    expect(wrapper.find('a[href="/owner/items/a"]').exists()).toBe(true);
    expect(wrapper.find('main a[href="/owner/items/new"]').text()).toBe('Add item');
    expect(wrapper.find('main a[href="/owner/tags"]').text()).toBe('Print tags');
  });

  it('keeps the stock list off the Stall tab', async () => {
    stubApi(stallReplies());
    const { wrapper } = await open('/owner');
    expect(wrapper.find('[data-test=stock-list]').exists()).toBe(false);
    expect(wrapper.find('[data-test=earlier-stock]').exists()).toBe(false);
  });

  it('has Close stall on the Stall tab while the stall is open, and no closing report link', async () => {
    stubApi(stallReplies());
    const { wrapper } = await open('/owner');
    expect(wrapper.find('[data-test=close-stall]').text()).toBe('Close stall');
    expect(wrapper.find('[data-test=closing-link]').exists()).toBe(false);
  });

  it('closes the stall from Close stall and goes to the closing report', async () => {
    const fetcher = stubApi({ ...stallReplies(), '/api/owner/stall/close': Response.json({}) });
    const { router, wrapper } = await open('/owner');
    await wrapper.find('[data-test=close-stall]').trigger('click');
    await flushPromises();
    expect(fetcher.mock.calls.find(call => call[0] === '/api/owner/stall/close')?.[1]).toMatchObject({ method: 'POST' });
    expect(router.currentRoute.value.path).toBe('/owner/closing');
  });

  it('offers Open stall and a link to the closing report when the stall is closed', async () => {
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items, sessionStatus: 'closed', takenPence: 0 }) });
    const { wrapper } = await open('/owner');
    const openStall = wrapper.find('[data-test=open-stall]');
    expect(openStall.text()).toBe('Open stall');
    // The closed stall's next step is the one filled button, ahead of Add item, which steps back.
    expect(openStall.classes()).not.toContain('sec');
    expect(wrapper.findAll('main .btn').map(b => b.text()).slice(0, 2)).toEqual(['Open stall', 'Add item']);
    expect(wrapper.findAll('main .btn').find(b => b.text() === 'Add item')!.classes()).toContain('sec');
    expect(wrapper.find('[data-test=closing-link]').attributes('href')).toBe('/owner/closing');
    expect(wrapper.find('[data-test=close-stall]').exists()).toBe(false);
  });

  it('shows Closing in the status pill while the stall is closing', async () => {
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items, sessionStatus: 'closing', takenPence: 0 }) });
    const { wrapper } = await open('/owner');
    expect(wrapper.find('[data-test=stall-status]').text()).toBe('Stall Closing');
  });

  it('shows no stall status, figures or Open stall button until the items answer, and none after a failed load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let answer: (value: Response) => void = () => {};
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({}) });
    const fetcher = vi.mocked(fetch);
    const stubbed = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async input => String(input) === '/api/owner/items' ? new Promise<Response>(resolve => { answer = resolve; }) : stubbed(input));
    const { wrapper } = await open('/owner');
    expect(wrapper.find('[data-test=stall-status]').exists()).toBe(false);
    expect(wrapper.find('[data-test=open-stall]').exists()).toBe(false);
    expect(wrapper.find('[data-test=tiles]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Loading your stall…');
    answer(Response.json({ items, sessionStatus: 'open', takenPence: 2400, itemsSold: 1, itemsTaken: 0 })); await flushPromises();
    expect(wrapper.find('[data-test=stall-status]').text()).toContain('Open');
    expect(wrapper.text()).not.toContain('Loading your stall');
    wrapper.unmount();
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({}, { status: 500 }) });
    const failed = (await open('/owner')).wrapper;
    expect(failed.find('[role=alert]').text()).toBe('Your stall could not load. Refresh the page to try again.');
    expect(failed.find('[data-test=stall-status]').exists()).toBe(false);
    expect(failed.find('[data-test=open-stall]').exists()).toBe(false);
    expect(failed.text()).not.toContain('Loading your stall');
  });

  it('goes to the closing report after a saved close, and says an opened stall was saved when only the refresh fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let itemsAnswers = 0;
    stubApi({ ...stallReplies(), '/api/owner/stall/close': Response.json({}), '/api/owner/stall/open': Response.json({}) });
    const stubbed = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/owner/items' && itemsAnswers++ > 0 ? Promise.reject(new TypeError('Network lost')) : stubbed(input, init));
    const { router, wrapper } = await open('/owner');
    await wrapper.find('[data-test=close-stall]').trigger('click'); await flushPromises();
    expect(router.currentRoute.value.path).toBe('/owner/closing');
    wrapper.unmount();
    itemsAnswers = 0;
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items, sessionStatus: 'closed', takenPence: 0 }), '/api/owner/stall/open': Response.json({}) });
    const closedStub = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input) === '/api/owner/items' && itemsAnswers++ > 0 ? Promise.reject(new TypeError('Network lost')) : closedStub(input, init));
    const opened = (await open('/owner')).wrapper;
    await opened.find('[data-test=open-stall]').trigger('click'); await flushPromises();
    expect(opened.find('[role=alert]').text()).toBe('Your change was saved, but this page could not update. Refresh the page to see it.');
  });

  it('omits the earlier stock section when every item is live', async () => {
    stubApi({ ...stallReplies(), '/api/owner/items': Response.json({ items: items.slice(0, 2), sessionStatus: 'open' }) });
    const { wrapper } = await open('/owner/items');
    expect(wrapper.find('[data-test=earlier-stock]').exists()).toBe(false);
  });
});

describe('item views', () => {
  it('shows an item its view count on Edit item, without its seeded views', async () => {
    const lamp = { id: 'lamp', code: 'K7Q2', name: 'Brass lamp', notes: 'Tested', mode: 'fixed', askingPence: 2400, minimumPence: null, floorPence: null, seeded: true, status: 'available', removedReason: null, retailReference: null, photoUrl: null, priceVersion: 2, priceDrops: false, views: 3, seededViews: 14 };
    stubApi({ '/api/owner/items': Response.json({ items: [lamp], sessionStatus: 'open' }) });
    expect((await open('/owner/items/lamp')).wrapper.find('[data-test=item-activity]').text()).toBe('3 people have viewed this');
  });
});

describe('a tab left open across a deploy', () => {
  it('loads the page in full once when its code is gone, and not again if that load fails too', async () => {
    sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubApi({ '/api/owner/stall': Response.json({ name: 'Demo stall' }) });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/owner/ledger', component: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/LedgerView-old.js')) }, ...routes] });
    const navigate = vi.fn();
    reloadOnStaleChunk(router, navigate);
    await router.push('/owner'); await router.isReady();
    mount(App, { global: { plugins: [router] } }); await flushPromises();
    await router.push('/owner/ledger').catch(() => {});
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/owner/ledger');
    await router.push('/owner/ledger').catch(() => {});
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('says the page could not load, under the owner tabs, when the code is still gone after that one load', async () => {
    sessionStorage.clear();
    // The state the one full load leaves behind: the guard already holds this path.
    sessionStorage.setItem('stallkeeper-chunk-reload', '/owner/ledger');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The address bar already holds the page, as after a full load, so mounting the app makes it the first navigation.
    // The browser's own history, as in main.ts, because that is where the page was blank.
    window.history.replaceState({}, '', '/owner/ledger');
    const history = createWebHistory();
    onTestFinished(() => { history.destroy(); window.history.replaceState({}, '', '/'); });
    const router = createRouter({ history, routes: [{ path: '/owner/ledger', component: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/LedgerView-old.js')) }, ...routes] });
    const navigate = vi.fn();
    reloadOnStaleChunk(router, navigate);
    const wrapper = mount(App, { global: { plugins: [router] } }); await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.find('[role=alert]').text()).toBe('This page could not load. Refresh to try again.');
    expect(window.location.pathname).toBe('/owner/ledger');
    expect(wrapper.find('.owner-tabs [aria-current=page]').text()).toBe('Ledger');
    // The guard stays set, so a refresh that fails again shows the message without a second load.
    expect(sessionStorage.getItem('stallkeeper-chunk-reload')).toBe('/owner/ledger');
  });
});
