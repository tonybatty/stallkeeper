import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './checkouts.js';
import { hourlyLimit } from './hourly-limit.js';

export interface Charity { name: string; percent: number; seeded: boolean }
export interface Donation { transactionId: string; amountPence: number; currency: string; recordedAt: string }

// The pledge is the stated percentage of recorded sales (completed captures less completed refunds), rounded down to
// the penny so a report never pledges more than the percentage it states.
export function pledgePence(recordedSalesPence: number, percent: number) {
  return Math.floor(Math.max(0, recordedSalesPence) * percent / 100);
}

// The only wording the buyer page and the AI stallholder use, so neither can restate the pledge differently.
export const buyerLine = (charity: Pick<Charity, 'name' | 'percent'>) => `${charity.percent}% of today's takings go to ${charity.name}.`;

// A stall row or session still holding this pledge keeps the seeded label.
export const demoPledge = { name: 'Sample Charity', percent: 10 };

interface PledgeRow { charity_name: string | null; charity_percent: number | null; is_demo: boolean }
// Both columns are null or both are set (see the set-together constraints on stalls and trading_sessions).
// Seeded only while it still is the seeded pledge: the demo owner password is public, so an edit must not borrow the label.
const toCharity = (row?: PledgeRow): Charity | null => row?.charity_name && row.charity_percent ? {
  name: row.charity_name, percent: row.charity_percent,
  seeded: row.is_demo && row.charity_name === demoPledge.name && row.charity_percent === demoPledge.percent,
} : null;

async function stallCharity(db: Pick<Pool | PoolClient, 'query'>, stallId: string) {
  return toCharity((await db.query<PledgeRow>('select charity_name,charity_percent,is_demo from stalls where id=$1', [stallId])).rows[0]);
}

export async function sessionCharity(db: Pick<Pool | PoolClient, 'query'>, sessionId: string) {
  return toCharity((await db.query<PledgeRow>('select t.charity_name,t.charity_percent,s.is_demo from trading_sessions t join stalls s on s.id=t.stall_id where t.id=$1', [sessionId])).rows[0]);
}

// Buyers read the open session's pledge, so they are told what its closing report will use. With no open session it is the stall's.
export async function tradingCharity(db: Pick<Pool | PoolClient, 'query'>, stallId: string) {
  const open = (await db.query<{ id: string }>("select id from trading_sessions where stall_id=$1 and status='open'", [stallId])).rows[0];
  return open ? sessionCharity(db, open.id) : stallCharity(db, stallId);
}

// A buyer sees the owner's stated pledge in one fixed line, and whether it is the seeded demo pledge. No amount of any kind.
export async function buyerCharity(db: Pool, stallId: string) {
  const charity = await tradingCharity(db, stallId);
  return charity && { line: buyerLine(charity), seeded: charity.seeded };
}

const controlCharacters = /\p{Cc}/u;
// The amount arrives from the owner's browser as the Donate button reported it, a decimal string such as "2.80".
export function parseDonationAmount(value: string) {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const pence = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return pence > 0 ? pence : null;
}

export async function donationsFor(db: Pick<Pool | PoolClient, 'query'>, sessionId: string): Promise<Donation[]> {
  const { rows } = await db.query<{ paypal_transaction_id: string; amount_pence: number; currency: string; recorded_at: Date }>('select paypal_transaction_id,amount_pence,currency,recorded_at from charity_donations where trading_session_id=$1 order by recorded_at,paypal_transaction_id', [sessionId]);
  return rows.map(row => ({ transactionId: row.paypal_transaction_id, amountPence: row.amount_pence, currency: row.currency, recordedAt: row.recorded_at.toISOString() }));
}

const recordedSale = "exists(select 1 from captures cap join checkouts c on c.id=cap.checkout_id where c.trading_session_id=t.id and cap.status='COMPLETED')";

export async function charityRoutes(app: FastifyInstance, db: Pool, now: () => Date, notify: (stallId: string) => void, donateButton: boolean) {
  // An open session follows the stall until its first recorded sale. From then on buyers have paid under its pledge, so an edit waits for the next session.
  const savePledge = (stallId: string, name: string | null, percent: number | null) => transaction(db, async tx => {
    await tx.query('update stalls set charity_name=$2,charity_percent=$3 where id=$1', [stallId, name, percent]);
    await tx.query(`update trading_sessions t set charity_name=$2,charity_percent=$3 where stall_id=$1 and status='open' and not ${recordedSale}`, [stallId, name, percent]);
  });
  const ownerPledge = async (stallId: string) => ({
    charity: await stallCharity(db, stallId), donateButton,
    sessionFixed: !!(await db.query<{ fixed: boolean }>(`select ${recordedSale} as fixed from trading_sessions t where stall_id=$1 and status='open'`, [stallId])).rows[0]?.fixed,
  });
  app.get('/api/owner/stall/charity', request => ownerPledge(request.stallId));
  app.put<{ Body: { name: string; percent: number } }>('/api/owner/stall/charity', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'percent'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' },
      percent: { type: 'integer', minimum: 1, maximum: 100 },
    } } },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name || controlCharacters.test(name)) return reply.code(400).send({ error: 'Give the charity name as plain text.' });
    await savePledge(request.stallId, name, request.body.percent);
    notify(request.stallId);
    return ownerPledge(request.stallId);
  });
  app.delete('/api/owner/stall/charity', async request => {
    await savePledge(request.stallId, null, null);
    notify(request.stallId);
    return ownerPledge(request.stallId);
  });
  // The Donate button reports once per closing and nothing here proves the money moved, while the demo owner password is public.
  const donations = hourlyLimit(20, now);
  // Records what the Donate button's completion callback reported. It writes only charity_donations, so no capture,
  // refund or sales total can change. Nothing here proves the money moved: the closing report says so.
  app.post<{ Body: { sessionId: string; transactionId: string; status: string; amount: string; currency: string } }>('/api/owner/closing/donation', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['sessionId', 'transactionId', 'status', 'amount', 'currency'], properties: {
      sessionId: { type: 'string', format: 'uuid' },
      transactionId: { type: 'string', pattern: '^[A-Za-z0-9]{6,40}$' },
      status: { type: 'string', maxLength: 40 },
      amount: { type: 'string', maxLength: 20 },
      currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
    } } },
  }, async (request, reply) => {
    const input = request.body;
    const amountPence = parseDonationAmount(input.amount);
    if (input.status.toLowerCase() !== 'completed' || amountPence === null) {
      return reply.code(422).send({ error: 'The donation was not recorded. Your report is unchanged.' });
    }
    const session = (await db.query<{ id: string }>("select id from trading_sessions where id=$1 and stall_id=$2 and status <> 'open' and charity_name is not null", [input.sessionId, request.stallId])).rows[0];
    if (!session) return reply.code(409).send({ error: 'There is no pledge to donate against. Your report is unchanged.' });
    if (!donations.allow(request.stallId)) return reply.code(429).send({ error: 'Too many donations have been recorded this hour. Try again later. Your report is unchanged.' });
    const recorded = await db.query(`insert into charity_donations (paypal_transaction_id,trading_session_id,amount_pence,currency,recorded_at)
      values ($1,$2,$3,$4,$5) on conflict (paypal_transaction_id) do nothing returning paypal_transaction_id`, [input.transactionId, session.id, amountPence, input.currency.toUpperCase(), now()]);
    // A repeated callback records nothing, so it spends nothing.
    if (!recorded.rowCount) donations.giveBack(request.stallId);
    notify(request.stallId);
    return { donations: await donationsFor(db, session.id) };
  });
}
