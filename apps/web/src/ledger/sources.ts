import type { AgDataSourcesDefinition, AgExpressionFieldDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from 'ag-studio';
import type { PriceJourneyRow } from './priceJourney.fixtures.js';

export interface LedgerRow {
  id: string; kind: string; sessionId: string; itemId: string | null; at: string; hour: string; item: string; code: string; mode: string; priceSource: string;
  asking: number | null; amount: number; recordedSales: number; discount: number; capture: string; webhook: string; paypalCheck: string; status: string; seeded: boolean; refundedInFull?: boolean;
}
interface SessionRow { id: string; label: string; openedAt: string; closedAt: string | null; status: string; charity: string | null; charityPercent: number | null; seededPledge: boolean; recordedSales: number; sales: number; pledged: number; donated: number }
export interface OfferRow { id: string; sessionId: string | null; itemId: string; at: string; item: string; code: string; round: number; asking: number | null; offered: number; outcome: string; card: number | null; cardStatus: string; agreed: boolean; becameSale: boolean; seeded: boolean }
interface ItemRow { id: string; name: string; code: string; mode: string; asking: number | null; minimum: number | null; status: string; reference: number | null; seeded: boolean }
export interface LedgerData {
  generatedAt: string; stall: { name: string; demo: boolean };
  // checkedAt is the latest PayPal read of any kind. The transaction list line has its own, from the closing check it came from.
  paypalCheck: { checkedAt: string | null; transactionList: { ran: boolean; checkedAt: string | null; note: string } };
  sessions: SessionRow[]; ledger: LedgerRow[]; offers: OfferRow[]; items: ItemRow[]; journeys?: PriceJourneyRow[];
  aiSpend?: { spentUsd: number; capUsd: number };
}

type FieldSpec = [id: string, name: string, format: AgFormat, hide?: boolean, context?: Record<string, string>];
const formatOptions: Partial<Record<string, { format: string }>> = { currencyFormat: { format: '£#,##0.00;-£#,##0.00' }, dateTimeFormat: { format: 'dd mmm, hh:mm' } };
const fields = (specs: FieldSpec[]): AgFieldDefinition[] => specs.map(([id, name, format, hide, context]) => ({ id, name, format, formatOptions: formatOptions[String(format)], ...(hide && { hide }), ...(context && { context }) }));
const manyToOne = (source: string, target: string): AgRelationDefinition => {
  const [sourceTable, sourceField] = source.split('.') as [string, string];
  const [targetTable, targetField] = target.split('.') as [string, string];
  return { id: `${sourceTable}-${targetTable}`, type: 'many-to-one', source: { tableId: sourceTable, fieldId: sourceField }, target: { tableId: targetTable, fieldId: targetField } };
};
const onCalendar = (tableId: string): AgRelationDefinition => ({ id: `${tableId}-calendar`, source: { tableId, fieldId: 'at' }, target: { calendarId: 'calendar' }, truncate: 'day' });
const ratio = (id: string, name: string, description: string, top: string, bottom: string): AgExpressionFieldDefinition => ({
  id, name, description, format: 'percentageFormat', isMeasure: true,
  expression: { operator: 'divide', inputs: [{ id: top, aggregation: 'sum' }, { id: bottom, aggregation: 'sum' }] },
});

// The funnel needs one row per stage an offer reached, which only this page wants, so it is built here from the offers.
export function offerStages(offers: OfferRow[]) {
  return offers.flatMap(offer => [
    ['Offers', true], ['Offer shown', offer.card !== null], ['Agreed', offer.agreed], ['Paid', offer.becameSale],
  ].filter(([, reached]) => reached).map(([stage]) => ({ id: `${offer.id}:${stage as string}`, sessionId: offer.sessionId, itemId: offer.itemId, at: offer.at, stage: stage as string, count: 1 })));
}

const saleMark = (becameSale: boolean) => becameSale ? 'Yes' : '';

export const needsPaypal = (row: LedgerRow) => ['Needs review', 'Waiting for PayPal to confirm', 'PayPal differs', 'Capture pending'].includes(row.status);

export function ledgerRows(rows: LedgerRow[]) {
  return rows.map(row => ({ ...row, sold: row.kind === 'Sale' || row.kind === 'Tip' ? row.amount : 0, refunded: row.kind === 'Refund' ? -row.amount : 0, itemsSold: row.kind === 'Sale' && !row.refundedInFull ? 1 : 0 }));
}

// The rows of each Studio table, so a refetch can be compared with what the page already holds.
export function studioRows(data: LedgerData) {
  return { sessions: data.sessions, ledger: ledgerRows(data.ledger), offers: data.offers.map(offer => ({ ...offer, becameSale: saleMark(offer.becameSale), paid: offer.becameSale ? 1 : 0, made: 1 })), stages: offerStages(data.offers), items: data.items, journeys: data.journeys ?? [], paymentSummary: [{ id: 'stall', unresolved: data.ledger.filter(needsPaypal).length }] };
}

// Only what changed goes to the data engine, so a grid keeps its scroll and selection while a sale arrives.
export function tableChanges(before: LedgerData, after: LedgerData) {
  const old = studioRows(before);
  return Object.entries(studioRows(after)).flatMap(([tableId, table]) => {
    const rows = table as unknown as (Record<string, string | number | boolean | null> & { id: string })[];
    const was = new Map<string, unknown>((old[tableId as keyof typeof old] as { id: string }[]).map(row => [row.id, row]));
    const now = new Set(rows.map(row => row.id));
    const added = rows.filter(row => !was.has(row.id));
    // Sessions list newest first and an add lands at the end, so a session joining the list resends the table in order.
    const rebuild = tableId === 'sessions' && added.length > 0;
    const add = rebuild ? rows : added;
    const update = rebuild ? [] : rows.filter(row => was.has(row.id) && JSON.stringify(was.get(row.id)) !== JSON.stringify(row));
    const remove = rebuild ? [...was.keys()] : [...was.keys()].filter(id => !now.has(id));
    return add.length || update.length || remove.length ? [{ tableId, add, update, remove }] : [];
  });
}

// Money arrives as numbers in pounds. Studio reads a numeric string as text, and then neither sums nor charts it.
export function toStudioData(data: LedgerData): AgDataSourcesDefinition {
  const dates = [...data.ledger, ...data.offers, ...(data.journeys ?? [])].map(row => row.at.slice(0, 10)).sort();
  const today = data.generatedAt.slice(0, 10);
  const rows = studioRows(data);
  const live = { transactions: 'all' as const, primaryKeyField: 'id' };
  return {
    description: `Records of one small stall, ${data.stall.name}. Money is in pounds. Payments are through PayPal. Recorded sales are ledger.recordedSales, which already takes refunds off and leaves donations out, so never sum ledger.amount for sales. The closing report stays the record.`,
    sources: [
      { id: 'paymentSummary', name: 'Payment summary', description: 'One row across all sessions, even when the ledger is empty. For a Waiting on PayPal count card, use paymentSummary.unresolved with sum and no status filter. It counts Needs review, Capture pending, Waiting for PayPal to confirm and PayPal differs. Zero means none are unresolved. This stall-wide total does not follow session, date or item filters.',
        data: rows.paymentSummary, ...live, fields: fields([
          ['id', 'Summary ID', 'textFormat', true], ['unresolved', 'Unresolved payments, all sessions', 'integerFormat'],
        ]) },
      { id: 'sessions', name: 'Sessions', description: 'One row per trading session, with the same recorded sales as its closing report.', data: rows.sessions, ...live, fields: fields([
        ['id', 'Session ID', 'textFormat', true], ['label', 'Session', 'textFormat'], ['openedAt', 'Opened', 'dateTimeFormat'], ['closedAt', 'Closed', 'dateTimeFormat'], ['status', 'Session status', 'textFormat'],
        ['charity', 'Charity', 'textFormat'], ['charityPercent', 'Pledged percent', 'integerFormat'], ['recordedSales', 'Session recorded sales', 'currencyFormat'],
        ['sales', 'Sales count', 'integerFormat'], ['pledged', 'Pledged', 'currencyFormat'], ['donated', 'Donated', 'currencyFormat'],
      ]) },
      { id: 'ledger', name: 'Ledger', description: 'One row per money movement. kind is Sale, Tip, Refund, Donation or Payment to check. A Tip is money for an item taken for free: it counts in recordedSales but is not an item sold. Refunds are negative. Only recordedSales counts towards sales. status gives the state of a payment, and any row whose status is Needs review, Capture pending or Waiting for PayPal to confirm still needs PayPal.',
        data: rows.ledger, ...live, fields: fields([
          ['id', 'Row ID', 'textFormat', true], ['kind', 'Kind', 'textFormat'], ['sessionId', 'Session ID', 'textFormat', true], ['itemId', 'Item ID', 'textFormat', true], ['at', 'When', 'dateTimeFormat'], ['hour', 'Hour', 'textFormat'],
          ['item', 'Item', 'textFormat', false, { itemId: 'ledger.itemId', amount: 'ledger.amount', kind: 'ledger.kind' }], ['code', 'Tag', 'textFormat'], ['mode', 'Mode', 'textFormat'], ['priceSource', 'Price source', 'textFormat'], ['asking', 'Asking', 'currencyFormat'], ['amount', 'Amount', 'currencyFormat'],
          ['recordedSales', 'Recorded sales', 'currencyFormat'], ['discount', 'Discount given', 'currencyFormat'], ['capture', 'Capture', 'textFormat'], ['webhook', 'Webhook', 'textFormat'], ['paypalCheck', 'PayPal order read', 'textFormat'],
          ['status', 'PayPal status', 'textFormat'],
          ['sold', 'Sold before refunds', 'currencyFormat'], ['refunded', 'Refunded', 'currencyFormat'], ['itemsSold', 'Items sold', 'integerFormat'],
        ]) },
      { id: 'offers', name: 'Offers', description: 'One row per offer a buyer made. outcome is Accepted, Countered or Above asking. card is the price on the card the buyer was shown. asking is the current asking price of the item, not the price when the offer was made, so a later price change can put it below an old card.', data: rows.offers, ...live, fields: fields([
        ['id', 'Offer ID', 'textFormat', true], ['sessionId', 'Session ID', 'textFormat', true], ['itemId', 'Item ID', 'textFormat', true], ['at', 'When', 'dateTimeFormat'], ['item', 'Item', 'textFormat', false, { itemId: 'offers.itemId' }], ['code', 'Tag', 'textFormat'],
        ['round', 'Round', 'integerFormat'], ['asking', 'Current asking price', 'currencyFormat'], ['offered', 'Offered', 'currencyFormat'], ['outcome', 'Outcome', 'textFormat'], ['card', 'Offer shown', 'currencyFormat'], ['cardStatus', 'Offer status', 'textFormat'],
        ['agreed', 'Agreed', 'booleanFormat'], ['becameSale', 'Became a sale', 'textFormat'], ['paid', 'Paid offers', 'integerFormat'], ['made', 'Offers made', 'integerFormat'],
      ]) },
      { id: 'stages', name: 'Offer stages', description: 'One row per stage an offer reached: Offers, Offer shown, Agreed, Paid.', data: rows.stages, ...live, fields: fields([
        ['id', 'Stage row', 'textFormat', true], ['sessionId', 'Session ID', 'textFormat', true], ['itemId', 'Item ID', 'textFormat', true], ['at', 'When', 'dateTimeFormat'], ['stage', 'Stage', 'textFormat'], ['count', 'Count', 'integerFormat'],
      ]) },
      { id: 'items', name: 'Items', description: 'One row per item ever listed. reference is the lowest new retail price the stallholder saved, if any.', data: rows.items, ...live, fields: fields([
        ['id', 'Item ID', 'textFormat', true], ['name', 'Item name', 'textFormat'], ['code', 'Item tag', 'textFormat'], ['mode', 'Item mode', 'textFormat'], ['asking', 'Item asking', 'currencyFormat'], ['minimum', 'Public minimum', 'currencyFormat'],
        ['status', 'Item status', 'textFormat'], ['reference', 'New retail reference', 'currencyFormat'],
      ]) },
      { id: 'journeys', name: 'Price journeys', description: 'One row per price event for an item, from listing and offers through payment and refunds.', data: rows.journeys, ...live, fields: fields([
        ['id', 'Journey event ID', 'textFormat', true], ['itemId', 'Item ID', 'textFormat', true], ['item', 'Item', 'textFormat'], ['code', 'Tag', 'textFormat'], ['sessionId', 'Session ID', 'textFormat', true],
        ['at', 'When', 'dateTimeFormat'], ['stage', 'Stage', 'textFormat'], ['amount', 'Amount', 'currencyFormat'], ['previousAmount', 'Previous amount', 'currencyFormat'], ['outcome', 'Outcome', 'textFormat'],
        ['note', 'Note', 'textFormat'], ['source', 'Source', 'textFormat', true],
      ]) },
    ],
    relationships: [
      manyToOne('ledger.sessionId', 'sessions.id'), manyToOne('offers.sessionId', 'sessions.id'), manyToOne('stages.sessionId', 'sessions.id'),
      manyToOne('journeys.sessionId', 'sessions.id'),
      { ...manyToOne('ledger.itemId', 'items.id'), id: 'ledger-item' }, { ...manyToOne('offers.itemId', 'items.id'), id: 'offers-item' }, { ...manyToOne('stages.itemId', 'items.id'), id: 'stages-item' }, { ...manyToOne('journeys.itemId', 'items.id'), id: 'journeys-item' },
      onCalendar('ledger'), onCalendar('offers'), onCalendar('journeys'),
    ],
    calendars: [{ id: 'calendar', label: 'Calendar', range: { from: { type: 'date', value: dates[0] ?? today }, to: { type: 'date', value: dates.at(-1) ?? today } }, fragments: ['year', 'month', 'week', 'day', 'dayOfWeek'] }],
    expressions: [
      ratio('refundRate', 'Refund rate', 'Money refunded as a share of money taken.', 'ledger.refunded', 'ledger.sold'),
      ratio('offerToSale', 'Offer to sale rate', 'Offers that became a paid sale.', 'offers.paid', 'offers.made'),
    ],
  };
}

// What each field, expression and table is called on the page, keyed as an agent names it (ledger.recordedSales, refundRate,
// sessions). Two tables can share a field id, so a name that drops the table would read "recorded sales and recorded sales".
const blank: LedgerData = { generatedAt: '1970-01-01T00:00:00.000Z', stall: { name: '', demo: false }, paypalCheck: { checkedAt: null, transactionList: { ran: false, checkedAt: null, note: '' } }, sessions: [], ledger: [], offers: [], items: [] };
const studio = toStudioData(blank);
export const displayNames = new Map<string, string>([
  ...studio.sources.flatMap(source => [[source.id, source.name ?? source.id] as const, ...('fields' in source ? source.fields ?? [] : []).map(field => [`${source.id}.${field.id}`, field.name ?? field.id] as const)]),
  ...(studio.expressions ?? []).map(expression => [expression.id, expression.name ?? expression.id] as const),
]);
