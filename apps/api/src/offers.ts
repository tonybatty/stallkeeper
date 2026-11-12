import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { buyerId, expireReservations, transaction } from './checkouts.js';
import { pricingItem, respondToOffer, validateOffer } from './pricing.js';

interface Card {
  id: string; item_id: string; buyer_session_id: string; name: string; code: string;
  amount_pence: number; price_version: number; status: string; expires_at: Date; outcome: string;
}
const publicCard = (card: Card) => ({ id: card.id, itemName: card.name, code: card.code,
  totalPence: card.amount_pence, expiresAt: card.expires_at, kind: card.outcome,
  note: "Price checked against the stallholder's rules" });
const lifetime = 30 * 60_000;
export async function buyerPrices(db: Pool | PoolClient, buyer: string | undefined, item: string, now: Date) {
  if (!buyer) return { card: null, agreedPrice: null };
  const { rows } = await db.query<Card>(`select c.*,i.name,i.code,o.outcome from offer_cards c
    join items i on i.id=c.item_id join offers o on o.id=c.offer_id
    join trading_sessions t on t.stall_id=i.stall_id and t.status='open'
    where i.status='available' and c.buyer_session_id=$1 and c.item_id=$2 and c.status in ('open','agreed')
    and c.price_version=i.price_version and c.expires_at>$3 order by c.agreed_at desc nulls last`, [buyer, item, now]);
  const card = rows.find(c => c.status === 'open');
  const agreed = rows.find(c => c.status === 'agreed');
  return { card: card ? publicCard(card) : null, agreedPrice: agreed ? publicCard(agreed) : null };
}
// Every amount a card has carried for this buyer and item at the current price, whatever became of the card.
export async function issuedAmounts(db: Pool | PoolClient, buyer: string, item: string) {
  const { rows } = await db.query<{ amount_pence: number }>(`select distinct c.amount_pence from offer_cards c join items i on i.id=c.item_id
    where c.buyer_session_id=$1 and c.item_id=$2 and c.price_version=i.price_version`, [buyer, item]);
  return rows.map(row => row.amount_pence);
}
export async function issueOffer(db: Pool, buyer: string, itemId: string, messageId: string, amount: number, now: Date, notify: (stallId: string) => void) {
  let refusedStall: string | undefined;
  const issued = await transaction(db, async tx => {
    const session = (await tx.query<{ id: string; stall_id: string; status: string }>(`select t.id,t.stall_id,t.status from trading_sessions t join items i on i.stall_id=t.stall_id
      where i.id=$1 and t.status <> 'closed' for update of t`, [itemId])).rows[0];
    const item = await pricingItem(tx, itemId);
    if (!item || item.mode !== 'haggle' || session?.status !== 'open') return { outcome: 'unavailable', card: null };
    const round = Number((await tx.query('select coalesce(max(round),0)+1 as round from offers where buyer_session_id=$1 and item_id=$2', [buyer, itemId])).rows[0].round);
    const result = respondToOffer(item, amount, round);
    if (result.outcome === 'unavailable') return { outcome: result.outcome, card: null };
    const offer = (await tx.query<{ id: string }>('insert into offers (item_id,buyer_session_id,message_id,round,amount_pence,outcome) values ($1,$2,$3,$4,$5,$6) returning id', [itemId, buyer, messageId, round, amount, result.outcome])).rows[0]!;
    if (result.outcome !== 'accept') refusedStall = session.stall_id;
    if (result.outcome !== 'accept') await tx.query(`insert into events (stall_id,trading_session_id,type,payload,business_key) values ($1,$2,'offer_refused',$3,$4)`,
      [session.stall_id, session.id, JSON.stringify({ itemName: item.name, code: item.code, offeredPence: amount, reason: result.outcome === 'above_asking' ? 'above_asking' : 'not_agreed' }), `offer:${offer.id}`]);
    if (result.amountPence === null) return { outcome: result.outcome, card: null };
    await tx.query("update offer_cards set status='superseded' where buyer_session_id=$1 and item_id=$2 and status='open'", [buyer, itemId]);
    const card = (await tx.query<Card>(`insert into offer_cards (offer_id,item_id,buyer_session_id,amount_pence,price_version,expires_at) values ($1,$2,$3,$4,$5,$6) returning *`,
      [offer.id, itemId, buyer, result.amountPence, item.price_version, new Date(now.getTime() + lifetime)])).rows[0]!;
    return { outcome: result.outcome, card: publicCard({ ...card, name: item.name, code: item.code, outcome: result.outcome }) };
  });
  if (refusedStall) notify(refusedStall);
  return issued;
}

export async function offerRoutes(app: FastifyInstance, { db, now }: { db: Pool; now: () => Date }) {
  app.post<{ Params: { code: string; id: string } }>('/api/i/:code/cards/:id/accept', {
    schema: { params: { type: 'object', required: ['code','id'], properties: { code: { type: 'string' }, id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const buyer = await buyerId(db, request);
    if (!buyer) return reply.code(401).send({ error: 'Open the item page before agreeing a price.' });
    const located = (await db.query<{ id: string; stall_id: string }>('select id,stall_id from items where code=$1', [request.params.code.toUpperCase()])).rows[0];
    if (located) await expireReservations(db, located.stall_id, now());
    const agreed = located && await transaction(db, async tx => {
      const session = (await tx.query(`select t.status from trading_sessions t join items i on i.stall_id=t.stall_id where i.id=$1 and t.status <> 'closed' for update of t`, [located.id])).rows[0];
      const item = await pricingItem(tx, located.id);
      const card = (await tx.query<Card>('select c.*,o.outcome from offer_cards c join offers o on o.id=c.offer_id where c.id=$1 and c.item_id=$2 and c.buyer_session_id=$3 for update of c', [request.params.id, located.id, buyer])).rows[0];
      if (!item || session?.status !== 'open' || !card || !['open','agreed'].includes(card.status) || card.price_version !== item.price_version || card.expires_at <= now() || validateOffer(item, card.amount_pence) !== 'ok') return null;
      if (card.status === 'open') {
        await tx.query("update offer_cards set status='superseded' where buyer_session_id=$1 and item_id=$2 and status='agreed'", [buyer, item.id]);
        card.expires_at = new Date(now().getTime() + lifetime);
        await tx.query("update offer_cards set status='agreed',agreed_at=$2,expires_at=$3 where id=$1", [card.id, now(), card.expires_at]);
      }
      return publicCard({ ...card, name: item.name, code: item.code });
    });
    return agreed ? { agreedPrice: agreed } : reply.code(409).send({ error: 'This price is no longer available. Refresh the item to check its price and availability.' });
  });
}
