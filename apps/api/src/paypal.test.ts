import { describe, expect, it, vi } from 'vitest';
import { PayPal } from './paypal.js';

const checkout = { id: 'checkout-id', totalPence: 2200, lines: [{ name: 'Lamp', code: 'K7Q2', amountPence: 2200 }] };
const token = (value = 'test-token', expires = 3600) => Response.json({ access_token: value, expires_in: expires });
const order = () => Response.json({ id: 'ORDER123' });

describe('PayPal sandbox client', () => {
  it('caches tokens, coalesces concurrent refreshes and refreshes before expiry', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementation(async () => order());
    const client = new PayPal('test-id', 'test-secret', fetcher, () => now);
    await Promise.all([client.createOrder(checkout, 'stored-create-key'), client.createOrder(checkout, 'stored-create-key')]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(1);
    now = 3_541_000;
    fetcher.mockResolvedValueOnce(token('refreshed'));
    await client.createOrder(checkout, 'stored-create-key');
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token'))).toHaveLength(2);
    expect(fetcher.mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer refreshed' });
  });

  it('uses sandbox OAuth, GBP create and capture request shapes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementation(async () => order());
    const client = new PayPal('test-id', 'test-secret', fetcher);
    await client.createOrder(checkout, 'stored-create-key');
    await client.captureOrder('ORDER123', 'stored-capture-key');
    expect(fetcher.mock.calls[0]).toEqual(['https://api-m.sandbox.paypal.com/v1/oauth2/token', expect.objectContaining({ method: 'POST', body: 'grant_type=client_credentials', headers: { Authorization: `Basic ${Buffer.from('test-id:test-secret').toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' } })]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({ intent: 'CAPTURE', purchase_units: [{ custom_id: checkout.id, invoice_id: checkout.id, amount: { currency_code: 'GBP', value: '22.00', breakdown: { item_total: { currency_code: 'GBP', value: '22.00' } } }, items: [{ name: 'Lamp', sku: 'K7Q2', quantity: '1', unit_amount: { currency_code: 'GBP', value: '22.00' } }] }], payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', app_switch_preference: { launch_paypal_app: false } } } } });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ 'PayPal-Request-Id': expect.any(String) });
    expect(fetcher.mock.calls[2]).toEqual(['https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123/capture', expect.objectContaining({ method: 'POST', body: '{}', headers: expect.objectContaining({ 'PayPal-Request-Id': 'stored-capture-key' }) })]);
  });

  it('refreshes after 401 and reuses the operation idempotency key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(token('new')).mockResolvedValueOnce(order());
    await new PayPal('id', 'secret', fetcher).createOrder(checkout, 'stored-create-key');
    expect(fetcher).toHaveBeenCalledTimes(4);
    const first = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    const retry = new Headers(fetcher.mock.calls[3]?.[1]?.headers);
    expect(first.get('PayPal-Request-Id')).toBe(retry.get('PayPal-Request-Id'));
    expect(retry.get('Authorization')).toBe('Bearer new');
  });

  it('does not loop on rejected credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(token('new')).mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(new PayPal('id', 'secret', fetcher).createOrder(checkout, 'stored-create-key')).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('recovers from a failed token request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(token()).mockResolvedValueOnce(order());
    const client = new PayPal('id', 'secret', fetcher);
    await expect(client.createOrder(checkout, 'stored-create-key')).rejects.toThrow('network');
    await expect(client.createOrder(checkout, 'stored-create-key')).resolves.toEqual({ id: 'ORDER123' });
  });
});

it('exposes the issue on API errors and leaves aborted outcomes unknown', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(Response.json({ details: [{ issue: 'INSTRUMENT_DECLINED' }] }, { status: 422 }));
  const client = new PayPal('id', 'secret', fetcher);
  await expect(client.captureOrder('ORDER123', 'stored-key')).rejects.toMatchObject({ issue: 'INSTRUMENT_DECLINED', status: 422 });
  fetcher.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
  await expect(client.captureOrder('ORDER123', 'stored-key')).rejects.toMatchObject({ name: 'TimeoutError' });
});

// Found by reviewing the client with the APIMatic Context Plugin's error handling skill: a log line must say which call failed,
// and a success status with an unreadable body is an unknown outcome that keeps its status, not a bare SyntaxError.
it('names the failed call and keeps the status of an unreadable success body', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token())
    .mockResolvedValueOnce(Response.json({ details: [{ issue: 'ORDER_NOT_APPROVED' }] }, { status: 422, headers: { 'paypal-debug-id': 'debug-1' } }))
    .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 200, headers: { 'paypal-debug-id': 'debug-2' } }))
    .mockResolvedValueOnce(Response.json([1, 2], { status: 200 }));
  const client = new PayPal('id', 'secret', fetcher);
  await expect(client.captureOrder('ORDER123', 'stored-key')).rejects.toMatchObject({ status: 422, issue: 'ORDER_NOT_APPROVED', debugId: 'debug-1', operation: 'POST /v2/checkout/orders/ORDER123/capture', message: 'PayPal POST /v2/checkout/orders/ORDER123/capture failed: 422' });
  await expect(client.getOrder('ORDER123')).rejects.toMatchObject({ status: 200, issue: 'UNREADABLE_RESPONSE', debugId: 'debug-2', operation: 'GET /v2/checkout/orders/ORDER123' });
  await expect(client.getOrder('ORDER123')).rejects.toMatchObject({ status: 200, issue: 'UNREADABLE_RESPONSE' });
});

it('keeps the status and debug ID of a token response with an HTML body', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 200, headers: { 'paypal-debug-id': 'debug-3' } }));
  await expect(new PayPal('id', 'secret', fetcher).getOrder('ORDER123')).rejects.toMatchObject({ status: 200, issue: 'UNREADABLE_RESPONSE', debugId: 'debug-3', operation: 'POST /v1/oauth2/token' });
});

it('treats a token response whose JSON is not an object as unreadable', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([1, 2])).mockResolvedValueOnce(Response.json(null));
  const client = new PayPal('id', 'secret', fetcher);
  await expect(client.getOrder('ORDER123')).rejects.toMatchObject({ status: 200, issue: 'UNREADABLE_RESPONSE', operation: 'POST /v1/oauth2/token' });
  await expect(client.getOrder('ORDER123')).rejects.toMatchObject({ status: 200, issue: 'UNREADABLE_RESPONSE', operation: 'POST /v1/oauth2/token' });
});

it('names the token request when it is refused', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(new PayPal('id', 'secret', fetcher).getOrder('ORDER123')).rejects.toMatchObject({ status: 401, operation: 'POST /v1/oauth2/token' });
});
