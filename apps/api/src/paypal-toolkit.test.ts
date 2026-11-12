import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { installedToolkit } from './paypal-check.js';

// Stub the installed toolkit's HTTP transport, so its real wrappers and dependencies run without credentials.
const requireToolkit = createRequire(import.meta.resolve('@paypal/agent-toolkit/ai-sdk'));
interface Request { url: string; method: string; params?: Record<string, unknown> }
const axios = requireToolkit('axios') as { defaults: { adapter: unknown } };
const originalAdapter = axios.defaults.adapter;
afterEach(() => { axios.defaults.adapter = originalAdapter; });

it('executes only order and transaction reads through the installed toolkit', async () => {
  const order = { id: 'ORDER123', purchase_units: [{ payments: { captures: [{ status: 'COMPLETED', amount: { currency_code: 'GBP', value: '28.00' } }] } }] };
  const listing = { transaction_details: [{ transaction_info: { transaction_id: 'CAPTURE123' } }], total_pages: 1 };
  const transport = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    const data = url.pathname === '/v1/oauth2/token' ? { access_token: 'mock-token' }
      : url.pathname === '/v2/checkout/orders/ORDER123' ? order
        : url.pathname === '/v1/reporting/transactions' ? listing : undefined;
    if (!data) throw new Error('Unexpected request');
    expect(url.origin).toBe('https://api.sandbox.paypal.com');
    return { data, status: 200, statusText: 'OK', headers: {}, config: request };
  });
  axios.defaults.adapter = transport;
  const toolkit = installedToolkit('mock-client', 'mock-secret');
  expect(Object.keys(toolkit).sort()).toEqual(['get_order', 'list_transactions']);
  const options = { toolCallId: 'check', messages: [] };
  expect(JSON.parse(String(await toolkit.get_order.execute({ id: 'ORDER123' }, options)))).toEqual(order);
  const range = { start_date: '2026-11-05T00:00:00.000Z', end_date: '2026-11-05T12:00:00.000Z', page_size: 100 };
  expect(JSON.parse(String(await toolkit.list_transactions.execute(range, options)))).toEqual(listing);
  expect(transport.mock.calls.map(([request]) => [request.method, new URL(request.url).pathname])).toEqual([
    ['post', '/v1/oauth2/token'], ['get', '/v2/checkout/orders/ORDER123'], ['get', '/v1/reporting/transactions'],
  ]);
  expect(transport.mock.calls[2]![0].params).toEqual(range);
});

it('keeps a transport failure as an unreadable result', async () => {
  axios.defaults.adapter = async () => { throw new Error('Mock outage'); };
  const tools = installedToolkit('mock-client', 'mock-secret');
  const result = await tools.get_order.execute({ id: 'ORDER123' }, { toolCallId: 'check', messages: [] });
  expect(JSON.parse(String(result))).toMatchObject({ error: { type: 'paypal_error' } });
});
