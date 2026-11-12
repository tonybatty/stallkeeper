import { Channel3, Channel3Error } from '@channel3/sdk';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { isJpeg } from './photos.js';
import { hourlyLimit } from './hourly-limit.js';

// Everything here is a retailer listing from Channel3. It is never a sale price or a valuation of the owner's used item.
const locale = { country: 'GB', language: 'en', currency: 'GBP' } as const;
const SEARCH_TIMEOUT_SECONDS = 8;
const BUYER_TIMEOUT_SECONDS = 3;
// Buyer page views and chat turns refresh a snapshot only when it is older than this, so rapid views do not each wait on Channel3.
const REFRESH_AFTER_MS = 10 * 60 * 1000;
// After any refresh attempt, success or not, wait this long before trying that item again.
const RETRY_AFTER_MS = 5 * 60 * 1000;
// A snapshot that cannot be refreshed stops being shown once it is this old.
const SHOW_UNREFRESHED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OFFERS = 10;
const MAX_CANDIDATES = 5;
const LOOKUPS_PER_HOUR = 30;
const MAX_FACTS = 8;
const MAX_FACT_LENGTH = 119;
const MAX_DESCRIPTION_LENGTH = 600;

export interface RetailOffer { retailer: string; url: string; pricePence: number; condition: 'new' | 'used' | null }
// The stored snapshot in items.retail_ref. pricePence is the lowest in-stock new GBP offer, and is the field the chat amount check reads.
// `description` and `facts` are plain text from the retailer's listing for a new one. The owner sees them on the form and the AI stallholder
// gets them as the retailer's details, never as the owner's words. Buyer pages do not carry them.
// `doubtful` marks a match the owner chose although its title lacks a searched word. Its price line works as usual, and it carries no details.
// A snapshot stored without the key predates it and is read as doubtful, so it gains no details until the owner picks the match again.
export interface RetailRef {
  productId: string; title: string; pricePence: number; currency: 'GBP'; condition: 'new';
  retailer: string; url: string; checkedAt: string; offers: RetailOffer[]; description: string; facts: string[]; doubtful: boolean;
}
// `missingWords` are words from the owner's search that the listing's title does not contain. A listing with any is a doubtful match, so it carries no suggested prices and no listing details.
export interface RetailCandidate { productId: string; title: string; checkedAt: string; offers: RetailOffer[]; reference: RetailRef | null; suggestion: { askingPence: number; floorPence: number } | null; missingWords: string[] }

const hostname = /^(?=.{1,100}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function safeUrl(value: unknown) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  return url?.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
}

// Only an in-stock offer priced in GBP counts. Nothing is converted, because a converted figure would be invented.
function usableOffer(offer: { url?: unknown; domain?: unknown; price?: { price?: unknown; currency?: unknown } | null; availability?: unknown; condition?: unknown }): RetailOffer | undefined {
  const price = offer.price?.price;
  const url = safeUrl(offer.url);
  const retailer = typeof offer.domain === 'string' ? offer.domain.toLowerCase() : '';
  if (offer.availability !== 'InStock' || offer.price?.currency !== 'GBP' || typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1_000_000) return;
  if (!url || !hostname.test(retailer)) return;
  return { retailer, url, pricePence: Math.round(price * 100), condition: offer.condition === 'new' || offer.condition === 'used' ? offer.condition : null };
}

// The cheapest offers, always keeping the lowest new one: it is the reference, and cheaper used offers must not push it out.
function shownOffers(offers: Parameters<typeof usableOffer>[0][] | null | undefined) {
  const usable = (offers ?? []).map(usableOffer).filter((offer): offer is RetailOffer => !!offer).sort((a, b) => a.pricePence - b.pricePence);
  const lowestNew = usable.find(offer => offer.condition === 'new');
  const shown = usable.slice(0, MAX_OFFERS);
  if (lowestNew && !shown.includes(lowestNew)) shown[MAX_OFFERS - 1] = lowestNew;
  return shown;
}

interface ListingProduct { description?: unknown; brands?: { name?: unknown }[] | null; materials?: unknown[] | null; key_features?: unknown[] | null; structured_attributes?: Record<string, unknown> | null }
interface SearchProduct extends ListingProduct { id: string; title?: string | null; offers?: Parameters<typeof usableOffer>[0][] | null }

// Listing text is shop-written and arrives as markup sometimes, so it is reduced to plain text and cut short. The form shows it as text, never as HTML.
function plainFact(value: unknown, maxLength = MAX_FACT_LENGTH) {
  if (typeof value !== 'string') return '';
  const text = value.slice(0, 4000).replace(/<[^>]*>/g, ' ').replace(/[<>\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
const listingDescription = (product: ListingProduct) => plainFact(product.description, MAX_DESCRIPTION_LENGTH);
const plainList = (values: unknown) => (Array.isArray(values) ? values : []).map(text => plainFact(text)).filter(Boolean);

// Taken from the product in each search result, so the facts shown on the form cost no extra Channel3 call, and again from the product read on save and refresh. Brand, materials, key features, then structured attributes. Condition is never taken from a listing, so a "condition" attribute is dropped.
export function listingFacts(product: ListingProduct): string[] {
  const brands = [...new Set(plainList((product.brands ?? []).map(brand => brand?.name)))];
  const materials = plainList(product.materials);
  const facts = [...(brands.length ? [`Brand: ${brands.join(', ')}`] : []), ...(materials.length ? [`Materials: ${materials.join(', ')}`] : []), ...plainList(product.key_features)];
  for (const [key, value] of Object.entries(product.structured_attributes ?? {}).slice(0, 40)) {
    const label = plainFact(key.replace(/[-_]+/g, ' '));
    const values = plainList(Array.isArray(value) ? value : [value]);
    if (!label || !values.length || /condition/i.test(label) || (/^materials?$/i.test(label) && materials.length)) continue;
    facts.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${values.join(', ')}`);
  }
  const seen = new Set<string>();
  return facts.map(text => plainFact(text)).filter(fact => fact && !seen.has(fact.toLowerCase()) && !!seen.add(fact.toLowerCase())).slice(0, MAX_FACTS);
}

export function buildReference(product: SearchProduct, checkedAt: Date, doubtful = false): RetailRef | null {
  const offers = shownOffers(product.offers);
  const best = offers.find(offer => offer.condition === 'new');
  if (!best || !product.id) return null;
  return { productId: product.id, title: (product.title ?? '').slice(0, 200), pricePence: best.pricePence, currency: 'GBP', condition: 'new',
    retailer: best.retailer, url: best.url, checkedAt: checkedAt.toISOString(), offers, description: doubtful ? '' : listingDescription(product), facts: doubtful ? [] : listingFacts(product), doubtful };
}

// jsonb can hold anything, so every stored snapshot is checked before it reaches a buyer or the model.
export function parseReference(value: unknown): RetailRef | null {
  const ref = value as Partial<RetailRef> | null;
  if (!ref || typeof ref !== 'object' || typeof ref.productId !== 'string' || !ref.productId || !Number.isSafeInteger(ref.pricePence) || ref.pricePence! <= 0
    || ref.currency !== 'GBP' || ref.condition !== 'new' || typeof ref.retailer !== 'string' || !hostname.test(ref.retailer)
    || !safeUrl(ref.url) || typeof ref.checkedAt !== 'string' || Number.isNaN(Date.parse(ref.checkedAt))) return null;
  const doubtful = ref.doubtful !== false;
  return { productId: ref.productId, title: typeof ref.title === 'string' ? ref.title : '', pricePence: ref.pricePence!, currency: 'GBP', condition: 'new',
    retailer: ref.retailer, url: ref.url!, checkedAt: ref.checkedAt, offers: Array.isArray(ref.offers) ? ref.offers : [],
    description: doubtful ? '' : plainFact(ref.description, MAX_DESCRIPTION_LENGTH), facts: doubtful ? [] : plainList(ref.facts).slice(0, MAX_FACTS), doubtful };
}

// Half the lowest new price is a starting point for second-hand goods, not a valuation. The owner edits both figures.
export function suggestPrices(referencePence: number) {
  const up = (pence: number) => Math.ceil(pence / 50) * 50;
  const askingPence = Math.max(50, up(referencePence / 2));
  return { askingPence, floorPence: Math.min(askingPence, Math.max(50, up(askingPence * 2 / 3))) };
}

// Words that describe the owner's copy or how many they have, rather than the product, so a shop title rarely repeats them.
const ignored = new Set(['chipped', 'cracked', 'damaged', 'broken', 'faulty', 'vintage', 'antique', 'retro', 'old', 'used', 'worn', 'faded', 'scuffed', 'scratched', 'rusty', 'tested', 'working', 'spare', 'the', 'and', 'for', 'with', 'set', 'sets', 'pair', 'pairs', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'twelve', 'dozen']);
// Both sides of a comparison pass through this, so a result only has to match, not be a real word: vase and vases meet at vas, and box and boxes at box.
const stem = (word: string) => word.length > 3 ? word.replace(/(?<=.{3})es$|e$|(?<!s)s$/, '') : word;
const words = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
export function missingWords(query: string, title: string) {
  const present = new Set(words(title).map(stem));
  return [...new Set(words(query).filter(word => word.length > 2 && !ignored.has(word) && !/^\p{N}+$/u.test(word)))].filter(word => !present.has(stem(word)));
}

export function formatReference(ref: RetailRef) {
  const date = new Date(ref.checkedAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
  return `New from GBP ${(ref.pricePence / 100).toFixed(2)} at ${ref.retailer} (a retailer's listed price for a new one, checked ${date}; not a valuation of this item)`;
}

export type RetailService = ReturnType<typeof retailService>;

export function retailService({ apiKey, fetcher, now }: { apiKey?: string; fetcher?: typeof fetch; now: () => Date }) {
  const client = apiKey ? new Channel3({ apiKey, fetch: fetcher, maxRetries: 0, timeoutInSeconds: SEARCH_TIMEOUT_SECONDS }) : undefined;

  function candidates(products: SearchProduct[], query?: string): RetailCandidate[] {
    const checkedAt = now();
    const results: RetailCandidate[] = [];
    for (const product of products) {
      const title = (product.title ?? '').slice(0, 200);
      const missing = query ? missingWords(query, title) : [];
      const reference = buildReference(product, checkedAt, missing.length > 0);
      const offers = shownOffers(product.offers);
      if (!reference && !offers.length) continue;
      results.push({ productId: product.id, title, checkedAt: checkedAt.toISOString(), offers, reference, suggestion: reference && !missing.length ? suggestPrices(reference.pricePence) : null, missingWords: missing });
      if (results.length === MAX_CANDIDATES) break;
    }
    return results;
  }

  async function search(query: string): Promise<RetailCandidate[]> {
    if (!client) throw new Error('Channel3 is not configured');
    const page = await client.products.search({ query, limit: 10, config: locale });
    return candidates(page.data, query);
  }

  async function searchImage(bytes: Buffer): Promise<RetailCandidate[]> {
    if (!client) throw new Error('Channel3 is not configured');
    const page = await client.products.searchByImage({ base64_image: bytes.toString('base64'), limit: 10, config: locale });
    return candidates(page.data);
  }

  // Throws when Channel3 cannot be reached. Returns null when the product is gone or has no usable new GBP offer.
  // A caller that does not say the match is sound gets a doubtful reference: the price line only, with no details for the AI stallholder.
  async function reference(productId: string, { timeoutInSeconds = SEARCH_TIMEOUT_SECONDS, doubtful = true } = {}): Promise<RetailRef | null> {
    if (!client) throw new Error('Channel3 is not configured');
    try {
      const product = await client.products.retrieve({ product_id: productId, ...locale }, { timeoutInSeconds, maxRetries: 0 });
      return product.id === productId ? buildReference(product, now(), doubtful) : null;
    } catch (error) {
      if (error instanceof Channel3Error && error.statusCode === 404) return null;
      throw error;
    }
  }

  // The refresh before a buyer sees a price. Any failure falls back to the stored snapshot for a week, so Channel3 can never break an item page.
  const attempts = new Map<string, { at: number; result: Promise<RetailRef | null | undefined> }>();
  function current(db: Pool, itemId: string, stored: unknown, log: (errorType: string) => void): Promise<RetailRef | null> {
    const ref = parseReference(stored);
    if (!ref) return Promise.resolve(null);
    const age = now().getTime() - Date.parse(ref.checkedAt);
    if (age <= REFRESH_AFTER_MS) return Promise.resolve(ref);
    const stale = age < SHOW_UNREFRESHED_FOR_MS ? ref : null;
    if (!client) return Promise.resolve(stale);
    const shown = (fresh: RetailRef | null | undefined) => fresh === undefined ? stale : fresh;
    const previous = attempts.get(itemId);
    if (previous && now().getTime() - previous.at < RETRY_AFTER_MS) return previous.result.then(shown);
    if (attempts.size > 500) attempts.clear();
    const result = reference(ref.productId, { timeoutInSeconds: BUYER_TIMEOUT_SECONDS, doubtful: ref.doubtful }).then(async fresh => {
      if (fresh) await db.query('update items set retail_ref=$2 where id=$1 and retail_ref->>\'productId\'=$3 and retail_ref->>\'checkedAt\'=$4', [itemId, JSON.stringify(fresh), ref.productId, ref.checkedAt]);
      return fresh;
    }).catch((error: unknown) => { log(error instanceof Error ? error.name : 'Unknown'); return undefined; });
    attempts.set(itemId, { at: now().getTime(), result });
    return result.then(shown);
  }

  // Searches spend credits and the demo owner password is public.
  const allowLookup = hourlyLimit(LOOKUPS_PER_HOUR, now).allow;

  return { enabled: !!client, search, searchImage, reference, current, allowLookup };
}

const unavailable = { error: 'Price lookup is unavailable. You can still set the price yourself.' };

// Owner-only. A failed, empty or unconfigured lookup never blocks saving an item: the form falls back to manual pricing.
export async function retailOwnerRoutes(owner: FastifyInstance, retail: RetailService) {
  owner.post<{ Body: { query: string } }>('/api/owner/retail/lookup', {
    schema: { body: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: { type: 'string', minLength: 2, maxLength: 120, pattern: '\\S' } } } },
  }, async (request, reply) => {
    if (!retail.enabled) return reply.code(503).send(unavailable);
    if (!retail.allowLookup(request.stallId)) return reply.code(429).send({ error: 'Too many price lookups this hour. You can still set the price yourself.' });
    try {
      return { candidates: await retail.search(request.body.query.trim()) };
    } catch (error) {
      // The error text is not logged: SDK errors can carry the response body.
      request.log.warn({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Price lookup failed');
      return reply.code(503).send(unavailable);
    }
  });

  owner.post<{ Body: Buffer }>('/api/owner/retail/image-lookup', { bodyLimit: 512 * 1024 }, async (request, reply) => {
    if (!isJpeg(request.body)) return reply.code(400).send({ error: 'Choose a JPEG photo.' });
    if (!retail.enabled) return reply.code(503).send(unavailable);
    if (!retail.allowLookup(request.stallId)) return reply.code(429).send({ error: 'Too many price lookups this hour. You can still set the price yourself.' });
    try {
      return { candidates: await retail.searchImage(request.body) };
    } catch (error) {
      // The error text is not logged: SDK errors can carry the response body.
      request.log.warn({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Photo price lookup failed');
      return reply.code(503).send(unavailable);
    }
  });
}
