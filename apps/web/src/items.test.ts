import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
const chooseMode = async (wrapper: { findAll: (s: string) => Array<{ text: () => string; trigger: (e: string) => Promise<unknown> }> }, label: string) => { await wrapper.findAll('button').find(button => button.text() === label)!.trigger('click'); };
enableAutoUnmount(afterEach);
beforeEach(() => vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => false }) }) }));
afterEach(() => vi.unstubAllGlobals());
const opening = "I'm Stallkeeper, looking after this stall. I answer from the stallholder's notes. Offers are checked against the stallholder's rules, and you choose whether to pay in PayPal.";
const item = { code: 'K7Q2', name: 'Brass lamp', notes: 'Tested, it works. Scuff on base', askingPence: 2800, mode: 'haggle', seeded: false };
async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return { router, wrapper };
}
it('loads a scanned item cold without any owner request or startup redirect', async () => {
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => false }) }) });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ item, stallName: 'Garden stall', availability: 'available', checkout: null }));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/i/K7Q2');
  expect(router.currentRoute.value.path).toBe('/i/K7Q2');
  expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[0]?.[0]).toBe('/api/i/K7Q2');
  for (const text of ['Stallkeeper', 'Brass lamp', 'K7Q2', 'Scuff on base', '£28', 'Tested, it works']) expect(wrapper.text()).toContain(text);
  expect(wrapper.text()).toContain('Review and pay');
});
it.each([
  ['sold', 'This item has sold. Please leave it for its buyer.'],
  ['reserved', 'Someone is paying for this now. Check back in a few minutes.'],
  ['closed', 'This stall is closed. Please leave the item here.'],
])('shows the fixed %s copy', async (availability, text) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, stallName: 'Garden stall', availability })));
  expect((await open('/i/K7Q2')).wrapper.text()).toContain(text);
});
it('sends a closed demo item to the demo page, and leaves the main stall copy alone', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, stallName: 'Demo stall', availability: 'closed', demoStall: true })));
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.text()).toContain('This stall is closed. Fresh stock is one tap away.');
  expect(wrapper.text()).not.toContain('Please leave the item here.');
  expect(wrapper.find('a[href="/demo"]').text()).toBe('Get fresh stock');
  wrapper.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, stallName: 'Garden stall', availability: 'closed', demoStall: false })));
  const main = (await open('/i/K7Q2')).wrapper;
  expect(main.text()).toContain('This stall is closed. Please leave the item here.');
  expect(main.find('a[href="/demo"]').exists()).toBe(false);
});
it('keeps the refusal visible when the buyer already holds another item', async () => {
  const refusal = 'You already have another item reserved. Finish paying for it, or wait for that reservation to end, then try again.';
  const start = async (_options: unknown, order: Promise<unknown>) => { await order.catch(() => undefined); throw new Error('PayPal session failed'); };
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start }) }) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (init?.method === 'POST') return Response.json({ error: refusal }, { status: 409 });
    return Response.json({ item, stallName: 'Garden stall', availability: 'available', checkout: null });
  }));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.find('[role="status"]').text()).toBe(refusal);
});
it.each([
  ['a lost Pay response restores the reservation', 'awaiting_approval', () => Promise.reject(new TypeError('Network lost')), 'Reserved for you'],
  ['a refused stale tab shows the sale paid elsewhere', 'paid', async () => Response.json({ error: 'This item cannot be reserved.' }, { status: 409 }), 'Paid, take it'],
] as const)('adopts the server checkout after a failed Pay: %s', async (_name, state, post, expected) => {
  const checkout = { checkoutId: 'checkout1', state, paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 240_000).toISOString(), totalPence: 2800, reviewRequired: false };
  const start = async (_options: unknown, order: Promise<unknown>) => order;
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start }) }) });
  let pressed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (init?.method === 'POST') { pressed = true; return post(); }
    if (url.startsWith('/api/checkouts/')) return Response.json(checkout);
    return Response.json({ item, stallName: 'Garden stall', availability: pressed ? 'reserved' : 'available', checkout: pressed ? checkout : null });
  }));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain(expected);
});
it('lets an unknown-code visitor type the code again, or browse the stall home as a button', async () => {
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => false }) }) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('ZZZZ') ? Response.json({}, { status: 404 }) : url === '/api/stall' ? Response.json({ name: 'Garden stall', items: [] }) : Response.json({ item, stallName: 'Garden stall', availability: 'available', checkout: null })));
  const { wrapper, router } = await open('/i/ZZZZ');
  expect(wrapper.text()).toContain('That tag is not on this stall.');
  await wrapper.find('#tag-code').setValue('k7q2'); await wrapper.find('form.code-entry').trigger('submit'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/i/K7Q2');
  await router.push('/i/ZZZZ'); await flushPromises();
  const browse = wrapper.findAll('a').find(link => link.text() === 'Browse the stall')!;
  expect(browse.classes()).toContain('btn');
  await browse.trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/');
  expect(wrapper.find('#tag-code').exists()).toBe(true);
  // An empty stall leads with its own heading, not the rummage tagline.
  expect(wrapper.find('h1').text()).toBe('Nothing on this stall yet');
  expect(wrapper.text()).not.toContain('A little rummage');
});
it('groups tags into six per print sheet and uses the issued PNGs and copy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tags: Array.from({ length: 9 }, (_, i) => ({ ...item, code: `ABC${i}`, stallName: 'Garden stall', host: 'stall.example', qrPng: 'data:image/png;base64,test' })) })));
  const { wrapper } = await open('/owner/tags');
  expect(wrapper.findAll('.tag-sheet').map(sheet => sheet.findAll('.printed-tag').length)).toEqual([6, 3]);
  expect(wrapper.findAll('img')).toHaveLength(9);
  expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,test');
  expect(wrapper.text()).not.toContain('Take it only');
  expect(wrapper.text()).not.toContain('100% scale');
});
it('previews the first six tags two-up on screen with a "Code" label, and still lays out every tag for print', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tags: Array.from({ length: 14 }, (_, i) => ({ ...item, code: `TQE${i}`, seeded: true, stallName: 'Garden stall', host: 'stall.example', qrPng: 'data:image/png;base64,test' })) })));
  const { wrapper } = await open('/owner/tags');
  expect(wrapper.find('.print-controls .btn').text()).toBe('Print 14 tags');
  const tags = wrapper.findAll('.printed-tag');
  expect(tags).toHaveLength(14);
  expect(wrapper.findAll('.tag-sheet').map(sheet => sheet.findAll('.printed-tag').length)).toEqual([6, 6, 2]);
  expect(tags.map(tag => tag.classes('beyond-preview'))).toEqual([...Array(6).fill(false), ...Array(8).fill(true)]);
  expect(tags[0]!.find('.tag-label').text()).toBe('Tag TQE0');
  expect(wrapper.text()).toContain('No price on tags, so prices can change.');
  expect(wrapper.text()).not.toContain('The preview shows');
});
it('prints only the name, QR code and tag code, with no fallback line, price, sale type or take line', async () => {
  const qrPng = 'data:image/png;base64,test';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tags: [{ code: 'K7Q2', name: 'Brass lamp', seeded: false, url: 'https://stall.example/i/K7Q2', host: 'stall.example', qrPng }] })));
  const { wrapper } = await open('/owner/tags');
  expect(wrapper.find('.print-controls .btn').text()).toBe('Print 1 tag');
  const tag = wrapper.find('.printed-tag');
  expect(tag.find('h2').text()).toBe('Brass lamp');
  expect(tag.find('img').attributes('src')).toBe(qrPng);
  expect(tag.find('.tag-label').text()).toBe('Tag K7Q2');
  expect(tag.text()).toBe('Brass lampTag K7Q2');
  expect(tag.text()).not.toContain('Take it only');
  expect(tag.text()).not.toMatch(/£|Asking|Fixed price|offers|Pay what you want|Stallkeeper/);
});
it('keeps the tag code outside the clamped name so a maximum-length name cannot hide it', async () => {
  const name = 'Victorian brass and mahogany writing slope with original key and inkwells, boxed';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tags: [{ code: 'K7Q2', name, seeded: false, url: 'https://stall.example/i/K7Q2', host: 'stall.example', qrPng: 'data:image/png;base64,test' }] })));
  const tag = (await open('/owner/tags')).wrapper.find('.printed-tag');
  expect(tag.find('.tag-name').text()).toBe(name);
  expect(tag.find('.tag-name .tag-code').exists()).toBe(false);
  expect(tag.find('.tag-code').text()).toBe('K7Q2');
});
const lowestField = (wrapper: Awaited<ReturnType<typeof open>>['wrapper']) => wrapper.findAll('label').find(label => label.text().includes("Lowest you'd take"));
it('has one buyer-facing notes field and no condition or price drop fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Stall' })));
  const { wrapper } = await open('/owner/items/new');
  expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Condition');
  expect(wrapper.text()).not.toContain('price drops');
  expect(wrapper.findAll('textarea')).toHaveLength(1);
  expect(wrapper.text()).toContain('What buyers should know');
});
it('asks for a lowest price only on a haggle item, and never sends a price drop choice', async () => {
  const saved = { ...item, id: 'lamp', mode: 'fixed', priceVersion: 1, floorPence: null, priceDrops: false, status: 'available', removedReason: null, retailReference: null, photoUrl: null };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === 'POST') return Response.json(saved);
    return Response.json(String(url) === '/api/owner/stall' ? { name: 'Stall' } : { items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/owner/items/new');
  expect(lowestField(wrapper)).toBeUndefined();
  await chooseMode(wrapper, 'Take offers');
  expect(wrapper.text()).toContain('Stallkeeper never sees your floor. Buyers do not see it.');
  await chooseMode(wrapper, 'Fixed price');
  const fields = wrapper.findAll('input');
  await fields[2]!.setValue('Stool'); await fields[3]!.setValue('14'); await wrapper.find('textarea').setValue('Sturdy.');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  const post = fetcher.mock.calls.find(call => call[1]?.method === 'POST');
  const body = JSON.parse(String(post?.[1]?.body));
  expect(body).toMatchObject({ mode: 'fixed', askingPence: 1400, floorPence: null, notes: 'Sturdy.' });
  expect(body).not.toHaveProperty('priceDrops');
  expect(body).not.toHaveProperty('condition');
});
describe('editing an item that has a saved price drop choice', () => {
  const editForm = async (saved: object) => {
    const stored = { ...item, id: 'lamp', floorPence: 900, status: 'available', removedReason: null, retailReference: null, photoUrl: null, priceVersion: 1, ...saved };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => Response.json(init?.method === 'PATCH' ? stored : { items: [stored], sessionStatus: 'closed' }));
    vi.stubGlobal('fetch', fetcher);
    const { wrapper } = await open('/owner/items/lamp');
    const saveBody = async () => {
      await wrapper.find('form').trigger('submit'); await flushPromises();
      return JSON.parse(String(fetcher.mock.calls.find(call => call[1]?.method === 'PATCH')?.[1]?.body));
    };
    return { wrapper, saveBody };
  };
  it('keeps the floor of a fixed item that already allows drops, and leaves the choice to the server', async () => {
    const { wrapper, saveBody } = await editForm({ mode: 'fixed', priceDrops: true });
    expect(lowestField(wrapper)).toBeDefined();
    const body = await saveBody();
    expect(body).toMatchObject({ mode: 'fixed', floorPence: 900 });
    expect(body).not.toHaveProperty('priceDrops');
  });
  it('drops the floor when a haggle item that allowed drops becomes fixed', async () => {
    const { wrapper, saveBody } = await editForm({ mode: 'haggle', priceDrops: true });
    await chooseMode(wrapper, 'Fixed price');
    expect(lowestField(wrapper)).toBeUndefined();
    expect(await saveBody()).toMatchObject({ mode: 'fixed', floorPence: null });
  });
  it('asks for a floor when an opted-out fixed item becomes haggle', async () => {
    const { wrapper, saveBody } = await editForm({ mode: 'fixed', priceDrops: false, floorPence: null });
    expect(lowestField(wrapper)).toBeUndefined();
    await chooseMode(wrapper, 'Take offers');
    await lowestField(wrapper)!.find('input').setValue('9');
    expect(await saveBody()).toMatchObject({ mode: 'haggle', floorPence: 900 });
  });
});
describe('Take off sale', () => {
  const stored = { ...item, id: 'lamp', floorPence: 900, status: 'available', removedReason: null, retailReference: null, photoUrl: null, priceVersion: 1, priceDrops: true };
  const editWith = async (status: string, removal: () => Response = () => Response.json({ removed: true })) => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/remove') ? removal() : Response.json({ items: [{ ...stored, status }], sessionStatus: 'closed' }, { status: init ? 200 : 200 }));
    vi.stubGlobal('fetch', fetcher);
    const { wrapper, router } = await open('/owner/items/lamp');
    return { wrapper, router, fetcher };
  };
  const offSale = (wrapper: Awaited<ReturnType<typeof open>>['wrapper']) => wrapper.findAll('button').filter(button => button.text() === 'Take off sale');
  it('asks first, then removes the item and returns to the Items list', async () => {
    const { wrapper, router, fetcher } = await editWith('available');
    await offSale(wrapper)[0]!.trigger('click');
    expect(fetcher.mock.calls.some(call => String(call[0]).endsWith('/remove'))).toBe(false);
    expect(offSale(wrapper)[0]!.attributes('disabled')).toBeDefined();
    await wrapper.find('[aria-label="Take off sale"] input').setValue('Chipped');
    await offSale(wrapper)[0]!.trigger('click'); await flushPromises();
    const call = fetcher.mock.calls.find(([url]) => String(url) === '/api/owner/items/lamp/remove')!;
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(String(call[1]?.body)).reason).toBe('Chipped');
    expect(router.currentRoute.value.path).toBe('/owner/items');
  });
  it('brings the confirmation into view and puts the cursor in its reason field', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    try {
      const { wrapper } = await editWith('available');
      await offSale(wrapper)[0]!.trigger('click'); await flushPromises();
      const card = wrapper.find('[aria-label="Take off sale"]');
      expect(scrolled.mock.contexts).toContain(card.element);
      expect(document.activeElement).toBe(card.find('input').element);
    } finally { scrolled.mockRestore(); }
  });
  it('stays on the form and says why when a buyer is paying for the item', async () => {
    const { wrapper, router } = await editWith('available', () => Response.json({ error: 'This item cannot be removed.' }, { status: 409 }));
    await offSale(wrapper)[0]!.trigger('click');
    await wrapper.find('[aria-label="Take off sale"] input').setValue('Chipped');
    await offSale(wrapper)[0]!.trigger('click'); await flushPromises();
    expect(wrapper.find('[role=alert]').text()).toContain('cannot be taken off sale right now');
    expect(router.currentRoute.value.path).toBe('/owner/items/lamp');
  });
  it('is not offered for an item that is sold, reserved or on a new item', async () => {
    expect(offSale((await editWith('sold')).wrapper)).toHaveLength(0);
    expect(offSale((await editWith('reserved')).wrapper)).toHaveLength(0);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Stall' })));
    expect(offSale((await open('/owner/items/new')).wrapper)).toHaveLength(0);
  });
});
it('focuses the notes field when the edit page opens from the feed', async () => {
  const owned = { ...item, id: 'lamp', priceVersion: 1, floorPence: 1800, status: 'available', removedReason: null, retailReference: null, photoUrl: null };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [owned] })));
  const { wrapper } = await open('/owner/items/lamp?focus=notes');
  expect(document.activeElement).toBe(wrapper.find('textarea').element);
  wrapper.unmount();
  const plain = (await open('/owner/items/lamp')).wrapper;
  expect(document.activeElement).not.toBe(plain.find('textarea').element);
});
it('saves a manual haggle item in pence and returns to the Items list', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
    if (url === '/api/owner/items' && init?.method === 'POST') return Response.json({ id: 'new-item' }, { status: 201 });
    return Response.json({ items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Brass lamp');
  await chooseMode(wrapper, 'Take offers');
  await wrapper.findAll('input')[3]!.setValue('28.50');
  await wrapper.findAll('input')[4]!.setValue('17.39');
  await wrapper.find('textarea').setValue('Small scuff.');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  const post = fetcher.mock.calls.find(call => call[0] === '/api/owner/items' && call[1]?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ name: 'Brass lamp', askingPence: 2850, floorPence: 1739, mode: 'haggle', notes: 'Small scuff.' });
  expect(router.currentRoute.value.path).toBe('/owner/items');
  await flushPromises();
  expect(wrapper.find('.saved-notice').text()).toBe('Brass lamp is saved.');
});
it('shows the live price with what it was reduced from, and no view count', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item: { ...item, askingPence: 2400, mode: 'fixed', photoUrl: null }, reducedFromPence: 2800, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout: null, card: null, agreedPrice: null, messages: [] })));
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('.price-chip').text()).toBe('£24');
  const was = wrapper.find('[data-test=reduced-from]');
  expect(was.text()).toBe('Reduced from £28');
  expect(was.element.tagName).toBe('S');
  expect(was.element.parentElement!.contains(wrapper.find('.price-chip').element)).toBe(true);
  expect(wrapper.text()).not.toMatch(/viewed|views/i);
});
it('shows an item photo and falls back to a plain placeholder when loading fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item: { ...item, photoUrl: '/api/i/K7Q2/photo' }, stallName: 'Garden stall', availability: 'available' })));
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('.item-photo').attributes('src')).toBe('/api/i/K7Q2/photo');
  await wrapper.find('img').trigger('error');
  expect(wrapper.text()).toContain('No photo added');
});
it('saves details despite upload failure and retries without creating another item', async () => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close })));
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
    if (url === '/api/owner/retail/image-lookup') return Response.json({ candidates: [] });
    if (String(url).endsWith('/photo')) return Response.json({}, { status: ++attempts === 1 ? 502 : 200 });
    if (init?.method) return Response.json({ id: 'saved-item' });
    return Response.json({ items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Lamp');
  await wrapper.findAll('input')[3]!.setValue('28');
  const file = wrapper.find('input[type=file]');
  Object.defineProperty(file.element, 'files', { value: [new File(['photo'], 'lamp.jpg', { type: 'image/jpeg' })] });
  await file.trigger('change'); await flushPromises();
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(wrapper.text()).toContain('Your item details are saved, but the photo was not added');
  expect(wrapper.find('.form-actions > .btn').attributes('disabled')).toBeUndefined();
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(([url, init]) => url === '/api/owner/items' && init?.method === 'POST')).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/owner/items/saved-item' && init?.method === 'PATCH')).toBe(true);
  expect(router.currentRoute.value.path).toBe('/owner/items');
  wrapper.unmount(); context.mockRestore(); encode.mockRestore(); objectUrl.mockRestore(); revoke.mockRestore(); log.mockRestore();
});
it('shows the demo stall refusal and lets the owner finish without the photo', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Demo stall' });
    if (url === '/api/owner/retail/image-lookup') return Response.json({ candidates: [] });
    if (String(url).endsWith('/photo')) return new Response(null, { status: 403 });
    if (init?.method) return Response.json({ id: 'saved-item' });
    return Response.json({ items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Lamp');
  await wrapper.findAll('input')[3]!.setValue('28');
  const file = wrapper.find('input[type=file]');
  Object.defineProperty(file.element, 'files', { value: [new File(['photo'], 'lamp.jpg', { type: 'image/jpeg' })] });
  await file.trigger('change'); await flushPromises();
  expect(wrapper.find('.item-photo').attributes('src')).toBe('blob:photo');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(wrapper.find('[role=alert]').text()).toBe('Photos are turned off for this stall. Your item details are saved.');
  expect(wrapper.find('.item-photo').exists()).toBe(false);
  expect(router.currentRoute.value.path).toBe('/owner/items/new');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/photo'))).toHaveLength(1);
  expect(router.currentRoute.value.path).toBe('/owner/items');
  wrapper.unmount(); context.mockRestore(); encode.mockRestore(); objectUrl.mockRestore(); revoke.mockRestore();
});
it('shows fixed AI identity and opening copy, typing state and a real chat reply', async () => {
  let complete!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { complete = resolve; })
    : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null, card: null, agreedPrice: null }));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.text()).not.toContain("You'll chat with Stallkeeper. It answers from the stallholder's notes.");
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  expect(wrapper.find('.app-titlebar').text()).toBe('Stallkeeper');
  expect(wrapper.find('.bubble.intro').text()).toBe("I'm Stallkeeper, looking after this stall.");
  const about = wrapper.find('.buyer-chat details.opening');
  expect(about.attributes('open')).toBeUndefined();
  expect(about.find('summary').text()).toBe('About Stallkeeper');
  expect(about.find('p').text()).toBe("I answer from the stallholder's notes. Offers are checked against the stallholder's rules, and you choose whether to pay in PayPal.");
  await wrapper.find('#chat-question').setValue('How tall is it?');
  await wrapper.find('.chat-form').trigger('submit');
  expect(wrapper.text()).toContain('Stallkeeper is typing');
  expect(wrapper.find('#chat-question').attributes('maxlength')).toBe('500');
  complete(Response.json({ reply: 'The stallholder says it is 30 cm tall.', turnsLeft: 19, chatAvailable: true, checkout: null, card: null, agreedPrice: null }));
  await flushPromises();
  expect(wrapper.text()).toContain('The stallholder says it is 30 cm tall.');
  expect(wrapper.text()).not.toContain('turns left');
  expect(wrapper.text()).not.toContain('is typing');
  expect(JSON.parse(String(fetcher.mock.calls.find(call => String(call[0]).endsWith('/chat'))?.[1]?.body))).toEqual({ message: 'How tall is it?' });
});
it('keeps the checkout mounted and hidden while chat is open', async () => {
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start: async () => undefined }) }) });
  const fetcher = vi.fn<typeof fetch>(async url => Response.json(url === '/api/config' ? { clientId: 'test' } : { item, stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null }));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/i/K7Q2');
  const pay = wrapper.find('.checkout');
  expect(pay.isVisible()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  expect(pay.isVisible()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === 'Back to the item')!.trigger('click');
  expect(pay.isVisible()).toBe(false);
  await wrapper.find('.buy-now').trigger('click');
  expect(pay.isVisible()).toBe(true);
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  expect(pay.isVisible()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === 'Back to the item')!.trigger('click');
  expect(pay.isVisible()).toBe(true);
  await flushPromises();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/config')).toHaveLength(1);
});
it.each([
  ['keeps the transcript', true],
  ['hides chat with no transcript', false],
])('%s when a failed Pay reports the item reserved', async (_name, asked) => {
  const checkout = { checkoutId: 'checkout1', state: 'awaiting_approval', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 240_000).toISOString(), totalPence: 2800, reviewRequired: false };
  const start = async (_options: unknown, order: Promise<unknown>) => order;
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start }) }) });
  let pressed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (url.endsWith('/chat')) return Response.json({ reply: 'The stallholder says it is 30 cm tall.', turnsLeft: 19, chatAvailable: true });
    if (init?.method === 'POST') { pressed = true; throw new TypeError('Network lost'); }
    if (url.startsWith('/api/checkouts/')) return Response.json(checkout);
    return Response.json({ item, stallName: 'Garden stall', availability: pressed ? 'reserved' : 'available', chatAvailable: !pressed, checkout: pressed ? checkout : null });
  }));
  const { wrapper } = await open('/i/K7Q2');
  const button = (name: string) => wrapper.findAll('button').find(found => found.text() === name);
  if (asked) {
    await button('Ask or make an offer')!.trigger('click');
    await wrapper.find('#chat-question').setValue('How tall is it?');
    await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
    await button('Back to the item')!.trigger('click');
  }
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Reserved for you');
  expect(button('Ask or make an offer')).toBeUndefined();
  expect(button('View your chat') !== undefined).toBe(asked);
  if (!asked) return;
  await button('View your chat')!.trigger('click');
  expect(wrapper.text()).toContain('The stallholder says it is 30 cm tall.');
  expect(wrapper.find('.chat-form').exists()).toBe(false);
  expect(wrapper.find('.checkout').isVisible()).toBe(false);
  await button('Back to the item')!.trigger('click');
  expect(wrapper.find('.checkout').isVisible()).toBe(true);
});
const failedSends: [string, () => Response][] = [
  ['a spent cap or model failure', () => Response.json({ chatAvailable: false }, { status: 503 })],
  ['an item that stopped being available', () => Response.json({ chatAvailable: false }, { status: 409 })],
  ['a server error', () => Response.json({ error: 'Internal Server Error' }, { status: 500 })],
  ['a lost connection', () => { throw new TypeError('Failed to fetch'); }],
];
it.each(failedSends)('hides chat on a first send that hits %s, with no transcript to view', async (_failure, fail) => {
  vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
    ? fail()
    : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: true })));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  await wrapper.find('#chat-question').setValue('Does it work?');
  await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.text()).toContain('Chat is unavailable');
  const lines = wrapper.findAll('p').filter(line => line.isVisible()).map(line => line.text());
  expect(lines).toContain('The stallholder says: Tested, it works. Scuff on base');
  expect(wrapper.find('.price-chip').isVisible()).toBe(true); expect(wrapper.find('.price-chip').text()).toBe('£28');
  expect(lines).not.toContain(opening);
  const buttons = wrapper.findAll('button').filter(button => button.isVisible()).map(button => button.text());
  expect(buttons).not.toContain('View your chat'); expect(buttons).not.toContain('Ask or make an offer');
});
it.each<[string, boolean]>([
  ['a failed first send', true],
  ['a refresh that dropped chat', false],
])('keeps the checkout on screen when chat recovers after %s', async (_name, sent) => {
  const checkout = { checkoutId: 'checkout1', state: 'failed', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 240_000).toISOString(), totalPence: 2800, reviewRequired: false };
  const pages = sent ? [true, true, true] : [true, false, true];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
    ? Response.json({ chatAvailable: false }, { status: 503 })
    : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: pages.shift(), checkout })));
  const { wrapper } = await open('/i/K7Q2');
  const button = (name: string) => wrapper.findAll('button').find(found => found.text() === name)!;
  await button('Ask or make an offer').trigger('click');
  if (sent) {
    await wrapper.find('#chat-question').setValue('Does it work?');
    await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  } else {
    await button('Check availability and try again').trigger('click'); await flushPromises();
  }
  await button('Check availability and try again').trigger('click'); await flushPromises();
  expect(button('Check availability and try again').isVisible()).toBe(true);
  expect(wrapper.find('.notes').isVisible()).toBe(true);
  expect(button('Ask or make an offer').isVisible()).toBe(true);
  expect(wrapper.find('#chat-question').isVisible()).toBe(false);
});
it('says so when Check availability and try again cannot reach the stall', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const checkout = { checkoutId: 'checkout1', state: 'cancelled', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 240_000).toISOString(), totalPence: 2800, reviewRequired: false };
  const pages = [() => Response.json({ item: { ...item, mode: 'fixed' }, stallName: 'Garden stall', availability: 'available', chatAvailable: false, checkout }), () => Promise.reject(new TypeError('Network lost'))];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pages.length > 1 ? pages.shift()!() : pages[0]!()));
  const { wrapper } = await open('/i/K7Q2');
  const retry = () => wrapper.findAll('button').find(found => found.text() === 'Check availability and try again');
  await retry()!.trigger('click'); await flushPromises();
  expect(wrapper.find('[role=alert]').text()).toBe('This item could not refresh. Check your connection and try again.');
  expect(retry()?.isVisible()).toBe(true);
});
it('does not send a buyer whose item failed to load to retype a code that was right', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('h1').text()).toBe('This item could not load. Refresh the page to try again.');
  expect(wrapper.text()).not.toContain('Check the four-character code');
  expect(wrapper.find('#tag-code').exists()).toBe(false);
});
it.each(failedSends)('closes chat on %s while earlier answers, notes and the asking price stay', async (_failure, fail) => {
  vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
  const replies = [() => Response.json({ reply: 'The stallholder says it works.', turnsLeft: 19, chatAvailable: true }), fail];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
    ? replies.shift()!()
    : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: true })));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  for (const question of ['Does it work?', 'How tall is it?']) {
    await wrapper.find('#chat-question').setValue(question);
    await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  }
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.text()).toContain('Chat has ended');
  await wrapper.findAll('button').find(button => button.text() === 'Back to the item')!.trigger('click');
  expect(wrapper.text()).toContain('Scuff on base'); expect(wrapper.text()).toContain('£28');
  expect(wrapper.findAll('button').filter(button => button.isVisible()).map(button => button.text())).not.toContain('Ask or make an offer');
  await wrapper.findAll('button').find(button => button.text() === 'View your chat')!.trigger('click');
  expect(wrapper.findAll('.chat-message').filter(line => line.isVisible()).map(line => line.text())).toEqual(['You: Does it work?', 'Stallkeeper: The stallholder says it works.']);
});
it.each([
  ['the session turns', 0],
  ['the daily cap while turns remain', 15],
])('keeps the final answer and transcript when %s closes chat', async (_cap, turnsLeft) => {
  const replies = [
    { reply: 'The stallholder says it works.', turnsLeft: turnsLeft + 1, chatAvailable: true },
    { reply: 'The stallholder says it is 30 cm tall.', turnsLeft, chatAvailable: false },
  ];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST'
    ? Response.json(replies.shift())
    : Response.json({ item, stallName: 'Garden stall', availability: 'available', chatAvailable: true })));
  const { wrapper } = await open('/i/K7Q2');
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  for (const question of ['Does it work?', 'How tall is it?']) {
    await wrapper.find('#chat-question').setValue(question);
    await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  }
  expect(wrapper.text()).toContain('The stallholder says it works.');
  expect(wrapper.text()).toContain('The stallholder says it is 30 cm tall.');
  expect(wrapper.text()).toContain('Chat has ended');
  expect(wrapper.text()).not.toContain('turns left');
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  await wrapper.findAll('button').find(button => button.text() === 'Back to the item')!.trigger('click');
  expect(wrapper.text()).toContain('Scuff on base'); expect(wrapper.text()).toContain('£28');
  const buttons = wrapper.findAll('button').filter(button => button.isVisible()).map(button => button.text());
  expect(buttons).not.toContain('Ask or make an offer');
  const lines = wrapper.findAll('p').filter(line => line.isVisible()).map(line => line.text());
  expect(lines).not.toContain('Stallkeeper, looking after Garden stall');
  expect(lines).not.toContain(opening);
  await wrapper.findAll('button').find(button => button.text() === 'View your chat')!.trigger('click');
  const transcript = wrapper.findAll('.chat-message').filter(line => line.isVisible()).map(line => line.text());
  expect(transcript).toEqual(['You: Does it work?', 'Stallkeeper: The stallholder says it works.', 'You: How tall is it?', 'Stallkeeper: The stallholder says it is 30 cm tall.']);
});
it('never shows chat for a fixed item even if the API mistakenly enables it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item: { ...item, mode: 'fixed' }, stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null, card: null, agreedPrice: null })));
  const { wrapper } = await open('/i/K7Q2');
  expect(wrapper.find('#chat-question').exists()).toBe(false); expect(wrapper.text()).not.toContain('Stallkeeper, looking after');
  expect(wrapper.text()).not.toContain(opening);
});
it('previews the server ladder for haggle prices and hides it for fixed or invalid ones', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).startsWith('/api/owner/ladder')) return Response.json({ counterOffersPence: [2450, 2200, 2000] });
    if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
    return Response.json({ items: [], sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  const { wrapper } = await open('/owner/items/new');
  const preview = () => wrapper.find('.ladder-preview');
  const ladderCalls = () => fetcher.mock.calls.filter(call => String(call[0]).startsWith('/api/owner/ladder'));
  await wrapper.findAll('input')[3]!.setValue('28.50');
  expect(preview().exists()).toBe(false);
  await chooseMode(wrapper, 'Take offers');
  await wrapper.findAll('input')[4]!.setValue('17.39'); await flushPromises();
  expect(ladderCalls().at(-1)?.[0]).toBe('/api/owner/ladder');
  expect(JSON.parse(String(ladderCalls().at(-1)?.[1]?.body))).toEqual({ askingPence: 2850, floorPence: 1739 });
  expect(preview().text()).toBe('Counter-offers can be £24.50, £22, £20.');
  await wrapper.findAll('input')[4]!.setValue('30'); await flushPromises();
  expect(preview().exists()).toBe(false);
  const calls = ladderCalls().length;
  await wrapper.findAll('input')[4]!.setValue('17.39'); await flushPromises();
  await chooseMode(wrapper, 'Fixed price'); await flushPromises();
  expect(preview().exists()).toBe(false);
  expect(ladderCalls().length).toBe(calls + 1);
});
it('offers Take offers and Fixed price up front, with pay what you want and free behind More ways to sell', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ name: 'Stall' })));
  const { wrapper } = await open('/owner/items/new');
  const primary = wrapper.find('.mode-buttons').findAll('button').map(button => button.text());
  expect(primary).toEqual(['Take offers', 'Fixed price']);
  const more = wrapper.find('.mode-choice details');
  expect(more.find('summary').text()).toBe('More ways to sell');
  expect(more.findAll('button').map(button => button.text())).toEqual(['Pay what you want', 'Free']);
  expect(more.attributes('open')).toBeUndefined();
  await chooseMode(wrapper, 'Free');
  expect(wrapper.text()).toContain('Expected tip, £, for your records');
});
