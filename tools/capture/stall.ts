// The owner's side of a take, over HTTP, and the database reads that tie a recording to a payment.
// The script drives screens with simulators and uses this only to see what the screens cannot say:
// the new item's code, the owner feed's totals, the AI spend on the ledger, and the PayPal IDs behind a checkout.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Observations, Totals } from './take-log.ts';

export interface DemoPage {
  ownerPassword: string;
  buyer: { email: string; password: string } | null;
  items: Array<{ code: string; name: string; mode: string; askingPence: number; availability: string }>;
}

/** The published demo page: the demo owner's password, the judge buyer's login and the stall's items. All of it is public by design. */
export async function readDemo(base: string): Promise<DemoPage> {
  const response = await fetch(`${base}/api/demo`);
  if (!response.ok) throw new Error(`GET /api/demo failed: ${response.status}`);
  const page = await response.json() as { owner: { password: string }; buyer: DemoPage['buyer']; items: DemoPage['items'] };
  return { ownerPassword: page.owner.password, buyer: page.buyer, items: page.items };
}

export interface OwnerItem { id: string; code: string; name: string; status: string; mode: string; askingPence: number }
interface FeedSnapshot { recordedSalesPence: number; itemsSold: number; sales: Array<{ code: string; amountPence: number; webhookVerifiedAt: string | null; time: string }> }
interface LedgerSnapshot { aiSpend: { spentUsd: number; capUsd: number } }
export interface ClosingReport {
  status: string; recordedSalesPence: number;
  items: Array<{ id: string; name: string; code: string; observation: string }>;
  groups: Array<{ key: string; label: string; items: Array<{ code: string }> }>;
}

export class Stall {
  readonly base: string;
  private cookie = '';

  constructor(base: string) { this.base = base; }

  async login(password: string) {
    const response = await fetch(`${this.base}/api/owner/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    if (!response.ok) throw new Error(`Owner login failed: ${response.status}`);
    this.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  }

  private async get<T>(path: string) {
    const response = await fetch(`${this.base}${path}`, { headers: { cookie: this.cookie } });
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return await response.json() as T;
  }

  items() { return this.get<{ items: OwnerItem[]; sessionStatus: string }>('/api/owner/items'); }
  async closing() { return (await this.get<{ closing: ClosingReport | null }>('/api/owner/closing')).closing; }

  /** Adds an unsold fixed-price item through the API, so a take on the owner's own stall has a second item to flag as not at the stall. */
  async addFixedItem(name: string, askingPence: number) {
    const response = await fetch(`${this.base}/api/owner/items`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie }, body: JSON.stringify({ name, notes: 'Good used condition. Sold as seen.', mode: 'fixed', askingPence }) });
    if (!response.ok) throw new Error(`Adding ${name} failed: ${response.status}`);
    return (await response.json() as { code: string }).code;
  }

  /** Resets the demo stall to fresh stock. Only the demo owner may, and it refuses while a payment is in progress. */
  async resetDemo() {
    const response = await this.postDemoReset();
    if (!response.ok) throw new Error(`Demo reset failed: ${response.status}`);
  }

  /**
   * Starts a take on stock the service's idle timer is not counting down on: closed, or open with no available item that
   * takes offers, is what the timer waits on, and its reset landing during setup would remove what the owner just added.
   * The main stall's owner is refused the reset, which leaves that stall as it is.
   */
  async resetIdleDemo() {
    const { items, sessionStatus } = await this.items();
    if (sessionStatus === 'open' && items.some(item => item.mode === 'haggle' && item.status === 'available')) return;
    const response = await this.postDemoReset();
    if (!response.ok && response.status !== 403) throw new Error(`Demo reset failed: ${response.status}`);
  }

  private postDemoReset() {
    return fetch(`${this.base}/api/owner/demo/reset`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie }, body: '{}' });
  }
  feed() { return this.get<FeedSnapshot>('/api/owner/feed'); }
  async aiSpentUsd() { return (await this.get<LedgerSnapshot>('/api/owner/ledger/data')).aiSpend.spentUsd; }

  async totals(): Promise<Totals> {
    const { recordedSalesPence, itemsSold } = await this.feed();
    return { recordedSalesPence, itemsSold };
  }
}

/**
 * The commit that built the server being recorded, and the name of the web bundle it serves. A hosted server reports its
 * deployed commit on /api/health, which the web bundle name cannot show for an API-only deploy. A local server reports
 * none, so the commit the script ran from stands in. A hosted server that reports none is recorded as unknown, because
 * the local checkout says nothing about what it runs.
 */
export async function buildOf(base: string, local: boolean) {
  const health = await fetch(`${base}/api/health`).then(response => response.json() as Promise<{ commit?: unknown }>).catch(() => ({}) as { commit?: unknown });
  const reported = typeof health.commit === 'string' && health.commit !== 'unknown' ? health.commit.slice(0, 7) : undefined;
  let commit = reported ?? 'unknown';
  if (!reported && local) {
    // A copy downloaded as an archive has no history to name, so the commit stays unknown there.
    try {
      const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      commit = `${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()}${status ? '-dirty' : ''}`;
    } catch { commit = 'unknown'; }
  }
  const html = await fetch(`${base}/`).then(response => response.text());
  return { commit, web: /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1] ?? 'dev-server' };
}

// The slice of `pg` this file uses, so the tools need no type package of their own.
interface PgClient { connect(): Promise<void>; end(): Promise<void>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }
type Payments = Pick<Observations, 'checkout' | 'captures' | 'webhookEvents'>;

/**
 * Reads the latest checkout for an item, every capture on the item's checkouts, and the webhook
 * events that name those captures. `pg` lives in the API's dependencies, so it is loaded from there.
 */
export async function readPayments(databaseUrl: string, code: string): Promise<Payments> {
  const { Client } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('pg') as { Client: new (options: { connectionString: string }) => PgClient };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const checkout = (await client.query<NonNullable<Payments['checkout']>>(`select c.id, c.state, c.total_pence as "totalPence", c.paypal_order_id as "paypalOrderId"
      from checkouts c join checkout_lines l on l.checkout_id = c.id where l.code = $1 order by c.created_at desc limit 1`, [code])).rows[0] ?? null;
    const captures = (await client.query<Payments['captures'][number]>(`select cap.paypal_capture_id as id, cap.checkout_id as "checkoutId", cap.amount_pence as "amountPence", cap.status
      from captures cap join checkout_lines l on l.checkout_id = cap.checkout_id where l.code = $1`, [code])).rows;
    const inbox = captures.length
      ? (await client.query<{ event_id: string; event_type: string; raw_body: string }>('select event_id, event_type, raw_body from webhook_inbox where raw_body like any ($1)', [captures.map(capture => `%${capture.id}%`)])).rows
      : [];
    const webhookEvents = inbox.map(row => ({ id: row.event_id, type: row.event_type, resourceId: (JSON.parse(row.raw_body) as { resource?: { id?: string } }).resource?.id ?? null }));
    return { checkout, captures, webhookEvents };
  } finally { await client.end(); }
}
