import { afterEach, expect, it, vi } from 'vitest';
import { closedStall } from '../test/closed-stall.js';
import { testDatabase } from '../test/database.js';

// The toolkit caches its OAuth token with no expiry, so each check must start from a new one.
const built = vi.hoisted(() => ({ count: 0 }));
vi.mock('@paypal/agent-toolkit/ai-sdk', () => ({
  PayPalAgentToolkit: class {
    constructor() { built.count += 1; }
    getTools() {
      const execute = async () => JSON.stringify({ ok: false, status: 403 });
      return { get_order: { execute }, list_transactions: { execute } };
    }
  },
}));
const db = testDatabase();
let stall: Awaited<ReturnType<typeof closedStall>>;
afterEach(async () => { await stall.app.close(); });

it('builds a new toolkit for every check', async () => {
  stall = await closedStall(db);
  await stall.sell(); await stall.close();
  expect((await stall.post('/api/owner/closing/paypal-check')).statusCode).toBe(200);
  expect((await stall.post('/api/owner/closing/paypal-check')).statusCode).toBe(200);
  expect(built.count).toBe(2);
});
