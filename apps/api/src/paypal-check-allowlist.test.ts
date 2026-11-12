import { afterEach, expect, it, vi } from 'vitest';
import { closedStall } from '../test/closed-stall.js';
import { testDatabase } from '../test/database.js';

// A release that maps the two allowed actions to more tools must stop the check before it reads anything.
vi.mock('@paypal/agent-toolkit/ai-sdk', () => ({
  PayPalAgentToolkit: class { getTools() { return { get_order: {}, list_transactions: {}, create_order: {} }; } },
}));
const db = testDatabase();
let stall: Awaited<ReturnType<typeof closedStall>>;
afterEach(async () => { await stall.app.close(); });

it('refuses to run when the installed toolkit exposes a tool outside the allowlist', async () => {
  const { installedToolkit } = await import('./paypal-check.js');
  expect(() => installedToolkit('x', 'y')).toThrow('create_order');
  stall = await closedStall(db);
  await stall.sell(); await stall.close();
  const response = await stall.post('/api/owner/closing/paypal-check');
  expect(response.statusCode).toBe(502);
  expect(response.json().error).toBe('The PayPal check could not run just now. The report above is unaffected.');
  expect((await stall.get()).paypalCheck).toBeNull();
});
