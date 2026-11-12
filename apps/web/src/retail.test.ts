import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
const chooseMode = async (wrapper: { findAll: (s: string) => Array<{ text: () => string; trigger: (e: string) => Promise<unknown> }> }, label: string) => { await wrapper.findAll('button').find(button => button.text() === label)!.trigger('click'); };
enableAutoUnmount(afterEach);
beforeEach(() => vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => false }) }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function open(path: string) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push(path); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises(); return { router, wrapper };
}
const item = { code: 'K7Q2', name: 'Round mirror', notes: 'Good used condition. 40 cm across', askingPence: 2800, mode: 'fixed', seeded: false };
const reference = { pricePence: 6400, retailer: 'shop.example.co.uk', url: 'https://buy.trychannel3.com/P1', checkedAt: '2026-11-06T10:00:00.000Z' };
// The owner's API adds the listing details to a reference. A buyer's item page never carries them.
const ownerReference = { ...reference, description: 'A round wall mirror with a silver frame.', facts: ['Brand: Laura Ashley', 'Materials: Glass, MDF'], doubtful: false };
const candidate = {
  productId: 'P1', title: 'Overton Round Wall Mirror', checkedAt: '2026-11-06T10:00:00.000Z',
  offers: [{ retailer: 'shop.example.co.uk', url: 'https://buy.trychannel3.com/P1', pricePence: 6400, condition: 'new' }, { retailer: 'resale.example.com', url: 'https://buy.trychannel3.com/P2', pricePence: 3000, condition: 'used' }, { retailer: 'other.example.com', url: 'https://buy.trychannel3.com/P3', pricePence: 7000, condition: null }],
  reference: ownerReference, suggestion: { askingPence: 3200, floorPence: 2150 }, missingWords: [] as string[],
};

it('shows a buyer the retail reference as a dated listing, and nothing when there is none', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, retailReference: reference, stallName: 'Garden stall', availability: 'available', checkout: null })));
  const { wrapper } = await open('/i/K7Q2');
  const line = wrapper.find('.retail-reference');
  expect(line.text()).toContain('New from £64 at shop.example.co.uk');
  expect(line.text()).toContain('checked 6 Nov 2026');
  expect(line.text()).toContain('Not a valuation of this item');
  expect(line.find('a').attributes()).toMatchObject({ href: 'https://buy.trychannel3.com/P1', rel: 'noopener noreferrer' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ item, retailReference: null, stallName: 'Garden stall', availability: 'available', checkout: null })));
  expect((await open('/i/K7Q2')).wrapper.find('.retail-reference').exists()).toBe(false);
});

function ownerApi(lookup: () => Response | Promise<Response>, save: () => Response = () => Response.json({ id: 'new-item', retailReference: ownerReference }, { status: 201 }), items: object[] = [], imageLookup = lookup) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/owner/stall') return Response.json({ name: 'Garden stall' });
    if (url === '/api/owner/retail/lookup') return lookup();
    if (url === '/api/owner/retail/image-lookup') return imageLookup();
    if (init?.method === 'POST' || init?.method === 'PATCH') return save();
    return Response.json({ items, sessionStatus: 'closed' });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const saved = (fetcher: ReturnType<typeof ownerApi>) => JSON.parse(String(fetcher.mock.calls.find(([url, init]) => url === '/api/owner/items' && init?.method === 'POST')?.[1]?.body));

it('lists offers with condition, source and date, and fills the price fields from a chosen match', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [candidate] }));
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await chooseMode(wrapper, 'Take offers');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  expect(JSON.parse(String(fetcher.mock.calls.find(call => call[0] === '/api/owner/retail/lookup')?.[1]?.body))).toEqual({ query: 'Round mirror' });
  const text = wrapper.find('.candidates').text();
  expect(text).toContain('£64 at shop.example.co.uk · new · checked 6 Nov 2026');
  expect(text).toContain('£30 at resale.example.com · used');
  expect(text).toContain('£70 at other.example.com · condition unknown');
  expect(wrapper.find('.candidates').findAll('button').map(button => button.text())).toEqual(['Use this match']);
  await wrapper.findAll('button').find(button => button.text() === 'Use this match')!.trigger('click');
  expect((wrapper.findAll('input')[3]!.element as HTMLInputElement).value).toBe('');
  await wrapper.find('[data-test="use-suggestion"]').trigger('click');
  const inputs = wrapper.findAll('input');
  expect((inputs[3]!.element as HTMLInputElement).value).toBe('32.00');
  expect((inputs[4]!.element as HTMLInputElement).value).toBe('21.50');
  await inputs[3]!.setValue('30.00');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toMatchObject({ retailProductId: 'P1', askingPence: 3000, floorPence: 2150 });
  expect(router.currentRoute.value.path).toBe('/owner/items');
});

it('leaves manual pricing working and sends no reference when the lookup fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fetcher = ownerApi(() => Response.json({ error: 'raw upstream detail' }, { status: 503 }));
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('input')[3]!.setValue('28');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Price lookup is unavailable. You can still set the price yourself.');
  expect(wrapper.text()).not.toContain('raw upstream detail');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).not.toHaveProperty('retailProductId');
  expect(router.currentRoute.value.path).toBe('/owner/items');
});

it('says no useful reference was found for an empty result and never offers a price', async () => {
  ownerApi(() => Response.json({ candidates: [] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Odd family heirloom');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('No useful reference found. Set the price yourself.');
  expect(wrapper.text()).not.toContain('Use this match');
});

const usedOnly = { ...candidate, productId: 'P2', title: 'Used mirror', reference: null, suggestion: null, offers: [candidate.offers[1]] };

it('says no useful reference was found when no candidate has a new offer in stock', async () => {
  ownerApi(() => Response.json({ candidates: [usedOnly] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('No useful reference found. Set the price yourself.');
  expect(wrapper.text()).not.toContain('Use this match');
  expect(wrapper.find('.candidates').exists()).toBe(false);
});

it('marks a candidate with no new offer in stock when another one can be used', async () => {
  ownerApi(() => Response.json({ candidates: [candidate, usedOnly] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  const cards = wrapper.findAll('.candidates > li');
  expect(cards[0]!.text()).toContain('Use this match');
  expect(cards[1]!.text()).toContain('No new offer in stock, so this cannot be a reference.');
  expect(cards[1]!.text()).not.toContain('Use this match');
  expect(wrapper.text()).not.toContain('No useful reference found');
});

it('ends the attempt when the owner says none match, keeping their prices and storing no reference', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [candidate] }));
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Odd family heirloom');
  await wrapper.findAll('input')[3]!.setValue('28');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Use this match')!.trigger('click');
  await wrapper.findAll('button').find(button => button.text() === 'None of these match')!.trigger('click');
  expect(wrapper.text()).toContain('No useful reference found. Set the price yourself.');
  expect(wrapper.text()).not.toContain('Selected:');
  expect(wrapper.find('.candidates').exists()).toBe(false);
  expect((wrapper.findAll('input')[3]!.element as HTMLInputElement).value).toBe('28');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toMatchObject({ askingPence: 2800 });
  expect(saved(fetcher)).not.toHaveProperty('retailProductId');
  expect(router.currentRoute.value.path).toBe('/owner/items');
});

const savedItem = { ...item, id: 'item-1', floorPence: null, photoUrl: null, retailReference: ownerReference };
const patched = (fetcher: ReturnType<typeof ownerApi>) => JSON.parse(String(fetcher.mock.calls.find(([url, init]) => url === '/api/owner/items/item-1' && init?.method === 'PATCH')?.[1]?.body));
const editApi = () => ownerApi(() => Response.json({ candidates: [candidate] }), () => Response.json({ id: 'item-1', retailReference: ownerReference }), [savedItem]);
const button = (wrapper: Awaited<ReturnType<typeof open>>['wrapper'], label: string) => wrapper.findAll('button').find(found => found.text() === label)!;

it.each([
  ['None of these match', 'None of these match'],
  ['removing the selection', 'Remove'],
])('keeps a saved reference after %s', async (_name, label) => {
  const fetcher = editApi();
  const { wrapper } = await open('/owner/items/item-1');
  await button(wrapper, 'Find new prices').trigger('click'); await flushPromises();
  await button(wrapper, 'Use this match').trigger('click');
  await button(wrapper, label).trigger('click');
  expect(wrapper.text()).toContain('Saved reference: New from £64 at shop.example.co.uk');
  expect(wrapper.text()).not.toContain('Selected:');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(patched(fetcher)).not.toHaveProperty('retailProductId');
});

it('still removes a saved reference the owner removed before saying none match', async () => {
  const fetcher = editApi();
  const { wrapper } = await open('/owner/items/item-1');
  await button(wrapper, 'Remove').trigger('click');
  await button(wrapper, 'Find new prices').trigger('click'); await flushPromises();
  await button(wrapper, 'Use this match').trigger('click');
  await button(wrapper, 'None of these match').trigger('click');
  expect(wrapper.text()).not.toContain('Saved reference:');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(patched(fetcher).retailProductId).toBeNull();
});

it('starts a new attempt when the owner searches again after saying none match', async () => {
  ownerApi(() => Response.json({ candidates: [candidate] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'None of these match')!.trigger('click');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).not.toContain('No useful reference found');
  expect(wrapper.find('.candidates').text()).toContain('Overton Round Wall Mirror');
});

it('keeps the saved item and says so when the retailer price could not be added', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [candidate] }), () => Response.json({ id: 'new-item', retailReference: null, retailLookupFailed: true }, { status: 201 }));
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('input')[3]!.setValue('28');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Use this match')!.trigger('click');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/owner/items/new');
  expect(wrapper.find('[role=alert]').text()).toContain('Your item is saved, but the retailer price could not be added');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(fetcher.mock.calls.filter(([url, init]) => url === '/api/owner/items/new-item' && init?.method === 'PATCH')).toHaveLength(1);
});

it.each([
  ['the photo uploads', 200, 1, false],
  ['the photo upload fails', 502, 2, true],
])('still sends the photo when the retailer price could not be added and %s', async (_name, photoStatus, uploads, photoFailed) => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const inner = ownerApi(() => Response.json({ candidates: [candidate] }), () => Response.json({ id: 'new-item', retailReference: null, retailLookupFailed: true }, { status: 201 }));
  const fetcher = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/photo') ? new Response(null, { status: photoStatus }) : inner(url, init));
  vi.stubGlobal('fetch', fetcher);
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('input')[3]!.setValue('28');
  const file = wrapper.find('input[type=file]');
  Object.defineProperty(file.element, 'files', { value: [new File(['photo'], 'mirror.jpg', { type: 'image/jpeg' })] });
  await file.trigger('change'); await flushPromises();
  await button(wrapper, 'Find new prices').trigger('click'); await flushPromises();
  await button(wrapper, 'Use this match').trigger('click');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  const photoPosts = () => fetcher.mock.calls.filter(([url, init]) => url === '/api/owner/items/new-item/photo' && init?.method === 'POST');
  expect(photoPosts()).toHaveLength(1);
  expect(router.currentRoute.value.path).toBe('/owner/items/new');
  expect(wrapper.text()).toContain('Your item is saved, but the retailer price could not be added');
  expect(wrapper.text().includes('the photo was not added')).toBe(photoFailed);
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(photoPosts()).toHaveLength(uploads);
});

const searchBox = (wrapper: Awaited<ReturnType<typeof open>>['wrapper']) => wrapper.findAll('label').find(label => label.text().startsWith('Search for'))!.find('input');
const lookupBodies = (fetcher: ReturnType<typeof ownerApi>) => fetcher.mock.calls.filter(call => call[0] === '/api/owner/retail/lookup').map(call => JSON.parse(String(call[1]?.body)));
const findPrices = (wrapper: Awaited<ReturnType<typeof open>>['wrapper']) => wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click');
function stubPhotoPreparation() {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:photo');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
}

it.each([
  ['add', '/owner/items/new', []],
  ['edit', '/owner/items/item-1', [savedItem]],
])('looks up prices from a new photo on the %s form and keeps text search available', async (_name, path, items) => {
  stubPhotoPreparation();
  const fetcher = ownerApi(() => Response.json({ candidates: [] }), undefined, items, () => Response.json({ candidates: [candidate] }));
  const { wrapper } = await open(path);
  const file = wrapper.find('input[type=file]');
  Object.defineProperty(file.element, 'files', { value: [new File(['photo'], 'mirror.jpg', { type: 'image/jpeg' })] });
  await file.trigger('change'); await flushPromises();
  const imageCall = fetcher.mock.calls.find(([url]) => url === '/api/owner/retail/image-lookup')!;
  expect(imageCall[1]?.headers).toEqual({ 'content-type': 'image/jpeg' });
  expect(imageCall[1]?.body).toBeInstanceOf(Blob);
  expect((wrapper.find('[data-test="retail-details"]').element as HTMLDetailsElement).open).toBe(true);
  expect(wrapper.find('.candidates').text()).toContain('Overton Round Wall Mirror');
  expect(wrapper.find('.candidates').text()).toContain('Suggestion: asking £32');
  await searchBox(wrapper).setValue('round mirror');
  await findPrices(wrapper); await flushPromises();
  expect(lookupBodies(fetcher)).toEqual([{ query: 'round mirror' }]);
});

it('keeps manual pricing usable when the photo lookup fails', async () => {
  stubPhotoPreparation();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const fetcher = ownerApi(() => Response.json({ candidates: [] }), undefined, [], () => Response.json({ error: 'raw upstream detail' }, { status: 503 }));
  const { wrapper, router } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('input')[3]!.setValue('28');
  const file = wrapper.find('input[type=file]');
  Object.defineProperty(file.element, 'files', { value: [new File(['photo'], 'mirror.jpg', { type: 'image/jpeg' })] });
  await file.trigger('change'); await flushPromises();
  expect(wrapper.text()).toContain('Price lookup is unavailable. You can still set the price yourself.');
  expect(wrapper.text()).not.toContain('raw upstream detail');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toMatchObject({ askingPence: 2800 });
  expect(router.currentRoute.value.path).toBe('/owner/items');
});

it('shows the item name in the search box as it is typed, and searches what the box shows', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [] }));
  const { wrapper } = await open('/owner/items/new');
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('');
  await wrapper.findAll('input')[2]!.setValue('Chipped enamel teapot');
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('Chipped enamel teapot');
  await findPrices(wrapper); await flushPromises();
  await searchBox(wrapper).setValue('enamel teapot');
  await wrapper.findAll('input')[2]!.setValue('Chipped enamel teapot, blue');
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('enamel teapot');
  await findPrices(wrapper); await flushPromises();
  expect(lookupBodies(fetcher)).toEqual([{ query: 'Chipped enamel teapot' }, { query: 'enamel teapot' }]);
});

it('goes back to the item name after the box is left blank, without refilling it while the owner types', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Brass lamp');
  await searchBox(wrapper).setValue('');
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('');
  await wrapper.findAll('input')[2]!.setValue('Brass desk lamp');
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('Brass desk lamp');
  await searchBox(wrapper).setValue('   ');
  await findPrices(wrapper); await flushPromises();
  expect((searchBox(wrapper).element as HTMLInputElement).value).toBe('Brass desk lamp');
  expect(lookupBodies(fetcher)).toEqual([{ query: 'Brass desk lamp' }]);
});

it('warns about a listing that lacks the searched words, offers no suggested prices for it and tells the server it is doubtful', async () => {
  const liberty = { ...candidate, productId: 'P9', title: 'Liberty London Teapot', suggestion: null, missingWords: ['enamel'],
    offers: [{ retailer: 'shop.example.co.uk', url: 'https://buy.trychannel3.com/P9', pricePence: 33500, condition: 'new' }], reference: { ...reference, pricePence: 33500, description: '', facts: [], doubtful: true } };
  const fetcher = ownerApi(() => Response.json({ candidates: [liberty] }));
  const { wrapper } = await open('/owner/items/new');
  await wrapper.findAll('input')[2]!.setValue('Chipped enamel teapot');
  await findPrices(wrapper); await flushPromises();
  expect(wrapper.find('[data-test="weak-match"]').text()).toContain('does not mention enamel');
  expect(wrapper.find('.candidates').text()).not.toContain('Suggestion:');
  const buttons = wrapper.findAll('button').map(button => button.text());
  expect(buttons).toContain('Use this match');
  expect(wrapper.find('[data-test="details-withheld"]').text()).toBe("If you use it, Stallkeeper AI will not use this listing's details when answering buyers.");
  await wrapper.findAll('button').find(button => button.text() === 'Use this match')!.trigger('click');
  expect(wrapper.find('[data-test="use-suggestion"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="listing-facts"]').text()).toContain("Stallkeeper AI does not use this listing's details");
  expect(wrapper.find('[data-test="listing-facts"]').text()).not.toContain('The listing has no details.');
  await wrapper.findAll('input')[3]!.setValue('28');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(saved(fetcher)).toMatchObject({ retailProductId: 'P9', retailDoubtful: true });
});

const useMatch = async (wrapper: Awaited<ReturnType<typeof open>>['wrapper']) => {
  await wrapper.findAll('input')[2]!.setValue('Round mirror');
  await wrapper.findAll('button').find(button => button.text() === 'Find new prices')!.trigger('click'); await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Use this match')!.trigger('click');
};

it('shows the listing details after a match is chosen, says Stallkeeper AI can use them, and leaves the notes alone', async () => {
  const fetcher = ownerApi(() => Response.json({ candidates: [candidate] }));
  const { wrapper } = await open('/owner/items/new');
  expect(wrapper.find('[data-test="listing-facts"]').exists()).toBe(false);
  await useMatch(wrapper);
  const details = wrapper.find('[data-test="listing-facts"]');
  expect(details.text()).toContain("From the retailer's listing for a new one");
  expect(details.text()).toContain("Stallkeeper AI can use these when answering buyers, as the retailer's details for a new one.");
  expect(details.text()).toContain('A round wall mirror with a silver frame.');
  expect(details.findAll('li').map(fact => fact.text())).toEqual(['Brand: Laura Ashley', 'Materials: Glass, MDF']);
  expect(details.findAll('button')).toHaveLength(0);
  expect(wrapper.text()).not.toContain('Add to notes');
  expect(wrapper.text()).not.toContain('unless you press the button');
  expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');
  await wrapper.findAll('input')[3]!.setValue('28');
  await wrapper.find('form').trigger('submit'); await flushPromises();
  // The server reads the details from Channel3 itself, so the form sends the product ID and the doubtful flag, never the details.
  expect(saved(fetcher)).toMatchObject({ notes: '', retailProductId: 'P1', retailDoubtful: false });
  expect(wrapper.find('[data-test="details-withheld"]').exists()).toBe(false);
  expect(JSON.stringify(saved(fetcher))).not.toMatch(/facts|description|Laura Ashley/);
});

it('says the listing has no details when there are none', async () => {
  ownerApi(() => Response.json({ candidates: [{ ...candidate, reference: { ...ownerReference, description: '', facts: [] } }] }));
  const { wrapper } = await open('/owner/items/new');
  await useMatch(wrapper);
  expect(wrapper.find('[data-test="listing-facts"]').text()).toContain('The listing has no details.');
  expect(wrapper.find('[data-test="listing-facts"]').text()).not.toContain('Stallkeeper AI can use');
});

it('says on the edit form that a saved doubtful reference gives Stallkeeper AI no details', async () => {
  ownerApi(() => Response.json({ candidates: [] }), undefined, [{ ...savedItem, retailReference: { ...reference, description: '', facts: [], doubtful: true } }]);
  const { wrapper } = await open('/owner/items/item-1');
  expect(wrapper.find('[data-test="listing-facts"]').text()).toContain("Stallkeeper AI does not use this listing's details. To change that, search again and choose a match.");
  expect(wrapper.find('[data-test="listing-facts"]').text()).not.toContain('The listing has no details.');
});

it('shows the saved listing details on the edit form until the owner removes the reference', async () => {
  const fetcher = editApi();
  const { wrapper } = await open('/owner/items/item-1');
  expect(wrapper.find('[data-test="listing-facts"]').text()).toContain('A round wall mirror with a silver frame.');
  await button(wrapper, 'Remove').trigger('click');
  expect(wrapper.find('[data-test="listing-facts"]').exists()).toBe(false);
  await wrapper.find('form').trigger('submit'); await flushPromises();
  expect(patched(fetcher).retailProductId).toBeNull();
});
