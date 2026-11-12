import { describe, expect, it } from 'vitest';
import { parseEvents, parseOrder, unchanged } from './hosted.ts';

describe('parseOrder', () => {
  it('takes the checkout from custom_id and each capture with its amount in pence', () => {
    expect(parseOrder({ id: 'O1', purchase_units: [{ custom_id: 'c-1', payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: 'GBP', value: '24.00' } }] } }] }))
      .toEqual({ orderId: 'O1', checkoutId: 'c-1', captures: [{ id: 'C1', status: 'COMPLETED', amountPence: 2400, currency: 'GBP' }] });
  });
  it('has no captures before payment', () => {
    expect(parseOrder({ id: 'O1', purchase_units: [{ custom_id: 'c-1' }] }).captures).toEqual([]);
  });
});

describe('parseEvents', () => {
  it('keeps the event type and the resource it names', () => {
    expect(parseEvents({ events: [{ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'C1' } }, { id: 'WH-2', event_type: 'X' }] }))
      .toEqual([{ id: 'WH-1', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: 'C1' }, { id: 'WH-2', type: 'X', resourceId: null }]);
  });
});

describe('unchanged', () => {
  const standing = { captureStatus: 'COMPLETED', captureAmount: '24.00', captureCurrency: 'GBP', captureCount: 1, recordedSalesPence: 2400, itemsSold: 1, saleRows: 1 };
  it('holds when a duplicate delivery changed nothing', () => { expect(unchanged(standing, { ...standing })).toBe(true); });
  it('fails when the duplicate added a capture, a sale row or sales', () => {
    expect(unchanged(standing, { ...standing, captureCount: 2 })).toBe(false);
    expect(unchanged(standing, { ...standing, saleRows: 2 })).toBe(false);
    expect(unchanged(standing, { ...standing, recordedSalesPence: 4800 })).toBe(false);
  });
});
