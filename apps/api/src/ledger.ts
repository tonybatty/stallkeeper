import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { LanguageModel } from 'ai';
import type { Pool, PoolClient } from 'pg';
import { spentToday } from './ai-usage.js';
import { demoPledge, pledgePence } from './charity.js';
import { transaction } from './checkouts.js';
import { ledgerAiRoute, withinAllowance } from './ledger-ai.js';
import { currentWording, readFor, runLedgerCheck, storedReads, type OrderCheck, type Toolkit } from './paypal-check.js';

const pounds = (pence: number) => pence / 100;
// A pay-what-you-want or free item may carry no expected figure, and the ledger leaves that cell empty rather than showing £0.
const optionalPounds = (pence: number | null) => pence === null ? null : pounds(pence);
const zone = 'Europe/London';
const sessionLabel = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// The owner pages' own time format, such as 7 Nov, 19:13.
const checkDate = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' });
const hour = (time: Date) => `${hourOf.format(time)}:00`;
const modes: Record<string, string> = { fixed: 'Fixed', haggle: 'Haggle', pwyw: 'Pay what you want', free: 'Free' };
const outcomes: Record<string, string> = { accept: 'Accepted', counter: 'Countered', above_asking: 'Above asking' };
const cardStates: Record<string, string> = { open: 'Open', agreed: 'Agreed', superseded: 'Replaced', expired: 'Expired' };
const checkLabels: Record<OrderCheck['outcome'], string> = { agrees: 'PayPal agrees', differs: 'PayPal differs', capture_not_recorded: 'PayPal differs', no_capture: 'No capture at PayPal', capture_pending: 'Capture pending', unreadable: 'PayPal not read' };
// Rows need a stable id for live updates, and an id in a source is one the agents can read, so a PayPal id goes in hashed.
const rowId = (kind: string, paypalId: string) => `${kind}:${createHash('sha256').update(paypalId).digest('hex').slice(0, 16)}`;

// One word for a row, worst first, so a filter on it finds what needs the owner's eye. An order read that agrees is PayPal
// confirming the capture itself, so it settles a row whose webhook has not arrived, and the check's stamp and counts agree
// with the result of the read. The Webhook column still says the webhook is outstanding.
function rowStatus(row: { review: boolean; verified: boolean; check: string }) {
  if (row.review) return 'Needs review';
  if (row.check === 'PayPal differs' || row.check === 'PayPal agrees') return row.check;
  return row.verified ? 'Confirmed by PayPal' : 'Waiting for PayPal to confirm';
}

// What the ledger may show. Nothing here reads item_floors, item notes, chat, offers' buyer ids, webhook bodies or
// payer details: Studio's agents can read any value in a source, so what the model must not see stays out of the DTO.
async function ledgerData(tx: PoolClient, stallId: string, now: Date) {
  const stall = (await tx.query<{ name: string; is_demo: boolean }>('select name,is_demo from stalls where id=$1', [stallId])).rows[0]!;
  const { orders, checks, latest: checkedAt } = await storedReads(tx, stallId);
  const checkLabel = (orderId: string | null, captured: boolean) => {
    const outcome = readFor(orders, orderId, captured);
    return outcome ? checkLabels[outcome] : 'Not checked yet';
  };

  const captures = (await tx.query<{
    id: string; session_id: string; order_id: string | null; review: boolean; card: string | null; checkout_kind: string; amount: number; at: Date; verified: Date | null;
    item_id: string; name: string; code: string; asking: number | null; mode: string; seeded: boolean; refunded: boolean; refunded_in_full: boolean;
  }>(`select cap.paypal_capture_id as id,c.trading_session_id as session_id,c.paypal_order_id as order_id,c.review_required as review,c.offer_card_id as card,c.kind as checkout_kind,
      cap.amount_pence as amount,coalesce(cap.captured_at,cap.observed_at) as at,cap.webhook_verified_at as verified,
      l.item_id,l.name,l.code,l.asking_pence as asking,i.mode,i.seeded,
      exists(select 1 from refunds r where r.paypal_capture_id=cap.paypal_capture_id and r.status='COMPLETED') as refunded,
      coalesce((select sum(r.amount_pence) from refunds r where r.paypal_capture_id=cap.paypal_capture_id and r.status='COMPLETED'),0) >= cap.amount_pence as refunded_in_full
    from captures cap join checkouts c on c.id=cap.checkout_id
    join lateral (select * from checkout_lines where checkout_id=c.id order by code limit 1) l on true
    join items i on i.id=l.item_id
    where c.stall_id=$1 and cap.status='COMPLETED' order by at,cap.paypal_capture_id`, [stallId])).rows;
  const refunds = (await tx.query<{ id: string; capture_id: string; amount: number; at: Date }>(`select r.paypal_refund_id as id,r.paypal_capture_id as capture_id,r.amount_pence as amount,r.observed_at as at
    from refunds r join captures cap on cap.paypal_capture_id=r.paypal_capture_id join checkouts c on c.id=cap.checkout_id
    where c.stall_id=$1 and r.status='COMPLETED' and cap.status='COMPLETED' order by r.observed_at,r.paypal_refund_id`, [stallId])).rows;
  // A payment with no completed capture is not a sale, so it carries no recorded sales. While it is flagged or PayPal is
  // still settling it, it belongs on the page, as the closing report counts it as unresolved.
  const unconfirmed = (await tx.query<{ id: string; session_id: string; order_id: string | null; review: boolean; total: number; at: Date; item_id: string; name: string; code: string; asking: number | null; mode: string; seeded: boolean }>(`
    select c.id,c.trading_session_id as session_id,c.paypal_order_id as order_id,c.review_required as review,c.total_pence as total,c.created_at as at,l.item_id,l.name,l.code,l.asking_pence as asking,i.mode,i.seeded
    from checkouts c join lateral (select * from checkout_lines where checkout_id=c.id order by code limit 1) l on true join items i on i.id=l.item_id
    where c.stall_id=$1 and (c.review_required or c.state in ('capturing','checking')) and not exists(select 1 from captures cap where cap.checkout_id=c.id and cap.status='COMPLETED') order by c.created_at,c.id`, [stallId])).rows;
  const donations = (await tx.query<{ id: string; session_id: string; amount: number; at: Date; charity: string | null }>(`select d.paypal_transaction_id as id,d.trading_session_id as session_id,d.amount_pence as amount,d.recorded_at as at,t.charity_name as charity
    from charity_donations d join trading_sessions t on t.id=d.trading_session_id where t.stall_id=$1 order by d.recorded_at,d.paypal_transaction_id`, [stallId])).rows;

  const byCapture = new Map(captures.map(row => [row.id, row]));
  const common = (at: Date) => ({ at: at.toISOString(), hour: hour(at) });
  const ledger = [
    ...captures.map(row => {
      const check = checkLabel(row.order_id, true);
      const review = row.review && !row.refunded;
      // A tip is recorded sales, as in the closing report, but it sells nothing: its item was already taken for free.
      const tip = row.checkout_kind === 'tip';
      const buyerChose = tip || row.mode === 'pwyw';
      return { id: rowId('sale', row.id), kind: tip ? 'Tip' : 'Sale', sessionId: row.session_id, itemId: row.item_id, ...common(row.at), item: row.name, code: row.code, mode: modes[row.mode] ?? row.mode,
        priceSource: row.card ? 'Agreed offer' : buyerChose ? "Buyer's amount" : 'Listed price', asking: optionalPounds(row.asking), amount: pounds(row.amount), recordedSales: pounds(row.amount),
        // An amount below the owner's expected figure is the buyer's choice, not a discount the owner gave.
        discount: buyerChose || row.asking === null ? 0 : pounds(Math.max(0, row.asking - row.amount)), capture: 'Capture recorded', webhook: row.verified ? 'Confirmed by PayPal' : 'Waiting for PayPal to confirm', paypalCheck: check,
        status: rowStatus({ review, verified: !!row.verified, check }), seeded: row.seeded, refundedInFull: row.refunded_in_full };
    }),
    ...refunds.map(row => {
      const sale = byCapture.get(row.capture_id)!;
      return { id: rowId('refund', row.id), kind: 'Refund', sessionId: sale.session_id, itemId: sale.item_id, ...common(row.at), hour: hour(sale.at), item: sale.name, code: sale.code, mode: modes[sale.mode] ?? sale.mode,
        priceSource: '', asking: optionalPounds(sale.asking), amount: -pounds(row.amount), recordedSales: -pounds(row.amount), discount: 0, capture: 'Refund recorded', webhook: '', paypalCheck: checkLabel(sale.order_id, true),
        status: 'Refund recorded', seeded: sale.seeded, refundedInFull: false };
    }),
    ...unconfirmed.map(row => {
      const check = checkLabel(row.order_id, false);
      return { id: `review:${row.id}`, kind: 'Payment to check', sessionId: row.session_id, itemId: row.item_id, ...common(row.at), item: row.name, code: row.code, mode: modes[row.mode] ?? row.mode,
        priceSource: '', asking: optionalPounds(row.asking), amount: pounds(row.total), recordedSales: 0, discount: 0, capture: 'No completed capture', webhook: '', paypalCheck: check,
        status: row.review ? 'Needs review' : check === 'PayPal differs' ? check : 'Capture pending', seeded: row.seeded, refundedInFull: false };
    }),
    // Recorded through the owner's browser, so the status says what the button reported and claims nothing more.
    ...donations.map(row => ({ id: rowId('donation', row.id), kind: 'Donation', sessionId: row.session_id, itemId: null, ...common(row.at), item: row.charity ?? 'Charity donation', code: '', mode: '',
      priceSource: '', asking: 0, amount: pounds(row.amount), recordedSales: 0, discount: 0, capture: '', webhook: '', paypalCheck: '', status: 'Reported by Donate button', seeded: false, refundedInFull: false })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const sessionRows = (await tx.query<{ id: string; opened_at: Date; closed_at: Date | null; status: string; charity_name: string | null; charity_percent: number | null }>(`
    select id,opened_at,coalesce(closed_at,cutoff_at) as closed_at,status,charity_name,charity_percent from trading_sessions where stall_id=$1 order by opened_at,id`, [stallId])).rows;

  const offers = (await tx.query<{
    id: string; item_id: string; at: Date; round: number; offered: number; outcome: string; name: string; code: string; asking: number | null; seeded: boolean;
    session_id: string | null; card: number | null; card_status: string | null; agreed: boolean; paid: boolean;
  }>(`select o.id,o.item_id,o.created_at as at,o.round,o.amount_pence as offered,o.outcome,i.name,i.code,i.asking_pence as asking,i.seeded,t.id as session_id,
      card.amount_pence as card,card.status as card_status,coalesce(card.agreed_at is not null,false) as agreed,
      exists(select 1 from checkouts co join captures cap on cap.checkout_id=co.id where co.offer_card_id=card.id and cap.status='COMPLETED') as paid
    from offers o join items i on i.id=o.item_id left join offer_cards card on card.offer_id=o.id
    left join lateral (select id from trading_sessions where stall_id=$1 and opened_at<=o.created_at order by opened_at desc limit 1) t on true
    where i.stall_id=$1 order by o.created_at,o.id`, [stallId])).rows
    .map(row => ({ id: row.id, sessionId: row.session_id, itemId: row.item_id, at: row.at.toISOString(), item: row.name, code: row.code, round: row.round, asking: optionalPounds(row.asking), offered: pounds(row.offered),
      outcome: outcomes[row.outcome] ?? row.outcome, card: row.card === null ? null : pounds(row.card), cardStatus: row.card_status ? cardStates[row.card_status] ?? row.card_status : 'No offer shown',
      agreed: row.agreed, becameSale: row.paid, seeded: row.seeded }));

  const items = (await tx.query<{ id: string; name: string; code: string; mode: string; asking: number | null; minimum: number | null; status: string; seeded: boolean; reference: string | null }>(`
    select id,name,code,mode,asking_pence as asking,minimum_pence as minimum,status,seeded,retail_ref->>'pricePence' as reference from items where stall_id=$1 order by created_at,id`, [stallId])).rows
    .map(row => ({ id: row.id, name: row.name, code: row.code, mode: modes[row.mode] ?? row.mode, asking: optionalPounds(row.asking), minimum: optionalPounds(row.minimum),
      status: row.status[0]!.toUpperCase() + row.status.slice(1), reference: row.reference === null ? null : pounds(Number(row.reference)), seeded: row.seeded }));

  // Only the closing page's check lists transactions, so this line comes from the latest one and says so. It carries that check's own
  // time, and the note gives its date, because the line can be days older than checkedAt, which counts the ledger's order reads too.
  const latest = checks.at(-1) && currentWording(checks.at(-1)!);
  const from = latest && `the closing check on ${checkDate.format(new Date(latest.checkedAt))}`;
  const transactionList = !latest ? { ran: false, checkedAt: null, note: "PayPal's transaction list has not been read. The closing page's check reads it." }
    : latest.transactions.status === 'ran' ? { ran: true, checkedAt: latest.checkedAt, note: `PayPal's transaction list was read in ${from}. ${latest.transactions.note}` }
      : { ran: false, checkedAt: latest.checkedAt, note: `In ${from}, ${latest.transactions.note.replace(/ just now\.$/, ' at the time.')}` };
  // A reset closes its session empty, and the stall then collects dozens of them. The report lists a session only if it has something to report.
  const traded = new Set([...ledger.map(row => row.sessionId), ...offers.map(row => row.sessionId)]);
  // Every session filter and chart groups on the label, which is exact to the minute, so a repeat gets a number or two sessions would read as one.
  const labelUses = new Map<string, number>();
  const sessions = sessionRows.filter(row => traded.has(row.id)).map(row => {
    const minute = sessionLabel.format(row.opened_at);
    const use = (labelUses.get(minute) ?? 0) + 1;
    labelUses.set(minute, use);
    const rows = ledger.filter(entry => entry.sessionId === row.id);
    // Added up in pence, so the figure is the closing report's and floating point never moves it by a penny.
    const recordedPence = rows.reduce((sum, entry) => sum + Math.round(entry.recordedSales * 100), 0);
    const donatedPence = rows.filter(entry => entry.kind === 'Donation').reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0);
    return { id: row.id, label: use > 1 ? `${minute} (${use})` : minute, openedAt: row.opened_at.toISOString(), closedAt: row.closed_at?.toISOString() ?? null, status: row.status,
      charity: row.charity_name, charityPercent: row.charity_percent, seededPledge: stall.is_demo && row.charity_name === demoPledge.name && row.charity_percent === demoPledge.percent,
      recordedSales: pounds(recordedPence), sales: rows.filter(entry => entry.kind === 'Sale' && !entry.refundedInFull).length,
      pledged: row.charity_percent ? pounds(pledgePence(recordedPence, row.charity_percent)) : 0, donated: pounds(donatedPence) };
  });

  return { generatedAt: now.toISOString(), stall: { name: stall.name, demo: stall.is_demo },
    paypalCheck: { checkedAt, transactionList },
    sessions: sessions.reverse(), ledger, offers, items };
}

export async function ledgerRoutes(app: FastifyInstance, db: Pool, now: () => Date, config: { model?: LanguageModel; dailyCap: number; ledgerCap: number; licenceKey?: string; toolkit: () => Toolkit }) {
  app.get('/api/owner/ledger/data', async request => transaction(db, async tx => {
    await tx.query('set transaction isolation level repeatable read read only');
    // The ai_usage table is one row per day for the whole service, not per stall.
    return { ...await ledgerData(tx, request.stallId, now()), aiSpend: { spentUsd: await spentToday(tx, now().toISOString().slice(0, 10)), capUsd: config.dailyCap } };
  }));
  // Studio takes its key in the browser, so any owner session can read it, and the demo owner's password is on /demo.
  // It is a low-value trial key, sent to the demo owner too so judges do not see the trial watermark.
  app.get('/api/owner/ledger/config', async () => ({
    licenceKey: config.licenceKey || null, aiEnabled: !!config.model && await withinAllowance(db, now().toISOString().slice(0, 10), config),
  }));
  // Reads every captured order that has no PayPal read yet, from any session. It changes nothing at PayPal or in the records.
  app.post('/api/owner/ledger/paypal-check', async (request, reply) => {
    try {
      return { paypalCheck: await runLedgerCheck(db, config.toolkit, { stallId: request.stallId, now: now() }) };
    } catch (error) {
      request.log.warn({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Ledger PayPal check unavailable');
      return reply.code(502).send({ error: 'The PayPal check could not run just now. The ledger is unaffected.' });
    }
  });
  await ledgerAiRoute(app, db, now, config);
}
