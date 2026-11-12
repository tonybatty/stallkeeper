import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './checkouts.js';

interface JourneyRow {
  id: string;
  item_id: string;
  item: string;
  code: string;
  session_id: string | null;
  at: Date;
  stage: 'Listed' | 'Price dropped' | 'Offer' | 'Offer shown' | 'Agreed' | 'Paid' | 'Refunded';
  amount: number | null;
  previous_amount: number | null;
  outcome: string | null;
  note: string | null;
  source: 'items' | 'events' | 'offers' | 'offer_cards' | 'captures' | 'refunds';
}

const pounds = (pence: number) => pence / 100;

// Every branch selects only values the ledger may expose. In particular, the payment branches use a sale event or a
// hash for the row id, so checkout and PayPal ids never become part of the returned shape.
async function ledgerJourneys(tx: PoolClient, stallId: string) {
  const { rows } = await tx.query<JourneyRow>(`
    with journeys as (
      select '01-listed:' || i.id::text as id,i.id as item_id,i.name as item,i.code,
        (select t.id from trading_sessions t where t.stall_id=i.stall_id and t.opened_at<=i.created_at order by t.opened_at desc,t.id desc limit 1) as session_id,
        i.created_at as at,'Listed'::text as stage,
        coalesce((select (e.payload->>'oldPence')::integer from events e
          where e.stall_id=$1 and e.type='price_drop' and e.payload->>'itemId'=i.id::text order by e.created_at,e.id limit 1),i.asking_pence) as amount,
        null::integer as previous_amount,null::text as outcome,null::text as note,'items'::text as source
      from items i where i.stall_id=$1

      union all

      select '02-price-drop:' || e.id::text,i.id,i.name,i.code,e.trading_session_id,e.created_at,'Price dropped',
        (e.payload->>'newPence')::integer,(e.payload->>'oldPence')::integer,null,e.payload->>'reason','events'
      from events e join items i on i.id::text=e.payload->>'itemId' and i.stall_id=e.stall_id
      where e.stall_id=$1 and e.type='price_drop'

      union all

      select '03-offer:' || o.id::text,i.id,i.name,i.code,
        (select t.id from trading_sessions t where t.stall_id=i.stall_id and t.opened_at<=o.created_at order by t.opened_at desc,t.id desc limit 1),
        o.created_at,'Offer',o.amount_pence,null,o.outcome,null,'offers'
      from offers o join items i on i.id=o.item_id where i.stall_id=$1

      union all

      select '04-card:' || c.id::text,i.id,i.name,i.code,
        (select t.id from trading_sessions t where t.stall_id=i.stall_id and t.opened_at<=o.created_at order by t.opened_at desc,t.id desc limit 1),
        o.created_at,'Offer shown',c.amount_pence,null,o.outcome,null,'offer_cards'
      from offer_cards c join offers o on o.id=c.offer_id join items i on i.id=c.item_id where i.stall_id=$1

      union all

      select '05-agreed:' || c.id::text,i.id,i.name,i.code,
        (select t.id from trading_sessions t where t.stall_id=i.stall_id and t.opened_at<=c.agreed_at order by t.opened_at desc,t.id desc limit 1),
        c.agreed_at,'Agreed',c.amount_pence,null,'agreed',null,'offer_cards'
      from offer_cards c join items i on i.id=c.item_id where i.stall_id=$1 and c.agreed_at is not null

      union all

      select '06-paid:' || e.id::text,i.id,i.name,i.code,c.trading_session_id,coalesce(cap.captured_at,cap.observed_at),'Paid',
        cap.amount_pence,null,null,null,'captures'
      from events e join checkouts c on c.stall_id=e.stall_id and c.trading_session_id=e.trading_session_id
        and e.business_key='sale:' || c.id::text and e.type='sale' and c.kind='sale'
      join captures cap on cap.paypal_capture_id=e.payload->>'captureId' and cap.checkout_id=c.id
      join lateral (select item_id from checkout_lines where checkout_id=c.id order by item_id limit 1) l on true
      join items i on i.id=l.item_id
      where e.stall_id=$1 and cap.status='COMPLETED'

      union all

      select '07-refunded:' || md5(r.paypal_refund_id),i.id,i.name,i.code,c.trading_session_id,r.observed_at,'Refunded',
        -r.amount_pence,null,null,null,'refunds'
      from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id
      join checkouts c on c.id=cap.checkout_id
      join lateral (select item_id from checkout_lines where checkout_id=c.id order by item_id limit 1) l on true
      join items i on i.id=l.item_id
      where c.stall_id=$1 and c.kind='sale' and cap.status='COMPLETED' and r.status='COMPLETED'
    )
    select id,item_id,item,code,session_id,at,stage,amount,previous_amount,outcome,note,source
    from journeys order by at,id
  `, [stallId]);

  return rows.map(row => ({
    id: row.id,
    itemId: row.item_id,
    item: row.item,
    code: row.code,
    sessionId: row.session_id,
    at: row.at.toISOString(),
    stage: row.stage,
    amount: row.amount === null ? null : pounds(row.amount),
    previousAmount: row.previous_amount === null ? null : pounds(row.previous_amount),
    outcome: row.outcome,
    note: row.note,
    source: row.source,
  }));
}

export async function ledgerJourneyRoutes(app: FastifyInstance, db: Pool) {
  app.get('/api/owner/ledger/journeys', async request => transaction(db, async tx => {
    await tx.query('set transaction isolation level repeatable read read only');
    return ledgerJourneys(tx, request.stallId);
  }));
}
