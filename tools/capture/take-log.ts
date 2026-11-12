// What a take records, and the checks that decide whether its footage shows one continuous sale.
// Pure logic with no I/O, so the rules can be tested without a simulator or PayPal.
//
// Full PayPal IDs are held in memory for the checks only. The log keeps suffixes, enough to find
// the transaction in PayPal's dashboard and not enough to act on it.

import type { Role } from './beats.ts';

const SUFFIX_LENGTH = 6;
export const suffix = (id: string | null | undefined) => (id ? id.slice(-SUFFIX_LENGTH) : null);

export interface Totals { recordedSalesPence: number; itemsSold: number }

/** What the script saw, with full IDs. Never written to disk as it is. */
export interface Observations {
  itemCode: string;
  askingPence: number;
  /** The amount on the offer card the buyer tapped. Null when the build has no offers. */
  agreedPence: number | null;
  /** The amount the paid page showed. Null until a sale completes. */
  paidPagePence: number | null;
  /** The PayPal order in the buyer's approval page, read from its URL. */
  approvalOrderId: string | null;
  /** The host PayPal's tab was on, read from the tab's URL. `sandbox.paypal.com` without `www` is the host the PayPal SDK cannot hear. */
  paypalHost: string | null;
  checkout: { id: string; state: string; totalPence: number; paypalOrderId: string | null } | null;
  /** Every capture row found for the item's checkouts, so a capture on another checkout shows up. */
  captures: Array<{ id: string; checkoutId: string; amountPence: number; status: string; currency?: string | null }>;
  webhookEvents: Array<{ id: string; type: string; resourceId: string | null }>;
  /** The item's row in the owner feed. */
  feedSale: { code: string; amountPence: number; webhookVerified: boolean } | null;
  /** The URL decoded from the printed tag's QR image, and the item name the buyer's page showed after opening it. */
  tag: { decodedUrl: string | null; urlProblems: string[]; openedItemName: string | null; itemName: string } | null;
  totalsBefore: Totals | null;
  totalsAfter: Totals | null;
  /** The closing report as the owner's closing page showed it, after the staged flag. */
  closing: ClosingObservation | null;
  /** The service-wide AI spend in US dollars, read from the stall ledger data before the first question and after the last. Other buyers' chat counts too. */
  aiSpend: { beforeUsd: number; afterUsd: number } | null;
}

/** The report group for an item that is not on the shelf and has no confirmed payment. This is the difference a take stages. */
export const differenceGroup = 'unpaidAbsent';
/** The report group for an item that was paid for and has left the shelf, which is the sold item's ordinary place. */
const soldGroup = 'paidAbsent';

export interface ClosingObservation {
  /** The unsold item the take flagged as not at the stall, so the report has one difference to show. */
  stagedCode: string;
  status: string;
  recordedSalesPence: number;
  groups: Array<{ key: string; codes: string[] }>;
  /** Whether the owner's screen showed the difference's heading and the staged item under it. */
  shownOnScreen: boolean;
}

/**
 * How far a take set out to go. A take that stops at PayPal's login page has no capture to check.
 * A take that goes through capture also has no webhook or feed to check, because a local run gets no webhook.
 * Only a take through closing covers the whole running order, so only it can be complete.
 */
export type Reach = 'login' | 'capture' | 'sale' | 'closing';

export function checkTake(o: Observations, reach: Reach): string[] {
  const problems: string[] = [];
  const { checkout } = o;
  if (!checkout) return ['No checkout was recorded for the item.'];
  if (!checkout.paypalOrderId) problems.push('The checkout has no PayPal order.');
  if (!o.approvalOrderId) problems.push('The buyer\'s approval page was not reached, so no order was seen.');
  else if (o.approvalOrderId !== checkout.paypalOrderId) problems.push('The approval page shows a different PayPal order from the checkout.');
  if (o.agreedPence !== null && o.agreedPence !== checkout.totalPence) problems.push('The agreed price differs from the checkout total.');
  const foreign = o.captures.filter(capture => capture.checkoutId !== checkout.id);
  if (foreign.length) problems.push('A capture belongs to a different checkout from this take.');
  const own = o.captures.filter(capture => capture.checkoutId === checkout.id);

  if (o.tag) {
    problems.push(...o.tag.urlProblems);
    if (o.tag.openedItemName !== o.tag.itemName) problems.push('The tag URL did not open the item it was printed for.');
  } else if (reach === 'sale' || reach === 'closing') problems.push('No tag was decoded for this take.');

  if (reach === 'login') {
    if (own.length) problems.push('A capture exists although the take stopped at the login page.');
    return problems;
  }

  if (checkout.state !== 'paid') problems.push(`The checkout is ${checkout.state}, not paid.`);
  const [capture] = own;
  if (own.length !== 1 || !capture) { problems.push(`Expected one capture for the checkout, found ${own.length}.`); return problems; }
  if (capture.status !== 'COMPLETED') problems.push(`The capture is ${capture.status}, not COMPLETED.`);
  if (capture.amountPence !== checkout.totalPence) problems.push('The capture amount differs from the checkout total.');
  if (capture.currency && capture.currency !== 'GBP') problems.push(`The capture is in ${capture.currency}, not GBP.`);
  if (o.paidPagePence !== checkout.totalPence) problems.push('The paid page amount differs from the checkout total.');
  if (reach === 'capture') return problems;
  if (!o.feedSale) problems.push('The sale is not in the owner feed.');
  else {
    if (o.feedSale.code !== o.itemCode) problems.push('The owner feed shows a different item.');
    if (o.feedSale.amountPence !== checkout.totalPence) problems.push('The owner feed amount differs from the checkout total.');
    if (!o.feedSale.webhookVerified) problems.push('The owner feed has no webhook verified mark.');
  }
  if (!o.webhookEvents.some(event => event.type === 'PAYMENT.CAPTURE.COMPLETED' && event.resourceId === capture.id)) {
    problems.push('No PAYMENT.CAPTURE.COMPLETED webhook names this capture.');
  }
  const { totalsBefore: before, totalsAfter: after } = o;
  if (!before || !after) problems.push('Totals before and after were not both read.');
  else {
    if (after.recordedSalesPence !== before.recordedSalesPence + checkout.totalPence) problems.push('Recorded sales did not rise by the sale amount.');
    if (after.itemsSold !== before.itemsSold + 1) problems.push('Items sold did not rise by one.');
  }
  if (reach === 'closing') problems.push(...checkClosing(o));
  return problems;
}

function checkClosing(o: Observations) {
  const { closing } = o;
  if (!closing) return ['The closing report was not read.'];
  const problems: string[] = [];
  const codesIn = (key: string) => closing.groups.find(group => group.key === key)?.codes ?? [];
  if (closing.status !== 'final') problems.push('The closing report is still provisional.');
  if (codesIn(differenceGroup).join() !== closing.stagedCode) problems.push('The closing report\'s difference is not the one staged item.');
  if (!codesIn(soldGroup).includes(o.itemCode)) problems.push('The sold item is not in the closing report\'s paid group.');
  for (const key of ['unknown', 'unresolved']) if (codesIn(key).length) problems.push(`The closing report has items in "${key}".`);
  if (o.totalsAfter && closing.recordedSalesPence !== o.totalsAfter.recordedSalesPence) problems.push('The closing report\'s recorded sales differ from the owner feed\'s.');
  if (!closing.shownOnScreen) problems.push('The owner\'s screen did not show the staged difference.');
  return problems;
}

export type BeatOutcome = 'done' | 'skipped' | 'failed';
export interface BeatLog { id: string; startedAt: string; endedAt: string; outcome: BeatOutcome; note?: string }
export interface Recording { role: Role; file: string; startedAt: string }

/**
 * How long approval took, against the checkout's five-minute reservation. The reservation starts when
 * the buyer taps Pay, so the clock here starts at that tap.
 */
export interface ApprovalTiming {
  reservationSeconds: number;
  /** From the tap on Pay to the PayPal login form showing. */
  loginFormMs: number;
  /** From the tap on Pay to the paid line showing on the buyer's page. */
  reservedToPaidMs: number;
  /** From the click on PayPal's own Pay button to the paid line. */
  approveToPaidMs: number;
  /** Whether the buyer's page was visible when its capture request left. PayPal's tab is in front during approval. */
  captureSentWhile: 'visible' | 'hidden' | null;
  /** Whether the buyer's page reloaded, which a redirect back from PayPal would cause. */
  pageReloaded: boolean;
  /** How long after the paid line PayPal's tab closed, or null if it was still open when watching stopped. */
  paypalTabClosedAfterMs: number | null;
  /** How long after the paid line Safari showed the buyer's page again. The tab list changes before the screen does. */
  buyerPageShownAfterMs: number | null;
}

export interface Take {
  takeId: string;
  /** The failed take this one reruns. A rerun is a whole new sale on a new item, never a continuation. */
  supersedes: string | null;
  mode: 'dry-run' | 'real';
  model: 'scripted' | 'claude';
  environment: string;
  build: { commit: string; web: string };
  host: string;
  startedAt: string;
  endedAt: string | null;
  reach: Reach;
  approval: ApprovalTiming | null;
  status: 'complete' | 'stopped' | 'failed';
  problems: string[];
  itemCode: string | null;
  /** The decoded tag URL's path and the item it opened, kept so the evidence can say a scanned image reached the right page. */
  tag: { decodedPath: string | null; openedItemName: string | null } | null;
  askingPence: number | null;
  agreedPence: number | null;
  checkoutPence: number | null;
  checkoutSuffix: string | null;
  approvalOrderSuffix: string | null;
  /** The host PayPal's tab landed on, so a take shows which path it ran. Null when PayPal's tab was never reached. */
  paypalHost: string | null;
  orderSuffix: string | null;
  captureSuffix: string | null;
  /** The currency PayPal reports on the capture. Null on a local run, which reads its captures from the database. */
  captureCurrency: string | null;
  webhookEventSuffix: string | null;
  totalsBefore: Totals | null;
  totalsAfter: Totals | null;
  /** The staged difference and the report's figures. Null when the take did not reach closing. */
  closing: { stagedCode: string; status: string; recordedSalesPence: number; differenceCodes: string[]; shownOnScreen: boolean } | null;
  aiSpend: Observations['aiSpend'];
  aiReplies: Array<{ question: string; reply: string }>;
  beats: BeatLog[];
  recordings: Recording[];
}

export type TakeStart = Pick<Take, 'takeId' | 'supersedes' | 'mode' | 'model' | 'environment' | 'build' | 'host' | 'startedAt' | 'reach'>;

export function nextTake(previous: Take[]) {
  const last = previous.at(-1);
  return { takeId: `take-${previous.length + 1}`, supersedes: last && last.status === 'failed' ? last.takeId : null };
}

/** Builds the logged record. A take with any problem is failed, whatever else it reached. */
export function finishTake(start: TakeStart, o: Observations | null, beats: BeatLog[], recordings: Recording[], aiReplies: Take['aiReplies'], endedAt: string, failure?: string, approval: ApprovalTiming | null = null): Take {
  const problems = [...(failure ? [failure] : []), ...(o ? checkTake(o, start.reach) : [])];
  const capture = o?.captures.find(candidate => candidate.checkoutId === o.checkout?.id);
  const event = o && capture ? o.webhookEvents.find(candidate => candidate.type === 'PAYMENT.CAPTURE.COMPLETED' && candidate.resourceId === capture.id) : undefined;
  return {
    ...start, endedAt, approval,
    status: problems.length ? 'failed' : start.reach === 'closing' ? 'complete' : 'stopped',
    problems,
    itemCode: o?.itemCode ?? null,
    tag: o?.tag ? { decodedPath: o.tag.decodedUrl ? new URL(o.tag.decodedUrl).pathname : null, openedItemName: o.tag.openedItemName } : null,
    askingPence: o?.askingPence ?? null, agreedPence: o?.agreedPence ?? null,
    checkoutPence: o?.checkout?.totalPence ?? null,
    checkoutSuffix: suffix(o?.checkout?.id),
    approvalOrderSuffix: suffix(o?.approvalOrderId),
    paypalHost: o?.paypalHost ?? null,
    orderSuffix: suffix(o?.checkout?.paypalOrderId),
    captureSuffix: suffix(capture?.id),
    captureCurrency: capture?.currency ?? null,
    webhookEventSuffix: suffix(event?.id),
    totalsBefore: o?.totalsBefore ?? null, totalsAfter: o?.totalsAfter ?? null,
    closing: o?.closing ? { stagedCode: o.closing.stagedCode, status: o.closing.status, recordedSalesPence: o.closing.recordedSalesPence, differenceCodes: o.closing.groups.find(group => group.key === differenceGroup)?.codes ?? [], shownOnScreen: o.closing.shownOnScreen } : null,
    aiSpend: o?.aiSpend ?? null,
    aiReplies, beats, recordings,
  };
}
