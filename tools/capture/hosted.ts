// What a take can learn about a hosted sale without database access: the PayPal order and its
// captures from PayPal's own API, and the webhook events PayPal sent for those captures. The hosted
// database is reachable only by the service, so these stand in for `readPayments` there.

import { sleep } from './simulator.ts';
import type { Observations } from './take-log.ts';

export const api = 'https://api-m.sandbox.paypal.com';

export interface PayPalLogin { clientId: string; clientSecret: string }

const pence = (value: string | undefined) => Math.round(Number(value) * 100);

interface OrderJson { id?: string; purchase_units?: Array<{ custom_id?: string; payments?: { captures?: Array<{ id: string; status: string; amount?: { currency_code?: string; value?: string } }> } }> }
interface EventsJson { events?: Array<{ id: string; event_type: string; resource?: { id?: string } }> }

/** The checkout ID the service stored on the order, and the captures on it. Pure, so the shape is tested. */
export function parseOrder(json: OrderJson) {
  const unit = json.purchase_units?.[0];
  return {
    orderId: json.id ?? null,
    checkoutId: unit?.custom_id ?? null,
    captures: (unit?.payments?.captures ?? []).map(capture => ({ id: capture.id, status: capture.status, amountPence: pence(capture.amount?.value), currency: capture.amount?.currency_code ?? '' })),
  };
}

export function parseEvents(json: EventsJson): Observations['webhookEvents'] {
  return (json.events ?? []).map(event => ({ id: event.id, type: event.event_type, resourceId: event.resource?.id ?? null }));
}

export async function token(login: PayPalLogin) {
  const response = await fetch(`${api}/v1/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: `Basic ${Buffer.from(`${login.clientId}:${login.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!response.ok) throw new Error(`PayPal token request failed: ${response.status}`);
  return (await response.json() as { access_token: string }).access_token;
}

export async function get<T>(accessToken: string, path: string) {
  const response = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`PayPal GET ${path.split('?')[0]} failed: ${response.status}`);
  return await response.json() as T;
}

/** What a duplicate delivery must leave alone: the capture, the order's captures and the owner's totals. Pure, so it is tested. */
export interface Standing { captureStatus: string; captureAmount: string; captureCurrency: string; captureCount: number; recordedSalesPence: number; itemsSold: number; saleRows: number }
export function unchanged(before: Standing, after: Standing) { return JSON.stringify(before) === JSON.stringify(after); }

export interface HostedReads {
  /** Reads the checkout from the buyer's own page, the only session that may read it. */
  readCheckout: (checkoutId: string) => Promise<NonNullable<Observations['checkout']>>;
}

/**
 * Reads the sale from PayPal and the buyer's page. The webhook list can lag the capture, so it is read
 * until an event naming the capture shows up or the time runs out. PayPal's listing has trailed a delivery by over a
 * minute, so a take through sale waits up to five minutes.
 */
export async function readHostedPayments(login: PayPalLogin, orderId: string, since: Date, reads: HostedReads, waitMs = 60_000): Promise<Pick<Observations, 'checkout' | 'captures' | 'webhookEvents'>> {
  const accessToken = await token(login);
  const order = parseOrder(await get<OrderJson>(accessToken, `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  if (!order.checkoutId) throw new Error('The PayPal order does not name a checkout.');
  const checkout = await reads.readCheckout(order.checkoutId);
  const captures = order.captures.map(capture => ({ id: capture.id, checkoutId: order.checkoutId!, amountPence: capture.amountPence, status: capture.status, currency: capture.currency }));
  let webhookEvents: Observations['webhookEvents'] = [];
  const deadline = Date.now() + waitMs;
  for (;;) {
    const start = encodeURIComponent(new Date(since.getTime() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'));
    webhookEvents = parseEvents(await get<EventsJson>(accessToken, `/v1/notifications/webhooks-events?page_size=50&event_type=PAYMENT.CAPTURE.COMPLETED&start_time=${start}`));
    if (!captures.length || webhookEvents.some(event => captures.some(capture => capture.id === event.resourceId)) || Date.now() > deadline) break;
    await sleep(5_000);
  }
  return { checkout, captures, webhookEvents };
}
