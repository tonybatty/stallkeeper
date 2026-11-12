import { describe, expect, it } from 'vitest';
import { checkTake, finishTake, nextTake, suffix, type Observations, type Take, type TakeStart } from './take-log.ts';

const sale = (): Observations => ({
  itemCode: 'K7Q2', askingPence: 2800, agreedPence: 2400, paidPagePence: 2400,
  approvalOrderId: '5O190127TN364715T',
  paypalHost: 'www.sandbox.paypal.com',
  checkout: { id: 'c-1', state: 'paid', totalPence: 2400, paypalOrderId: '5O190127TN364715T' },
  captures: [{ id: '3C679366HH908993F', checkoutId: 'c-1', amountPence: 2400, status: 'COMPLETED' }],
  webhookEvents: [{ id: 'WH-2WR32451HC0233532-67976317FL4543714', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: '3C679366HH908993F' }],
  feedSale: { code: 'K7Q2', amountPence: 2400, webhookVerified: true },
  tag: { decodedUrl: 'https://example.test/i/K7Q2', urlProblems: [], openedItemName: 'Brass desk lamp', itemName: 'Brass desk lamp' },
  totalsBefore: { recordedSalesPence: 2200, itemsSold: 1 }, totalsAfter: { recordedSalesPence: 4600, itemsSold: 2 },
  closing: { stagedCode: 'M4RT', status: 'final', recordedSalesPence: 4600, shownOnScreen: true, groups: [{ key: 'paidAbsent', codes: ['K7Q2'] }, { key: 'unpaidAbsent', codes: ['M4RT'] }, { key: 'unsoldPresent', codes: ['B2XA', 'C9PD'] }] },
  aiSpend: { beforeUsd: 0.01, afterUsd: 0.02 },
});
const start: TakeStart = { takeId: 'take-1', supersedes: null, mode: 'real', model: 'claude', environment: 'iOS Simulator', build: { commit: 'abc1234', web: 'index-1.js' }, host: 'example.test', startedAt: '2026-11-10T10:00:00Z', reach: 'closing' };
const finish = (o: Observations | null, reach: TakeStart['reach'] = 'closing', failure?: string) => finishTake({ ...start, reach }, o, [], [], [], '2026-11-10T10:05:00Z', failure);

describe('checkTake', () => {
  it('accepts one continuous sale', () => { expect(checkTake(sale(), 'sale')).toEqual([]); });

  it('rejects an approval that joins a capture on a different checkout', () => {
    const o = sale();
    o.captures = [{ id: '3C679366HH908993F', checkoutId: 'c-2', amountPence: 2400, status: 'COMPLETED' }];
    expect(checkTake(o, 'sale')).toContain('A capture belongs to a different checkout from this take.');
  });

  it('rejects an approval page whose order is not the checkout\'s order', () => {
    const o = sale();
    o.approvalOrderId = '9ZZ00000AA000000B';
    expect(checkTake(o, 'sale')).toContain('The approval page shows a different PayPal order from the checkout.');
  });

  it('rejects an amount that changes between the card, checkout, paid page and feed', () => {
    for (const change of [(o: Observations) => { o.agreedPence = 2200; }, (o: Observations) => { o.paidPagePence = 2800; }, (o: Observations) => { o.feedSale!.amountPence = 2200; }, (o: Observations) => { o.captures[0]!.amountPence = 2200; }]) {
      const o = sale();
      change(o);
      expect(checkTake(o, 'sale')).not.toEqual([]);
    }
  });

  it('requires the webhook to name this capture and the feed to show it verified', () => {
    const wrongEvent = sale();
    wrongEvent.webhookEvents[0]!.resourceId = '3C000000HH000000F';
    expect(checkTake(wrongEvent, 'sale')).toContain('No PAYMENT.CAPTURE.COMPLETED webhook names this capture.');
    const unmarked = sale();
    unmarked.feedSale!.webhookVerified = false;
    expect(checkTake(unmarked, 'sale')).toContain('The owner feed has no webhook verified mark.');
  });

  it('requires the totals to rise by exactly the sale', () => {
    const o = sale();
    o.totalsAfter = { recordedSalesPence: 4800, itemsSold: 2 };
    expect(checkTake(o, 'sale')).toContain('Recorded sales did not rise by the sale amount.');
    o.totalsAfter = { recordedSalesPence: 4600, itemsSold: 3 };
    expect(checkTake(o, 'sale')).toContain('Items sold did not rise by one.');
  });

  it('requires a decoded tag that opened the right item on a sale', () => {
    const wrongItem = sale();
    wrongItem.tag!.openedItemName = 'Wall clock';
    expect(checkTake(wrongItem, 'sale')).toContain('The tag URL did not open the item it was printed for.');
    const badUrl = sale();
    badUrl.tag!.urlProblems = ['The tag URL does not name this item\'s code.'];
    expect(checkTake(badUrl, 'sale')).toContain('The tag URL does not name this item\'s code.');
    const none = sale();
    none.tag = null;
    expect(checkTake(none, 'sale')).toContain('No tag was decoded for this take.');
    expect(checkTake(none, 'capture')).not.toContain('No tag was decoded for this take.');
  });

  it('rejects two captures for one checkout', () => {
    const o = sale();
    o.captures.push({ id: '3C111111HH111111F', checkoutId: 'c-1', amountPence: 2400, status: 'COMPLETED' });
    expect(checkTake(o, 'sale')).toContain('Expected one capture for the checkout, found 2.');
  });

  it('accepts a take that stops at the login page with a reserved checkout and no capture', () => {
    const o: Observations = { ...sale(), agreedPence: null, paidPagePence: null, captures: [], webhookEvents: [], feedSale: null, totalsAfter: null,
      checkout: { id: 'c-1', state: 'awaiting_approval', totalPence: 2800, paypalOrderId: '5O190127TN364715T' } };
    expect(checkTake(o, 'login')).toEqual([]);
    o.captures = [{ id: '3C679366HH908993F', checkoutId: 'c-1', amountPence: 2800, status: 'COMPLETED' }];
    expect(checkTake(o, 'login')).toContain('A capture exists although the take stopped at the login page.');
  });
});

describe('a take through closing', () => {
  it('accepts a closing report with the one staged difference shown on screen', () => { expect(checkTake(sale(), 'closing')).toEqual([]); });

  it('requires the report to be read', () => {
    const o = sale();
    o.closing = null;
    expect(checkTake(o, 'closing')).toEqual(['The closing report was not read.']);
  });

  it('requires exactly the staged item in the difference group', () => {
    const none = sale();
    none.closing!.groups = none.closing!.groups.filter(group => group.key !== 'unpaidAbsent');
    expect(checkTake(none, 'closing')).toContain('The closing report\'s difference is not the one staged item.');
    const extra = sale();
    extra.closing!.groups.find(group => group.key === 'unpaidAbsent')!.codes.push('B2XA');
    expect(checkTake(extra, 'closing')).toContain('The closing report\'s difference is not the one staged item.');
  });

  it('requires the sold item in the paid group and a final report with nothing unchecked or unresolved', () => {
    const o = sale();
    o.closing!.groups.find(group => group.key === 'paidAbsent')!.codes = [];
    o.closing!.groups.push({ key: 'unknown', codes: ['B2XA'] }, { key: 'unresolved', codes: ['C9PD'] });
    o.closing!.status = 'provisional';
    expect(checkTake(o, 'closing')).toEqual([
      'The closing report is still provisional.',
      'The sold item is not in the closing report\'s paid group.',
      'The closing report has items in "unknown".',
      'The closing report has items in "unresolved".',
    ]);
  });

  it('requires the report to agree with the feed and the screen to show the difference', () => {
    const o = sale();
    o.closing!.recordedSalesPence = 4400;
    o.closing!.shownOnScreen = false;
    expect(checkTake(o, 'closing')).toEqual(['The closing report\'s recorded sales differ from the owner feed\'s.', 'The owner\'s screen did not show the staged difference.']);
  });

  it('is complete only when it reached closing', () => {
    expect(finish(sale()).status).toBe('complete');
    expect(finish(sale(), 'sale').status).toBe('stopped');
    expect(finish(sale()).closing).toEqual({ stagedCode: 'M4RT', status: 'final', recordedSalesPence: 4600, differenceCodes: ['M4RT'], shownOnScreen: true });
  });

  it('rejects a capture that is not in pounds', () => {
    const o = sale();
    o.captures[0]!.currency = 'USD';
    expect(checkTake(o, 'closing')).toContain('The capture is in USD, not GBP.');
    o.captures[0]!.currency = 'GBP';
    expect(checkTake(o, 'closing')).toEqual([]);
  });
});

describe('a take through capture', () => {
  // A local run gets no webhook, so the feed and the webhook name nothing yet.
  const local = (): Observations => ({ ...sale(), webhookEvents: [], feedSale: null, totalsAfter: null });

  it('accepts a completed capture with no webhook or feed mark', () => { expect(checkTake(local(), 'capture')).toEqual([]); });

  it('still requires one completed capture at the checkout total, shown on the paid page', () => {
    const unpaid = local();
    unpaid.checkout!.state = 'cancelled';
    unpaid.captures = [];
    expect(checkTake(unpaid, 'capture')).toEqual(['The checkout is cancelled, not paid.', 'Expected one capture for the checkout, found 0.']);
    const pending = local();
    pending.captures[0]!.status = 'PENDING';
    expect(checkTake(pending, 'capture')).toContain('The capture is PENDING, not COMPLETED.');
    const differs = local();
    differs.paidPagePence = 2800;
    expect(checkTake(differs, 'capture')).toContain('The paid page amount differs from the checkout total.');
  });

  it('is stopped, never complete', () => {
    expect(finish(local(), 'capture').status).toBe('stopped');
  });
});

describe('finishTake', () => {
  it('keeps only suffixes', () => {
    const take = finish(sale());
    expect(take).toMatchObject({ status: 'complete', problems: [], orderSuffix: '364715T'.slice(-6), approvalOrderSuffix: '64715T', paypalHost: 'www.sandbox.paypal.com', captureSuffix: '908993F'.slice(-6), webhookEventSuffix: '543714'.slice(-6), checkoutSuffix: 'c-1' });
    const text = JSON.stringify(take);
    for (const full of ['5O190127TN364715T', '3C679366HH908993F', 'WH-2WR32451HC0233532-67976317FL4543714']) expect(text).not.toContain(full);
  });

  it('marks a take with any problem as failed, and a login stop as stopped', () => {
    const o = sale();
    o.feedSale = null;
    expect(finish(o).status).toBe('failed');
    expect(finish(null, 'login', 'Appium would not start').problems).toEqual(['Appium would not start']);
    const login: Observations = { ...sale(), agreedPence: null, paidPagePence: null, captures: [], webhookEvents: [], feedSale: null, totalsAfter: null, closing: null, checkout: { id: 'c-1', state: 'awaiting_approval', totalPence: 2800, paypalOrderId: '5O190127TN364715T' } };
    expect(finish(login, 'login').status).toBe('stopped');
  });
});

describe('reruns', () => {
  const take = (takeId: string, status: Take['status'], mode: Take['mode'] = 'real') => ({ ...finish(sale()), takeId, status, mode }) as Take;

  it('reruns a failed take under a new ID and names the one it replaces', () => {
    expect(nextTake([])).toEqual({ takeId: 'take-1', supersedes: null });
    expect(nextTake([take('take-1', 'failed')])).toEqual({ takeId: 'take-2', supersedes: 'take-1' });
    expect(nextTake([take('take-1', 'failed'), take('take-2', 'complete')])).toEqual({ takeId: 'take-3', supersedes: null });
  });
});

describe('suffix', () => {
  it('keeps the last six characters and passes null through', () => {
    expect(suffix('3C679366HH908993F')).toBe('08993F');
    expect(suffix(null)).toBeNull();
  });
});
