const baseUrl = 'https://api-m.sandbox.paypal.com';

// `operation` is the method and path of the call, so a log line names what failed. It carries no query, header or body.
// `issue` is PayPal's own code for a rejected request. UNREADABLE_RESPONSE is ours: PayPal answered with a success status
// and a body that could not be read, so on an order call what happened to the order is unknown.
const unreadableResponse = 'UNREADABLE_RESPONSE';
export class PayPalError extends Error {
  constructor(readonly status: number, readonly debugId: string | null, readonly issue: string | undefined, readonly operation: string) {
    super(`PayPal ${operation} failed: ${status}`);
  }
}

// A success status with an unreadable body keeps its status and debug ID, so the log can say PayPal answered.
async function readObject(response: Response, operation: string) {
  const data: unknown = await response.json().catch(() => undefined);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PayPalError(response.status, response.headers.get('paypal-debug-id'), unreadableResponse, operation);
  return data as Record<string, unknown>;
}

export class PayPal {
  private token?: { value: string; expiresAt: number };
  private refreshing?: Promise<string>;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh();
    try { return await this.refreshing; }
    finally { this.refreshing = undefined; }
  }

  private async refresh(): Promise<string> {
    const startedAt = this.now();
    const response = await this.fetcher(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const operation = 'POST /v1/oauth2/token';
    if (!response.ok) throw new PayPalError(response.status, response.headers.get('paypal-debug-id'), undefined, operation);
    const data = await readObject(response, operation) as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new Error('Invalid PayPal token response');
    }
    this.token = { value: data.access_token, expiresAt: startedAt + data.expires_in * 1000 - Math.min(60_000, data.expires_in * 100) };
    return this.token.value;
  }

  private async post(path: string, body: string | undefined, requestId?: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      const method = body === undefined ? 'GET' : 'POST';
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method, signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          ...(requestId ? { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' } : {}),
        },
        body,
      });
      if (response.status === 401 && attempt === 0) {
        if (this.token?.value === token) this.token = undefined;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { details?: Array<{ issue?: string }> };
        throw new PayPalError(response.status, response.headers.get('paypal-debug-id'), error.details?.[0]?.issue, `${method} ${path}`);
      }
      return await readObject(response, `${method} ${path}`);
    }
    throw new Error('PayPal authentication failed');
  }

  createOrder(checkout: { id: string; totalPence: number; lines: Array<{ name: string; code: string; amountPence: number }> }, requestId: string) {
    const amount = { currency_code: 'GBP', value: (checkout.totalPence / 100).toFixed(2) };
    return this.post('/v2/checkout/orders', JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: checkout.id, invoice_id: checkout.id,
        amount: { ...amount, breakdown: { item_total: amount } },
        items: checkout.lines.map(line => ({ name: line.name, sku: line.code, quantity: '1',
          category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'GBP', value: (line.amountPence / 100).toFixed(2) } })),
      }],
      // app_switch_preference is accepted by the Orders v2 API but missing from its published schema (which lists
      // app_switch_context). Without it, iPhone Safari buyers are sometimes sent to the bare sandbox.paypal.com host,
      // and the PayPal JavaScript SDK ignores messages from that host. Re-check with PayPal if it is ever rejected.
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', app_switch_preference: { launch_paypal_app: false } } } },
    }), requestId);
  }

  captureOrder(id: string, requestId: string) {
    return this.post(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, '{}', requestId);
  }

  getOrder(id: string) {
    return this.post(`/v2/checkout/orders/${encodeURIComponent(id)}`, undefined);
  }

  async verifyWebhook(rawEvent: string, headers: Record<string, string>, webhookId: string) {
    const fields = JSON.stringify({
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId,
    });
    const result = await this.post('/v1/notifications/verify-webhook-signature', `${fields.slice(0, -1)},"webhook_event":${rawEvent}}`);
    return result.verification_status === 'SUCCESS';
  }
}
