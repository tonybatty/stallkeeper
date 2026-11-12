// Evidence a take cannot produce on its own, read and sent through PayPal's sandbox REST API with the app's
// sandbox client credentials (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, never printed). Output keeps six-character
// suffixes only. Run with no arguments for usage.
//
//   resend   Asks PayPal to deliver a take's PAYMENT.CAPTURE.COMPLETED event again, then checks that the order still
//            has one capture and the owner feed shows the same sale and totals. A duplicate must change nothing.
//   decline  Creates a GBP order and captures it with PayPal's negative-testing header for a declined instrument.
//            This talks to PayPal directly. It shows what PayPal sends for a decline, not how the service handles one.

import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { api, get, parseEvents, token, unchanged, type PayPalLogin, type Standing } from './hosted.ts';
import { sleep } from './simulator.ts';
import { readDemo, Stall } from './stall.ts';
import { suffix, type Take } from './take-log.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { take: { type: 'string' }, 'base-url': { type: 'string' }, out: { type: 'string' }, wait: { type: 'string', default: '120' } } });
const usage = `Usage:
  node tools/capture/evidence.ts resend --take <take.json> --base-url <origin> --out <file> [--wait <seconds>]
  node tools/capture/evidence.ts decline --out <file>
Reads the sandbox client from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Resend signs in to the demo stall with the password /api/demo publishes.`;

const [command] = positionals;
if (!values.out || (command !== 'resend' && command !== 'decline') || (command === 'resend' && !(values.take && values['base-url']))) {
  console.log(usage);
  process.exit(1);
}
const login: PayPalLogin | null = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? { clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET } : null;
if (!login) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
const accessToken = await token(login);

interface CaptureJson { id: string; status: string; amount?: { currency_code?: string; value?: string }; links?: Array<{ rel: string; href: string }> }
interface OrderJson { purchase_units?: Array<{ payments?: { captures?: Array<{ id: string }> } }> }

async function resend() {
  const take = JSON.parse(await readFile(values.take!, 'utf8')) as Take;
  if (!take.webhookEventSuffix || !take.captureSuffix || !take.itemCode) throw new Error('This take has no webhook event, capture and item to resend.');
  const since = encodeURIComponent(new Date(Date.parse(take.startedAt) - 60_000).toISOString().replace(/\.\d+Z$/, 'Z'));
  const events = parseEvents(await get(accessToken, `/v1/notifications/webhooks-events?page_size=50&event_type=PAYMENT.CAPTURE.COMPLETED&start_time=${since}`));
  const event = events.find(candidate => candidate.id.endsWith(take.webhookEventSuffix!));
  if (!event?.resourceId?.endsWith(take.captureSuffix)) throw new Error('PayPal lists no completed-capture event matching the take.');
  const demo = await readDemo(values['base-url']!);
  const stall = new Stall(new URL(values['base-url']!).origin);
  await stall.login(demo.ownerPassword);

  async function standing(): Promise<Standing> {
    const capture = await get<CaptureJson>(accessToken, `/v2/payments/captures/${event!.resourceId}`);
    const order = await get<OrderJson>(accessToken, new URL(capture.links!.find(link => link.rel === 'up')!.href).pathname);
    const feed = await stall.feed();
    return {
      captureStatus: capture.status, captureAmount: capture.amount?.value ?? '', captureCurrency: capture.amount?.currency_code ?? '',
      captureCount: order.purchase_units?.[0]?.payments?.captures?.length ?? 0,
      recordedSalesPence: feed.recordedSalesPence, itemsSold: feed.itemsSold, saleRows: feed.sales.filter(sale => sale.code === take.itemCode).length,
    };
  }

  const before = await standing();
  const sentAt = new Date().toISOString();
  const response = await fetch(`${api}/v1/notifications/webhooks-events/${event.id}/resend`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}' });
  const status = response.status;
  await sleep(Number(values.wait) * 1000);
  const after = await standing();
  const result = { command: 'resend', takeId: take.takeId, eventSuffix: suffix(event.id), captureSuffix: suffix(event.resourceId), resendStatus: status, sentAt, readAt: new Date().toISOString(), waitedSeconds: Number(values.wait), before, after, unchanged: unchanged(before, after) };
  await writeFile(values.out!, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (status !== 202 || !result.unchanged) process.exitCode = 1;
}

async function decline() {
  const mock = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const created = await fetch(`${api}/v2/checkout/orders`, { method: 'POST', headers, body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'GBP', value: '24.00' } }] }) });
  const order = await created.json() as { id?: string };
  if (!created.ok || !order.id) throw new Error(`Order creation failed: ${created.status}`);
  const attempt = await fetch(`${api}/v2/checkout/orders/${order.id}/capture`, { method: 'POST', headers: { ...headers, 'paypal-mock-response': mock }, body: '{}' });
  const body = await attempt.json() as { name?: string; details?: Array<{ issue?: string }> };
  const result = { command: 'decline', orderSuffix: suffix(order.id), currency: 'GBP', amount: '24.00', mockHeader: 'INSTRUMENT_DECLINED', captureStatus: attempt.status, name: body.name ?? null, issues: (body.details ?? []).map(detail => detail.issue ?? null), at: new Date().toISOString() };
  await writeFile(values.out!, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (attempt.status !== 422 || !result.issues.includes('INSTRUMENT_DECLINED')) process.exitCode = 1;
}

await (command === 'resend' ? resend() : decline());
