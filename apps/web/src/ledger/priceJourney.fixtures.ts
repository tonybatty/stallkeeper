export const priceJourneyFieldIds = [
  'journeys.id',
  'journeys.itemId',
  'journeys.item',
  'journeys.code',
  'journeys.sessionId',
  'journeys.at',
  'journeys.stage',
  'journeys.amount',
  'journeys.previousAmount',
  'journeys.outcome',
  'journeys.note',
  'journeys.source',
] as const;

export type PriceJourneyStage = 'Listed' | 'Price dropped' | 'Offer' | 'Offer shown' | 'Agreed' | 'Paid' | 'Refunded';

export interface PriceJourneyRow {
  id: string;
  itemId: string;
  item: string;
  code: string;
  sessionId: string;
  at: string;
  stage: PriceJourneyStage;
  amount: number | null;
  previousAmount: number | null;
  outcome: string | null;
  note: string | null;
  source: string;
}

const row = (id: string, at: string, stage: PriceJourneyStage, amount: number | null, extra: Partial<PriceJourneyRow> = {}): PriceJourneyRow => ({
  id,
  itemId: 'item-lamp',
  item: 'Brass desk lamp',
  code: 'K7Q2',
  sessionId: 'session-1',
  at,
  stage,
  amount,
  previousAmount: null,
  outcome: null,
  note: null,
  source: 'record',
  ...extra,
});

export const priceJourneyFixture: PriceJourneyRow[] = [
  row('listed', '2026-11-08T09:00:00.000Z', 'Listed', 28),
  row('drop', '2026-11-08T10:15:00.000Z', 'Price dropped', 26, { previousAmount: 28, note: 'Still unsold late in the day.' }),
  row('offer-1', '2026-11-08T10:21:00.000Z', 'Offer', 18, { outcome: 'Countered' }),
  row('card-1', '2026-11-08T10:21:10.000Z', 'Offer shown', 24),
  row('offer-2', '2026-11-08T10:24:00.000Z', 'Offer', 21, { outcome: 'Countered' }),
  row('card-2', '2026-11-08T10:24:10.000Z', 'Offer shown', 22),
  row('agreed', '2026-11-08T10:25:00.000Z', 'Agreed', 22),
  row('paid', '2026-11-08T10:29:00.000Z', 'Paid', 22),
  row('refunded', '2026-11-08T11:02:00.000Z', 'Refunded', 22),
];
