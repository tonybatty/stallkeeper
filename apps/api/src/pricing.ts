import type { PoolClient } from 'pg';

interface PriceItem {
  // A pay-what-you-want or free item may have no figure, and no price is ever read from it for one. The items_asking_pence_required check keeps it set for fixed and haggle items.
  status: string; asking_pence: number; floor_pence: number | null;
  reserved_checkout_id?: string | null; mode?: string; minimum_pence?: number | null;
}
// The schema allows far more, but a pay-what-you-want amount that large is a typo or a probe, and PayPal would take it.
// Items on this stall sell for tens of pounds, so £500 leaves room without letting a slip charge a buyer thousands.
export const PAY_WHAT_YOU_WANT_MAX_PENCE = 50_000;
export const pounds = (pence: number) => `£${(pence / 100).toFixed(2).replace(/\.00$/, '')}`;
// The amount rule of pay what you want, which a tip on a free item shares. Any penny will do unless the owner set a minimum.
export function validateAmount(amountPence: number, minimumPence?: number | null): 'ok' | 'too_low' | 'above_maximum' {
  if (!Number.isSafeInteger(amountPence) || amountPence < (minimumPence ?? 1)) return 'too_low';
  return amountPence > PAY_WHAT_YOU_WANT_MAX_PENCE ? 'above_maximum' : 'ok';
}
export function validateOffer(item: PriceItem, amountPence: number): 'ok' | 'too_low' | 'above_asking' | 'above_maximum' | 'unavailable' {
  if (item.status !== 'available' || item.reserved_checkout_id) return 'unavailable';
  // The figure is only the owner's own expected amount here, and may be missing.
  if (item.mode === 'pwyw') return validateAmount(amountPence, item.minimum_pence);
  // A fixed item's floor only bounds the price review. A buyer still pays the asking price.
  const lowest = item.mode === 'fixed' ? item.asking_pence : item.floor_pence ?? item.asking_pence;
  if (!Number.isSafeInteger(amountPence) || amountPence < lowest) return 'too_low';
  if (amountPence > item.asking_pence) return 'above_asking';
  return 'ok';
}

export async function pricingItem(tx: PoolClient, id: string) {
  return (await tx.query<PriceItem & { id: string; name: string; code: string; mode: string; price_version: number; price_drops: boolean }>(
    'select i.id,i.name,i.code,i.mode,i.status,i.asking_pence,i.price_version,i.price_drops,i.reserved_checkout_id,i.minimum_pence,f.floor_pence from items i left join item_floors f on f.item_id=i.id where i.id=$1 for update of i', [id])).rows[0];
}

// The counter-offer for a round: a share of the gap between asking price and floor, rounded up to the next 50p.
// Rounds past the third reuse the last rung.
function counterRung(askingPence: number, floorPence: number, round: number) {
  const share = [40, 60, 80][Math.min(Math.max(round, 1), 3) - 1]!;
  return Math.min(askingPence, Math.ceil((askingPence * 100 - (askingPence - floorPence) * share) / 5000) * 50);
}

// The distinct counter-offers a haggle item can issue, highest first. The owner's form previews these before saving.
export const counterLadder = (askingPence: number, floorPence: number) =>
  [...new Set([1, 2, 3].map(round => counterRung(askingPence, floorPence, round)))];

export const PRICE_DROP_MAX_PERCENT = 20;
// The price a review may publish for a proposal, or null to leave the item alone. See ADR 0009. A proposal past a limit
// is refused rather than moved to it: a price moved to the floor's limit would publish a figure worked out from the floor.
export function droppedPrice(item: Pick<PriceItem, 'asking_pence' | 'floor_pence'>, proposedPence: number) {
  const { asking_pence: asking, floor_pence: floor } = item;
  if (floor === null || !Number.isSafeInteger(proposedPence)) return null;
  const price = Math.ceil(proposedPence / 50) * 50;
  const smallest = asking * (100 - PRICE_DROP_MAX_PERCENT) / 100;
  // Three quarters of the gap at most, so the asking price never lands on the floor and bargaining keeps some room.
  const room = floor + (asking - floor) / 4;
  return price < asking && price >= smallest && price >= room ? price : null;
}

export function respondToOffer(item: PriceItem, amountPence: number, round: number) {
  const verdict = validateOffer(item, amountPence);
  if (verdict === 'unavailable' || verdict === 'above_asking') return { outcome: verdict, amountPence: null } as const;
  const floor = item.floor_pence ?? item.asking_pence;
  const rung = counterRung(item.asking_pence, floor, round);
  const accepted = verdict === 'ok' && amountPence >= (round > 3 ? floor : rung);
  const total = accepted ? amountPence : rung;
  if (validateOffer(item, total) !== 'ok') return { outcome: 'unavailable', amountPence: null } as const;
  return { outcome: accepted ? 'accept' : 'counter', amountPence: total } as const;
}
