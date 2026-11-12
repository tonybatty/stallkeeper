import { buyerPrices } from './offers.js';
import { buyerId, expireReservations, itemCheckout, transaction } from './checkouts.js';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { chatService } from './chat.js';
import QRCode from 'qrcode';
import { counterLadder, PAY_WHAT_YOU_WANT_MAX_PENCE } from './pricing.js';
import { buyerCharity } from './charity.js';
import { takeFor } from './free.js';
import { parseReference, type RetailRef, type RetailService } from './retail.js';
import { reducedFrom } from './price-review.js';
import { hourlyLimit } from './hourly-limit.js';
import { sessionCounts } from './feed.js';

interface Item {
  photo_key: string | null;
  id: string; code: string; name: string; notes: string;
  mode: 'fixed' | 'haggle' | 'pwyw' | 'free'; asking_pence: number | null; price_version: number; price_drops: boolean;
  status: 'available' | 'sold' | 'removed'; seeded: boolean; illustration: string | null;
  reserved_checkout_id: string | null; removed_reason: string | null;
  floor_pence: number | null; minimum_pence: number | null; seeded_views: number; stall_id: string; stall_name: string; is_demo?: boolean; session_status: string | null; retail_ref: unknown;
}
const columns = `i.id, i.code, i.name, i.notes, i.mode, i.asking_pence, i.minimum_pence,
  i.photo_key, i.price_version, i.price_drops, i.seeded_views, i.status, i.seeded, i.illustration, i.reserved_checkout_id, i.removed_reason, i.retail_ref`;
// For a pay-what-you-want or free item the figure is the owner's own expected amount or tip. It never leaves the server for a buyer, so askingPence is null there.
export const buyerAsking = (item: Pick<Item, 'mode' | 'asking_pence'>) => item.mode === 'pwyw' || item.mode === 'free' ? null : item.asking_pence;
function publicItem(item: Item) {
  return { photoUrl: item.photo_key ? `/api/i/${item.code}/photo` : null, code: item.code, name: item.name, notes: item.notes,
    mode: item.mode, askingPence: buyerAsking(item), minimumPence: item.minimum_pence, seeded: item.seeded, illustration: item.illustration };
}
function ownerItem(item: Item) {
  return { ...publicItem(item), askingPence: item.asking_pence, id: item.id, priceVersion: item.price_version, floorPence: item.floor_pence, priceDrops: item.price_drops,
    status: item.reserved_checkout_id ? 'reserved' : item.status, removedReason: item.removed_reason, retailReference: parseReference(item.retail_ref) };
}
// A free item that is gone was taken, not sold, and the buyer page says so.
export function availability(item: Pick<Item, 'status' | 'session_status' | 'reserved_checkout_id' | 'mode'>) {
  if (item.status !== 'available') return item.status === 'sold' && item.mode === 'free' ? 'taken' : item.status;
  if (item.session_status !== 'open') return 'closed';
  return item.reserved_checkout_id ? 'reserved' : 'available';
}
const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const newItemCode = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
interface Input { name: string; notes: string; mode: 'fixed' | 'haggle' | 'pwyw' | 'free'; askingPence?: number | null; floorPence?: number | null; minimumPence?: number | null; priceDrops?: boolean; retailProductId?: string | null; retailDoubtful?: boolean }
const properties = {
  name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
  notes: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' }, mode: { type: 'string', enum: ['fixed', 'haggle', 'pwyw', 'free'] },
  askingPence: { anyOf: [{ type: 'integer', minimum: 1, maximum: 99999999 }, { type: 'null' }] },
  floorPence: { anyOf: [{ type: 'integer', minimum: 1, maximum: 99999999 }, { type: 'null' }] },
  minimumPence: { anyOf: [{ type: 'integer', minimum: 1, maximum: 99999999 }, { type: 'null' }] },
  priceDrops: { type: 'boolean' },
  // Only the product ID and the doubtful flag come from the browser. The server fetches the price and details itself, so a reference can never be typed in.
  retailProductId: { anyOf: [{ type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, { type: 'null' }] },
  // False only when the owner chose a match the lookup did not flag as doubtful. Left out, the match counts as doubtful, so a request from an
  // older form or a direct API call stores the price line without the listing's details.
  retailDoubtful: { type: 'boolean' },
};
const params = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

// For a haggle item, or a fixed item allowing price drops, the floor is required and capped by the asking price. For pay what you want the figure is the
// owner's own expected amount, optional and never shown to buyers, and the optional minimum is public. For a free item it is the expected tip, with no minimum or floor.
// Returns the owner-facing error, or undefined when the prices are valid.
function priceProblem(mode: Input['mode'], asking: number | null | undefined, floor: number | null | undefined, minimum: number | null | undefined, priceDrops: boolean) {
  if (mode === 'pwyw' || mode === 'free') {
    if (mode === 'pwyw' && minimum && minimum > PAY_WHAT_YOU_WANT_MAX_PENCE) return `Set a minimum of £${PAY_WHAT_YOU_WANT_MAX_PENCE / 100} or less.`;
    if (!asking) return undefined;
    if (asking > PAY_WHAT_YOU_WANT_MAX_PENCE) return `Set an expected ${mode === 'free' ? 'tip' : 'amount'} of £${PAY_WHAT_YOU_WANT_MAX_PENCE / 100} or less.`;
    return mode === 'pwyw' && minimum && minimum > asking ? 'Set a minimum no higher than the expected amount.' : undefined;
  }
  if (!asking) return 'Set an asking price.';
  if (mode === 'haggle' && (!floor || floor > asking)) return 'Set a floor no higher than the asking price.';
  if (priceDrops && (!floor || floor > asking)) return 'To allow price drops, set the lowest you would take, no higher than the asking price.';
  return undefined;
}

// Haggle items allow price drops unless the owner says otherwise. A fixed item needs the owner to opt in, because it needs a floor it never had.
const allowsDrops = (mode: Input['mode'], chosen: boolean | undefined) => (mode === 'haggle' || mode === 'fixed') && (chosen ?? mode === 'haggle');
// Far more than a stallholder adds by hand. Tag codes are never reused, and the demo owner password is public.
const NEW_ITEMS_PER_HOUR = 120;
export const newItemLimit = (now: () => Date) => hourlyLimit(NEW_ITEMS_PER_HOUR, now);
const keepsFloor = (mode: Input['mode'], priceDrops: boolean) => mode === 'haggle' || (mode === 'fixed' && priceDrops);

export async function stockOwnerRoutes(app: FastifyInstance, db: Pool, publicBaseUrl: string, now: () => Date, notify: (stallId: string) => void, retail: RetailService, newItems: ReturnType<typeof newItemLimit>) {
  // Undefined leaves the saved reference alone, null clears it, and an ID that cannot be read back or is over the lookup allowance leaves it alone too: a failed lookup never blocks a save.
  async function resolveRetail(stallId: string, productId: string | null | undefined, doubtful: boolean | undefined, log: { warn: (data: object, message: string) => void }): Promise<{ set: boolean; ref: RetailRef | null; failed: boolean }> {
    if (productId === undefined) return { set: false, ref: null, failed: false };
    if (productId === null) return { set: true, ref: null, failed: false };
    try {
      const ref = retail.enabled && retail.allowLookup(stallId) ? await retail.reference(productId, { doubtful: doubtful !== false }) : null;
      return ref ? { set: true, ref, failed: false } : { set: false, ref: null, failed: true };
    } catch (error) {
      log.warn({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Retail reference lookup failed');
      return { set: false, ref: null, failed: true };
    }
  }
  // Read-only and owner-only: it echoes amounts the owner just typed, so no stored floor is read or returned to anyone else.
  // POST rather than GET because Fastify logs request URLs, and a floor in the query string would reach the logs.
  app.post<{ Body: { askingPence: number; floorPence: number } }>('/api/owner/ladder', {
    schema: { body: { type: 'object', required: ['askingPence', 'floorPence'], additionalProperties: false,
      properties: { askingPence: { type: 'integer', minimum: 1, maximum: 99999999 }, floorPence: { type: 'integer', minimum: 1, maximum: 99999999 } } } },
  }, async (request, reply) => {
    const { askingPence, floorPence } = request.body;
    if (floorPence > askingPence) return reply.code(400).send({ error: 'Set a floor no higher than the asking price.' });
    return { counterOffersPence: counterLadder(askingPence, floorPence) };
  });
  app.get('/api/owner/items', async request => {
    await expireReservations(db, request.stallId, now());
    // The sold price is the completed capture for the item's sale, so the owner home can show what each sale took.
    const { rows } = await db.query<Item & { views: number; sold_pence: number | null }>(`select ${columns}, f.floor_pence, (select count(*)::integer from item_views v where v.item_id = i.id) as views,
      (select cap.amount_pence from checkout_lines l join checkouts c on c.id = l.checkout_id join captures cap on cap.checkout_id = c.id
        where l.item_id = i.id and c.kind = 'sale' and cap.status = 'COMPLETED' order by coalesce(cap.captured_at, cap.observed_at) desc limit 1)::integer as sold_pence
      from items i left join item_floors f on f.item_id = i.id where i.stall_id = $1 order by case i.status when 'available' then 0 when 'sold' then 1 else 2 end, i.created_at, i.id`, [request.stallId]);
    const session = await db.query<{ id: string; status: string }>("select id, status from trading_sessions where stall_id = $1 order by (status <> 'closed') desc, opened_at desc limit 1", [request.stallId]);
    const open = session.rows[0] && session.rows[0].status !== 'closed' ? session.rows[0].status : 'closed';
    // Takings and counts of the current session, or of the latest one once the stall is closed, as the live feed and the closing report count them.
    // The owner home labels them "this session". A stall that has never opened has no session, so it shows none.
    const { recordedSalesPence, ...counted } = session.rows[0] ? await sessionCounts(db, request.stallId, session.rows[0].id) : { recordedSalesPence: 0, itemsSold: 0, itemsTaken: 0 };
    const stallName = (await db.query<{ name: string }>('select name from stalls where id=$1', [request.stallId])).rows[0]!.name;
    return { stallName, items: rows.map(item => ({ ...ownerItem(item), views: item.views, seededViews: item.seeded_views, soldPence: item.sold_pence })), sessionStatus: open, takenPence: recordedSalesPence, ...counted };
  });
  app.post<{ Body: Input }>('/api/owner/items', {
    schema: { body: { type: 'object', required: ['name', 'notes', 'mode'], additionalProperties: false, properties } },
  }, async (request, reply) => {
    const input = request.body;
    const priceDrops = allowsDrops(input.mode, input.priceDrops);
    const problem = priceProblem(input.mode, input.askingPence, input.floorPence, input.minimumPence, priceDrops);
    if (problem) return reply.code(400).send({ error: problem });
    if (!newItems.allow(request.stallId)) return reply.code(429).send({ error: 'Too many items have been added this hour. Try again later.' });
    const reference = await resolveRetail(request.stallId, input.retailProductId, input.retailDoubtful, request.log);
    const client = await db.connect();
    let unusable: Error | undefined;
    try {
      await client.query('begin');
      await client.query('select id from stalls where id=$1 for no key update', [request.stallId]);
      const session = (await client.query<{ id: string }>("select id from trading_sessions where stall_id=$1 and status <> 'closed' for update", [request.stallId])).rows[0];
      let item: Item | undefined;
      for (let attempt = 0; attempt < 100 && !item; attempt++) {
        item = (await client.query<Item>(`insert into items (stall_id, code, name, notes, mode, asking_pence, minimum_pence, price_drops)
          values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (code) do nothing returning *`,
        [request.stallId, newItemCode(), input.name.trim(), input.notes.trim(), input.mode, input.askingPence ?? null, input.mode === 'pwyw' ? input.minimumPence ?? null : null, priceDrops])).rows[0];
      }
      if (!item) throw new Error('Unable to allocate tag code');
      if (session) await client.query('insert into session_stock values ($1,$2)', [session.id, item.id]);
      item.floor_pence = keepsFloor(input.mode, priceDrops) ? input.floorPence ?? null : null;
      if (item.floor_pence !== null) await client.query('insert into item_floors values ($1,$2)', [item.id, item.floor_pence]);
      if (reference.ref) { await client.query('update items set retail_ref=$2 where id=$1', [item.id, JSON.stringify(reference.ref)]); item.retail_ref = reference.ref; }
      await client.query('commit');
      notify(request.stallId);
      return reply.code(201).send({ ...ownerItem(item), retailLookupFailed: reference.failed });
    } catch (error) { await client.query('rollback').catch((failed: Error) => { unusable = failed; }); throw error; } finally { client.release(unusable); }
  });
  app.patch<{ Params: { id: string }; Body: Partial<Input> }>('/api/owner/items/:id', {
    schema: { params, body: { type: 'object', minProperties: 1, additionalProperties: false, properties } },
  }, async (request, reply) => {
    await expireReservations(db, request.stallId, now());
    const owned = await db.query('select 1 from items where id=$1 and stall_id=$2', [request.params.id, request.stallId]);
    if (!owned.rowCount) return reply.code(404).send({ error: 'Item not found.' });
    const reference = await resolveRetail(request.stallId, request.body.retailProductId, request.body.retailDoubtful, request.log);
    const client = await db.connect();
    let unusable: Error | undefined;
    try {
      await client.query('begin');
      const item = (await client.query<Item>(`select ${columns}, f.floor_pence from items i left join item_floors f on f.item_id = i.id where i.id = $1 and i.stall_id = $2 for update of i`, [request.params.id, request.stallId])).rows[0];
      if (!item) { await client.query('rollback'); return reply.code(404).send({ error: 'Item not found.' }); }
      const body = request.body;
      const mode = body.mode ?? item.mode;
      const freeChange = mode !== item.mode && (mode === 'free' || item.mode === 'free');
      // The buyer page and closing report tell a take from a sale by the mode, so it has to stay on the right side of free once the item has gone.
      if (freeChange && item.status === 'sold') { await client.query('rollback'); return reply.code(400).send({ error: 'An item that has been taken or sold cannot change to or from free.' }); }
      // A checkout started as a sale has to finish as one: the buyer page words it from the mode, and a free item can be taken by anyone while the buyer still pays.
      if (freeChange && item.reserved_checkout_id) { await client.query('rollback'); return reply.code(400).send({ error: 'A buyer is paying for this item, so it cannot change to or from free. Try again when the reservation ends.' }); }
      const asking = body.askingPence === undefined ? item.asking_pence : body.askingPence;
      const floor = body.floorPence === undefined ? item.floor_pence : body.floorPence;
      const minimum = mode !== 'pwyw' ? null : body.minimumPence === undefined ? item.minimum_pence : body.minimumPence;
      // A change of mode goes back to the new mode's default, so a fixed item never opts in by accident.
      const priceDrops = allowsDrops(mode, body.priceDrops ?? (mode === item.mode ? item.price_drops : undefined));
      const problem = priceProblem(mode, asking, floor, minimum, priceDrops);
      if (problem) { await client.query('rollback'); return reply.code(400).send({ error: problem }); }
      const savedFloor = keepsFloor(mode, priceDrops) ? floor : null;
      const priceEdit = mode !== item.mode || asking !== item.asking_pence || savedFloor !== item.floor_pence || minimum !== item.minimum_pence;
      const updated = (await client.query<Item>(`update items set name=$3, notes=$4, mode=$5, asking_pence=$6, minimum_pence=$8, price_drops=$9, price_version=price_version+$7 where id=$1 and stall_id=$2 returning *`,
        [item.id, request.stallId, body.name?.trim() ?? item.name, body.notes?.trim() ?? item.notes, mode, asking, priceEdit ? 1 : 0, minimum, priceDrops])).rows[0]!;
      if (savedFloor !== null) await client.query('insert into item_floors values ($1,$2) on conflict (item_id) do update set floor_pence=excluded.floor_pence', [item.id, savedFloor]);
      else await client.query('delete from item_floors where item_id=$1', [item.id]);
      if (priceEdit) await client.query(`update offer_cards c set status='superseded' where c.item_id=$1 and
        (c.status='open' or (c.status='agreed' and not exists (select 1 from checkouts co
          where co.offer_card_id=c.id and co.state in ('creating','awaiting_approval','capturing','checking'))))`, [item.id]);
      updated.floor_pence = savedFloor;
      // A reference change is not a price edit: it leaves price_version and open offer cards alone.
      if (reference.set) await client.query('update items set retail_ref=$2 where id=$1', [item.id, reference.ref && JSON.stringify(reference.ref)]);
      updated.retail_ref = reference.set ? reference.ref : item.retail_ref;
      await client.query('commit');
      return { ...ownerItem(updated), retailLookupFailed: reference.failed };
    } catch (error) { await client.query('rollback').catch((failed: Error) => { unusable = failed; }); throw error; } finally { client.release(unusable); }
  });
  app.post<{ Params: { id: string }; Body: { reason: string } }>('/api/owner/items/:id/remove', {
    schema: { params, body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } } } },
  }, async (request, reply) => {
    await expireReservations(db, request.stallId, now());
    const result = await db.query("update items set status='removed', removed_at=now(), removed_reason=$3 where id=$1 and stall_id=$2 and status='available' and reserved_checkout_id is null returning id", [request.params.id, request.stallId, request.body.reason.trim()]);
    if (!result.rowCount) return reply.code(409).send({ error: 'This item cannot be removed.' });
    notify(request.stallId);
    return { removed: true };
  });
  app.post('/api/owner/stall/open', async (request, reply) => {
    const rows = await transaction(db, async tx => {
      await tx.query('select id from stalls where id=$1 for no key update', [request.stallId]);
      const { rows } = await tx.query<{ id: string }>("insert into trading_sessions (stall_id,charity_name,charity_percent) select id,charity_name,charity_percent from stalls where id=$1 on conflict (stall_id) where status <> 'closed' do nothing returning id", [request.stallId]);
      if (rows[0]) await tx.query("insert into session_stock select $1,id from items where stall_id=$2 and status='available'", [rows[0].id, request.stallId]);
      return rows;
    });
    if (!rows[0]) return reply.code(409).send({ error: 'This stall already has an unclosed trading session.' });
    notify(request.stallId);
    return reply.code(201).send({ id: rows[0].id, status: 'open' });
  });
  app.get('/api/owner/tags', async request => {
    const { rows } = await db.query<Item>(`select ${columns} from items i where i.stall_id=$1 and i.status='available' order by i.created_at, i.id`, [request.stallId]);
    const stallName = (await db.query<{ name: string }>('select name from stalls where id=$1', [request.stallId])).rows[0]!.name;
    return { stallName, tags: await Promise.all(rows.map(async item => {
      const url = new URL(`/i/${item.code}`, publicBaseUrl).href;
      // No price or sale type: a printed tag cannot follow a price that changes (ADR 0009).
      return { code: item.code, name: item.name, seeded: item.seeded, url, host: new URL(publicBaseUrl).host,
        qrPng: await QRCode.toDataURL(url, { margin: 4, scale: 6, errorCorrectionLevel: 'M' }) };
    })) };
  });
}

export async function buyerRoutes(app: FastifyInstance, { db, production, now, chat, retail }: { db: Pool; production: boolean; now: () => Date; chat: ReturnType<typeof chatService>; retail: RetailService }) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.get('/api/stall', async () => {
    const stall = (await db.query<{ id: string; name: string }>('select id,name from stalls where is_demo=false')).rows[0]!;
    await expireReservations(db, stall.id, now());
    const { rows } = await db.query<Item>(`select ${columns}, t.status as session_status from items i left join trading_sessions t on t.stall_id=i.stall_id and t.status <> 'closed' where i.stall_id=$1 and i.status <> 'removed' order by i.created_at, i.id`, [stall.id]);
    return { name: stall.name, items: rows.map(item => ({ ...publicItem(item), availability: availability(item) })) };
  });
  app.get<{ Params: { code: string } }>('/api/i/:code', async (request, reply) => {
    const located = (await db.query<{ stall_id: string }>('select stall_id from items where code=$1', [request.params.code.toUpperCase()])).rows[0];
    if (located) await expireReservations(db, located.stall_id, now());
    let raw = request.cookies.stallkeeper_buyer;
    const hash = (token: string) => createHash('sha256').update(token).digest('hex');
    const known = raw && /^[a-f0-9]{64}$/.test(raw) && (await db.query('select id from buyer_sessions where token_hash=$1', [hash(raw)])).rowCount;
    if (!known) {
      const token = randomBytes(32).toString('hex');
      raw = token;
      await db.query('insert into buyer_sessions (token_hash) values ($1)', [hash(token)]);
      reply.setCookie('stallkeeper_buyer', token, { httpOnly: true, sameSite: 'lax', secure: production, path: '/api', maxAge: 60 * 60 * 24 * 30 });
    }
    const { rows } = await db.query<Item>(`select ${columns}, i.stall_id, s.name as stall_name, s.is_demo, t.status as session_status from items i join stalls s on s.id=i.stall_id left join trading_sessions t on t.stall_id=i.stall_id and t.status <> 'closed' where i.code=$1`, [request.params.code.toUpperCase()]);
    const item = rows[0];
    if (!item) return reply.code(404).send({ error: 'That tag is not on this stall.' });
    // Read from the token, because a first visit's cookie is only set on this response. One row per visitor, however often the page reloads.
    await db.query('insert into item_views (item_id,buyer_session_id) select $1,id from buyer_sessions where token_hash=$2 on conflict do nothing', [item.id, hash(raw!)]);
    const buyer = await buyerId(db, request);
    // The refresh happens here, before the buyer sees a price, and never throws: Channel3 down means the stored snapshot or no reference.
    // Only an item on sale refreshes. A sold, reserved or closed-stall item keeps its saved snapshot and its checked date, with no Channel3 call, so the "New from" line stays. A removed item shows none.
    const reference = availability(item) === 'available' ? await retail.current(db, item.id, item.retail_ref, errorType => request.log.warn({ errorType }, 'Retail refresh failed'))
      : item.status === 'removed' ? null : parseReference(item.retail_ref);
    // Someone else paying holds the item only until their reservation runs out, so the buyer page can say when it may free up.
    const reservedUntil = availability(item) === 'reserved' ? (await db.query<{ reservation_deadline: Date }>("select reservation_deadline from checkouts where id=$1 and state in ('creating','awaiting_approval') and not review_required", [item.reserved_checkout_id])).rows[0]?.reservation_deadline.toISOString() ?? null : null;
    const asking = buyerAsking(item);
    const reducedFromPence = availability(item) === 'available' && asking !== null ? await reducedFrom(db, item.stall_id, item.id, asking) : null;
    return { item: publicItem(item), reservedUntil, reducedFromPence, retailReference: reference && { pricePence: reference.pricePence, retailer: reference.retailer, url: reference.url, checkedAt: reference.checkedAt }, stallName: item.stall_name, charity: await buyerCharity(db, item.stall_id), demoStall: !!item.is_demo, availability: availability(item), chatAvailable: item.mode === 'haggle' && availability(item) === 'available' && await chat.available(raw), ...await buyerPrices(db, buyer, item.id, now()), checkout: await itemCheckout(db, buyer, item.id), take: await takeFor(db, buyer, item.id), messages: await chat.transcript(buyer, item.id) };
  });
}
