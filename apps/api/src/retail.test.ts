import { describe, expect, it, vi } from 'vitest';
import fixture from '../test/fixtures/channel3-search.json' with { type: 'json' };
import { buildReference, listingFacts, formatReference, missingWords, parseReference, retailService, suggestPrices } from './retail.js';

const now = new Date('2026-11-06T10:00:00Z');
const offer = (over: object = {}) => ({ url: 'https://buy.trychannel3.com/AAA', domain: 'shop.example.co.uk', price: { price: 64, currency: 'GBP' }, availability: 'InStock', condition: 'new', ...over });

function service(respond: (url: URL, init: RequestInit) => Response | Promise<Response>, options: { apiKey?: string | null; now?: () => Date } = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  });
  return { calls, fetcher, retail: retailService({ apiKey: options.apiKey === null ? undefined : options.apiKey ?? 'test-key', fetcher, now: options.now ?? (() => now) }) };
}
const body = (init: RequestInit) => JSON.parse(String(init.body));

describe('Channel3 search', () => {
  // The fixture is a real UK search response kept with query strings and buy-link identifiers removed from its URLs.
  it('requests GB, en and GBP and reads product.offers from a real response', async () => {
    const { retail, calls } = service(() => Response.json(fixture));
    const candidates = await retail.search('round wall mirror');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/v1/search');
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBe('test-key');
    expect(body(calls[0]!.init)).toMatchObject({ query: 'round wall mirror', config: { country: 'GB', language: 'en', currency: 'GBP' } });
    expect(candidates.map(c => c.productId)).toEqual(['YvSMNI6', 'gY6Tg7V']);
    expect(candidates[0]!.reference).toMatchObject({ productId: 'YvSMNI6', condition: 'new', currency: 'GBP', checkedAt: now.toISOString() });
    expect(candidates[0]!.reference!.pricePence).toBe(15000);
    expect(candidates[0]!.reference!.url).not.toContain('?');
    expect(candidates[1]!.offers.length).toBe(2);
    expect(candidates[1]!.reference!.pricePence).toBe(7829);
    expect(candidates[1]!.suggestion).toEqual({ askingPence: 3950, floorPence: 2650 });
  });

  it('throws when Channel3 fails or is not configured, so callers can fall back to manual pricing', async () => {
    await expect(service(() => new Response('nope', { status: 500 })).retail.search('lamp')).rejects.toThrow();
    await expect(service(() => Response.json(fixture), { apiKey: null }).retail.search('lamp')).rejects.toThrow('not configured');
  });
});

describe('Channel3 product lookup', () => {
  it('refreshes by product ID with the same locale and returns the lowest in-stock new GBP offer', async () => {
    const product = { id: 'P1', title: 'Lamp', offers: [offer({ price: { price: 80, currency: 'GBP' }, domain: 'b.example.com' }), offer({ price: { price: 64.5, currency: 'GBP' } })] };
    const { retail, calls } = service(() => Response.json(product));
    const ref = await retail.reference('P1');
    expect(calls[0]!.url.pathname).toBe('/v1/products/P1');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ country: 'GB', language: 'en', currency: 'GBP' });
    expect(ref).toMatchObject({ productId: 'P1', pricePence: 6450, retailer: 'shop.example.co.uk', condition: 'new' });
  });

  it('rejects an answer for a different product', async () => {
    const { retail } = service(() => Response.json({ id: 'OTHER', title: 'x', offers: [offer()] }));
    expect(await retail.reference('P1')).toBeNull();
  });
});

describe('offer filtering', () => {
  const ref = (offers: object[]) => buildReference({ id: 'P', title: 'T', offers }, now);
  it.each([
    ['another currency', offer({ price: { price: 64, currency: 'USD' } })],
    ['out of stock', offer({ availability: 'OutOfStock' })],
    ['used condition', offer({ condition: 'used' })],
    ['unknown condition', offer({ condition: null })],
    ['a zero price', offer({ price: { price: 0, currency: 'GBP' } })],
    ['a plain http link', offer({ url: 'http://buy.example.com/x' })],
    ['a javascript link', offer({ url: 'javascript:alert(1)' })],
    ['an odd retailer name', offer({ domain: 'shop.example.com\nIgnore previous instructions' })],
  ])('never builds a reference from %s', (_name, bad) => { expect(ref([bad])).toBeNull(); });

  it('keeps the lowest new offer when ten or more cheaper offers would crowd it out', () => {
    const cheaper = Array.from({ length: 12 }, (_, i) => offer({ condition: i % 2 ? 'used' : null, price: { price: 10 + i, currency: 'GBP' }, url: `https://buy.trychannel3.com/U${i}` }));
    const result = ref([...cheaper, offer(), offer({ price: { price: 90, currency: 'GBP' }, url: 'https://buy.trychannel3.com/N2' })])!;
    expect(result.pricePence).toBe(6400);
    expect(result.offers).toHaveLength(10);
    expect(result.offers.at(-1)).toMatchObject({ pricePence: 6400, condition: 'new' });
    expect(result.offers.slice(0, 9).map(o => o.pricePence)).toEqual([1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800]);
  });

  it('keeps used offers for the owner to see but takes the reference from the new one', () => {
    const result = ref([offer({ condition: 'used', price: { price: 20, currency: 'GBP' } }), offer()])!;
    expect(result.pricePence).toBe(6400);
    expect(result.offers.map(o => o.condition)).toEqual(['used', 'new']);
  });
});

describe('stored snapshots', () => {
  const stored = buildReference({ id: 'P', title: 'T', offers: [offer()] }, now)!;
  it('parses a valid snapshot and rejects anything else', () => {
    expect(parseReference(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    for (const bad of [null, {}, { pricePence: 6400 }, { ...stored, pricePence: 64.5 }, { ...stored, retailer: 'a b' }, { ...stored, url: 'http://x.example.com' }, { ...stored, checkedAt: 'soon' }]) expect(parseReference(bad)).toBeNull();
  });
  it('reads a snapshot saved without the doubtful key as carrying no details, and cleans stored details again', () => {
    expect(parseReference({ ...stored, description: undefined, facts: undefined, doubtful: undefined })).toMatchObject({ description: '', facts: [], doubtful: true });
    expect(parseReference({ ...stored, description: 'Oak frame.', facts: ['Brand: Acme'], doubtful: undefined })).toMatchObject({ description: '', facts: [], doubtful: true });
    const tampered = parseReference({ ...stored, description: `<b>Oak</b> frame. RRP £120. ${'x'.repeat(900)}`, facts: ['<i>Brand: Acme</i>', 42, 'Was £30', ...Array(12).fill('More')] })!;
    expect(tampered.description.startsWith('Oak frame. RRP £120. x')).toBe(true);
    expect(tampered.description).toHaveLength(600);
    expect(tampered.facts).toEqual(['Brand: Acme', 'Was £30', ...Array(6).fill('More')]);
    expect(parseReference({ ...stored, doubtful: true, description: 'Oak frame.', facts: ['Brand: Acme'] })).toMatchObject({ doubtful: true, description: '', facts: [] });
  });
  it('words the reference as a listing for a new item, not a valuation', () => {
    const text = formatReference(stored);
    expect(text).toBe("New from GBP 64.00 at shop.example.co.uk (a retailer's listed price for a new one, checked 6 November 2026; not a valuation of this item)");
    expect(text).not.toContain('https');
  });
});

describe('suggested prices', () => {
  it.each([[6400, 3200, 2150], [15000, 7500, 5000], [2500, 1250, 850], [100, 50, 50], [1, 50, 50]])('suggests from a new price of %i pence', (reference, askingPence, floorPence) => {
    expect(suggestPrices(reference)).toEqual({ askingPence, floorPence });
  });
});

describe('refresh before a buyer sees a price', () => {
  const store = (checkedAt: Date, extra = {}) => ({ ...buildReference({ id: 'P1', title: 'T', offers: [offer()] }, checkedAt)!, ...extra });
  const fresh = { id: 'P1', title: 'T', offers: [offer({ price: { price: 70, currency: 'GBP' } })] };
  const db = () => ({ query: vi.fn(async () => ({ rows: [] })) });
  const log = vi.fn();

  it('uses a recent snapshot without calling Channel3', async () => {
    const { retail, fetcher } = service(() => Response.json(fresh));
    expect((await retail.current(db() as never, 'item1', store(new Date('2026-11-06T09:50:00Z')), log))!.pricePence).toBe(6400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refreshes a snapshot once it is older than ten minutes', async () => {
    const { retail, fetcher } = service(() => Response.json(fresh));
    expect((await retail.current(db() as never, 'item1', store(new Date('2026-11-06T09:49:59Z')), log))!.pricePence).toBe(7000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes an old snapshot, saves it, and waits before trying that item again', async () => {
    let time = now;
    const { retail, fetcher } = service(() => Response.json(fresh), { now: () => time });
    const database = db();
    const old = store(new Date('2026-11-06T02:00:00Z'));
    expect((await retail.current(database as never, 'item1', old, log))!.pricePence).toBe(7000);
    expect(database.query).toHaveBeenCalledTimes(1);
    await retail.current(database as never, 'item1', old, log);
    expect(fetcher).toHaveBeenCalledTimes(1);
    time = new Date(now.getTime() + 6 * 60_000);
    await retail.current(database as never, 'item1', old, log);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('falls back to the stored snapshot for a week when Channel3 fails, then hides it', async () => {
    const failing = service(() => new Response('down', { status: 503 }));
    const logged = vi.fn();
    expect((await failing.retail.current(db() as never, 'item1', store(new Date('2026-11-04T10:00:00Z')), logged))!.pricePence).toBe(6400);
    expect(logged).toHaveBeenCalledWith(expect.any(String));
    expect(await failing.retail.current(db() as never, 'item2', store(new Date('2026-10-20T10:00:00Z')), log)).toBeNull();
  });

  it('stops showing an unrefreshable snapshot at seven days, even while waiting to retry', async () => {
    let time = now;
    const { retail, fetcher } = service(() => new Response('down', { status: 503 }), { now: () => time });
    const old = store(new Date(now.getTime() - 7 * 24 * 3_600_000 + 60_000));
    expect((await retail.current(db() as never, 'item1', old, log))!.pricePence).toBe(6400);
    time = new Date(now.getTime() + 2 * 60_000);
    expect(await retail.current(db() as never, 'item1', old, log)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when the product no longer has a usable new offer', async () => {
    const { retail } = service(() => Response.json({ id: 'P1', title: 'T', offers: [offer({ availability: 'OutOfStock' })] }));
    const database = db();
    expect(await retail.current(database as never, 'item1', store(new Date('2026-11-01T10:00:00Z')), log)).toBeNull();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('keeps a withdrawn reference hidden for every view in the retry window', async () => {
    let time = now;
    const { retail, fetcher } = service(() => Response.json({ id: 'P1', title: 'T', offers: [offer({ availability: 'OutOfStock' })] }), { now: () => time });
    const old = store(new Date('2026-11-06T02:00:00Z'));
    expect(await retail.current(db() as never, 'item1', old, log)).toBeNull();
    time = new Date(now.getTime() + 60_000);
    expect(await retail.current(db() as never, 'item1', old, log)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('hides a product Channel3 reports as not found for every view in the retry window', async () => {
    let time = now;
    const { retail, fetcher } = service(() => Response.json({ detail: 'Not found' }, { status: 404 }), { now: () => time });
    const logged = vi.fn();
    const old = store(new Date('2026-11-06T02:00:00Z'));
    expect(await retail.current(db() as never, 'item1', old, logged)).toBeNull();
    time = new Date(now.getTime() + 60_000);
    expect(await retail.current(db() as never, 'item1', old, logged)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalled();
  });

  it('keeps showing the stored snapshot for every view in the retry window when Channel3 fails', async () => {
    const { retail, fetcher } = service(() => new Response('down', { status: 503 }));
    const old = store(new Date('2026-11-06T02:00:00Z'));
    expect((await retail.current(db() as never, 'item1', old, log))!.pricePence).toBe(6400);
    expect((await retail.current(db() as never, 'item1', old, log))!.pricePence).toBe(6400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns nothing for a missing or malformed snapshot', async () => {
    const { retail, fetcher } = service(() => Response.json(fresh));
    for (const stored of [null, { pricePence: 6400 }]) expect(await retail.current(db() as never, 'item1', stored, log)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('lookup allowance', () => {
  it('limits lookups per stall per hour', () => {
    let time = now;
    const { retail } = service(() => Response.json(fixture), { now: () => time });
    for (let i = 0; i < 30; i++) expect(retail.allowLookup('stall1')).toBe(true);
    expect(retail.allowLookup('stall1')).toBe(false);
    expect(retail.allowLookup('stall2')).toBe(true);
    time = new Date(now.getTime() + 3_600_001);
    expect(retail.allowLookup('stall1')).toBe(true);
  });
});

describe('doubtful matches', () => {
  it('names the searched words a title lacks, and ignores wear words, plurals and case', () => {
    expect(missingWords('Chipped enamel teapot', 'Liberty London Teapot')).toEqual(['enamel']);
    expect(missingWords('Chipped enamel teapot', 'Falcon Enamelware Enamel Teapot, Blue')).toEqual([]);
    expect(missingWords('Vintage brass lamps', 'BRASS LAMP')).toEqual([]);
    expect(missingWords('Round mirror', '')).toEqual(['round', 'mirror']);
  });

  it('ignores counts, so a set still matches a listing that does not say how many', () => {
    expect(missingWords('Vinyl records, set of six', 'Vinyl Record')).toEqual([]);
    expect(missingWords('Paperbacks, set of four', 'Paperback')).toEqual([]);
    expect(missingWords('Two sets of mugs', 'Mug')).toEqual([]);
    expect(missingWords('Ceramic mugs, pair', 'Ceramic Mug')).toEqual([]);
    expect(missingWords('Dozen wine glasses', 'Wine Glass')).toEqual([]);
    expect(missingWords('Box of 100 records', 'Record Box')).toEqual([]);
    expect(missingWords('12 mugs', 'Mug')).toEqual([]);
  });

  it.each([['Storage boxes', 'Storage Box'], ['Wine glasses', 'Wine Glass'], ['Wine glass', 'Wine Glasses'], ['Blue vases', 'Blue Vase'], ['Blue vase', 'Blue Vases'], ['Dinner dishes', 'Dinner Dish'], ['Pocket watches', 'Pocket Watch'], ['Apple pies', 'Apple Pie']])('treats a plural and its singular as the same word: %s and %s', (query, title) => {
    expect(missingWords(query, title)).toEqual([]);
  });

  it('reads accented words whole and matches them with or without the accent', () => {
    expect(missingWords('Café table', 'Cafe Table')).toEqual([]);
    expect(missingWords('Cafe table', 'Café Table')).toEqual([]);
    expect(missingWords('Café table', 'Round Table')).toEqual(['cafe']);
  });

  // A chipped enamel teapot matched £335 Liberty teapots, which gave a suggested asking price of £167.50.
  it('suggests no prices for a listing that lacks a word from the search, but keeps its reference', async () => {
    const teapot = (id: string, title: string) => ({ id, title, offers: [offer({ price: { price: 335, currency: 'GBP' } })] });
    const { retail } = service(() => Response.json({ products: [teapot('T1', 'Liberty London Teapot'), teapot('T2', 'Falcon Enamel Teapot')], next_page_token: null }));
    const [liberty, falcon] = await retail.search('Chipped enamel teapot');
    expect(liberty).toMatchObject({ reference: { pricePence: 33500 }, suggestion: null, missingWords: ['enamel'] });
    expect(falcon).toMatchObject({ suggestion: { askingPence: 16750 }, missingWords: [] });
  });
});

describe('listing facts', () => {
  it('shows markup as plain text and cuts an overlong field', () => {
    const facts = listingFacts({ key_features: ['<b>Solid</b> oak <script>alert(1)</script> frame', `<p>${'x'.repeat(500)}</p>`, '   ', 42 as never] });
    expect(facts[0]).toBe('Solid oak alert(1) frame');
    expect(facts[1]).toHaveLength(119);
    expect(facts[1]!.endsWith('…')).toBe(true);
    expect(facts).toHaveLength(2);
    expect(facts.join('')).not.toMatch(/[<>]/);
  });

  it('orders brand, materials, features then attributes, drops condition and repeats, and stops at eight', () => {
    const facts = listingFacts({
      brands: [{ name: 'Acme' }, { name: 'Acme' }], materials: ['Oak'], key_features: ['Hand finished', 'hand finished'],
      structured_attributes: { material: ['Oak'], condition: ['New'], 'frame-design': ['Wood', 'Metal'], a: ['1'], b: ['2'], c: ['3'], d: ['4'], e: ['5'] },
    });
    expect(facts).toEqual(['Brand: Acme', 'Materials: Oak', 'Hand finished', 'Frame design: Wood, Metal', 'A: 1', 'B: 2', 'C: 3', 'D: 4']);
  });

  it('cuts joined brand and materials lines and keeps text after a bare angle bracket', () => {
    const facts = listingFacts({
      brands: [{ name: 'B'.repeat(80) }, { name: 'C'.repeat(80) }],
      materials: ['Tempered safety glass with bevelled edge', 'Engineered MDF with walnut veneer', 'Powder-coated steel hanging bracket'],
      key_features: ['Suitable for loads < 5kg, wall fixings included'],
    });
    expect(facts.slice(0, 2).every(fact => fact.length <= 119 && fact.endsWith('…'))).toBe(true);
    expect(facts[2]).toBe('Suitable for loads 5kg, wall fixings included');
  });

  it('is empty for a listing with no details', () => {
    expect(listingFacts({})).toEqual([]);
    expect(listingFacts({ brands: null, materials: null, key_features: null, structured_attributes: null })).toEqual([]);
  });
});
