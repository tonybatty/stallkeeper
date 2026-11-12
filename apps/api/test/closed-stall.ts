import type { LanguageModel } from 'ai';
import { expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { Toolkit } from '../src/paypal-check.js';

const config = { clientId: 'test', clientSecret: 'test', webhookId: 'test', publicBaseUrl: 'http://localhost:5173', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false };

// A stall with one £28 lamp on a mocked PayPal. `sell` completes a capture for it, `close` ends trading and returns the report.
export async function closedStall(db: Pool, options: { model?: LanguageModel; toolkit?: Toolkit; now?: Date } = {}) {
  await db.query('truncate items,buyer_sessions,trading_sessions,webhook_inbox,ai_usage cascade');
  const now = options.now ?? new Date('2026-11-05T12:00:00Z');
  let captureState = 'COMPLETED';
  const orders = new Map<string, string>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    if (path.endsWith('/capture')) {
      const id = path.split('/').at(-2)!;
      return Response.json({ id, purchase_units: [{ custom_id: orders.get(id), payments: { captures: [{ id: `CAP-${id}`, status: captureState, amount: { value: '28.00', currency_code: 'GBP' } }] } }] });
    }
    const id = `ORDER${orders.size + 1}`;
    orders.set(id, JSON.parse(String(init?.body)).purchase_units[0].custom_id);
    return Response.json({ id });
  });
  const app = buildApp(config, { db, fetcher, now: () => now, ...(options.model ? { model: options.model } : {}), ...(options.toolkit ? { toolkit: options.toolkit } : {}) });
  const post = (url: string, cookies: Record<string, string>, payload?: object) => app.inject({ method: 'POST', url, cookies, ...(payload ? { payload } : {}) });
  const owner = { stallkeeper_owner: (await post('/api/owner/login', {}, { password: 'owner' })).cookies[0]!.value };
  const item = (await post('/api/owner/items', owner, { name: 'Brass lamp', notes: 'Tested', mode: 'fixed', askingPence: 2800 })).json() as { id: string; code: string };
  await post('/api/owner/stall/open', owner);
  const get = async () => (await app.inject({ url: '/api/owner/closing', cookies: owner })).json() as { closing: { sessionId: string; status: string }; summary: string | null; summaryPending: boolean; paypalCheck: Record<string, unknown> | null };
  return {
    app, owner, item, orders,
    // `pending` leaves the checkout unresolved with PayPal's capture still pending.
    async sell(pending = false) {
      captureState = pending ? 'PENDING' : 'COMPLETED';
      const buyer = { stallkeeper_buyer: (await app.inject(`/api/i/${item.code}`)).cookies[0]!.value };
      const checkout = (await post(`/api/i/${item.code}/checkout`, buyer, {})).json() as { checkoutId: string; paypalOrderId: string };
      await post(`/api/checkouts/${checkout.checkoutId}/capture`, buyer);
      return checkout;
    },
    // Closing starts the summary on its own, so this waits for that write to finish and tests see a settled report.
    close: async () => {
      const report = (await post('/api/owner/stall/close', owner)).json() as { id: string; sessionId: string };
      await vi.waitFor(async () => { expect((await get()).summaryPending).toBe(false); }, { timeout: 15_000 });
      return report;
    },
    get,
    add: async (name: string) => (await post('/api/owner/items', owner, { name, notes: 'Tested', mode: 'fixed', askingPence: 1200 })).json() as { id: string; code: string },
    async take(name: string) {
      const free = (await post('/api/owner/items', owner, { name, notes: 'Used', mode: 'free', askingPence: 200 })).json() as { id: string; code: string };
      const buyer = { stallkeeper_buyer: (await app.inject(`/api/i/${free.code}`)).cookies[0]!.value };
      await post(`/api/i/${free.code}/take`, buyer, {});
      return free;
    },
    post: (path: string) => post(path, owner),
    // Flags an item as not at the stall, or clears the flag.
    observe: (sessionId: string, observation: string, itemId = item.id) => app.inject({ method: 'PUT', url: '/api/owner/closing/shelf-check', cookies: owner, payload: { sessionId, itemId, observation } }),
  };
}
