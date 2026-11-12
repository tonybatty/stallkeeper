import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { LanguageModel } from 'ai';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { offerRoutes } from './offers.js';
import { chatService } from './chat.js';
import { demoRoutes, demoStall } from './demo.js';
import { feedUpdates } from './feed.js';
import { webhookProcessor } from './webhooks.js';
import { checkoutRoutes, paymentRepair } from './checkouts.js';
import { freeRoutes } from './free.js';
import { photoPublicRoutes, SupabasePhotoStorage } from './photos.js';
import { buyerRoutes, newItemLimit } from './items.js';
import { ownerRoutes } from './owner.js';
import { PayPal, PayPalError } from './paypal.js';
import { retailService } from './retail.js';
import { summaryService } from './closing-summary.js';
import { priceReviewService } from './price-review.js';
import { installedToolkit, loggable, type Toolkit } from './paypal-check.js';

export function publicOrigin(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must be an http or https URL. See docs/SETUP.md.');
  return url.origin;
}

function parseEvent(raw: string) {
  try { return JSON.parse(raw) as Record<string, unknown> | null; }
  catch { return null; }
}

export function buildApp(config: {
  supabaseUrl?: string; supabaseServiceRoleKey?: string;
  clientId: string; clientSecret: string; webhookId?: string; donateButtonId?: string; webDist?: string; publicBaseUrl: string;
  anthropicApiKey?: string; aiDailyCapUsd?: string; aiLedgerDailyCapUsd?: string; agStudioLicenceKey?: string; channel3ApiKey?: string;
  demoBuyerEmail?: string; demoBuyerPassword?: string; demoFilmUrl?: string; demoRepoUrl?: string;
  ownerPassword: string; demoOwnerPassword: string; sessionSecret: string; production: boolean;
  /** The deployed commit, so a check can tell which build answered. */
  commit?: string;
}, options: { fetcher?: typeof fetch; db: Pool; model?: LanguageModel; toolkit?: Toolkit; now?: () => Date; logger?: boolean | { level: string; stream: { write(line: string): void } } }) {
  // One hop, so request.ip is the last X-Forwarded-For entry, which a client can't forge. On Render that entry looks
  // like a shared Cloudflare edge address, so the login throttle keys on CF-Connecting-IP instead (see ownerRoutes).
  const app = Fastify({ logger: options.logger ?? false, trustProxy: config.production ? (_address, hop) => hop < 1 : false });
  const storage = config.supabaseUrl && config.supabaseServiceRoleKey ? new SupabasePhotoStorage(config.supabaseUrl, config.supabaseServiceRoleKey, options.fetcher) : undefined;
  const paypal = new PayPal(config.clientId, config.clientSecret, options.fetcher);
  const retail = retailService({ apiKey: config.channel3ApiKey, fetcher: options.fetcher, now: options.now ?? (() => new Date()) });

  const updates = feedUpdates();
  const newItems = newItemLimit(options.now ?? (() => new Date()));
  const demo = demoStall(options.db, options.now ?? (() => new Date()), updates.notify, retail, errorType => app.log.warn({ errorType }, 'Demo reference lookup failed'), newItems);
  const processor = webhookProcessor(app, options.db, options.now ?? (() => new Date()), updates.notify);
  const recovery = paymentRepair(app, options.db, paypal, options.now ?? (() => new Date()), updates.notify);
  let repairing: Promise<void> | undefined;
  let reviewing: Promise<void> | undefined;
  let repairTimer: ReturnType<typeof setInterval>;
  function repair() {
    repairing ??= (async () => {
      await processor.repair();
      await recovery.repair();
      await demo.repair();
    // The logger serialises an Error passed under any key but err as {}, so the class and a short message are logged instead.
    })().catch(error => { app.log.error(error instanceof Error ? { errorType: error.name, message: loggable(error.message) } : { errorType: 'Unknown' }, 'Payment repair failed'); }).finally(() => { repairing = undefined; });
    return repairing;
  }
  // Apart from repair, so a model call of 20 seconds or more cannot hold up a capture or a webhook.
  function review() {
    reviewing ??= reviews.repair().catch(error => { app.log.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Price review failed'); }).finally(() => { reviewing = undefined; });
  }
  app.addHook('onReady', async () => {
    await options.db.query("update checkouts set state='checking' where state='capturing'");
    repairing = (async () => {
      await processor.repair();
      await demo.repair().catch(error => { app.log.error({ error: error instanceof Error ? error.message : 'Unknown' }, 'Demo repair failed'); });
    })().finally(() => { repairing = undefined; });
    // Fast repairs seed the demo before serving; slow repairs must not exhaust Fastify's readiness deadline.
    // Keep the unfinished work tracked so timer ticks cannot overlap it and shutdown drains it.
    let startupDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        repairing,
        new Promise<void>(resolve => { startupDeadline = setTimeout(resolve, 1000); }),
      ]);
    } finally {
      clearTimeout(startupDeadline);
    }
    repairTimer = setInterval(() => { void repair(); review(); }, 30_000);
    repairTimer.unref();
  });
  app.addHook('preClose', async () => { clearInterval(repairTimer); await repairing; await reviewing; });

  app.addHook('onSend', async (_request, reply, payload) => {
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'strict-origin-when-cross-origin');
      reply.header('x-frame-options', 'SAMEORIGIN');
    }
    return payload;
  });

  // Postgres refuses a NUL byte in a text parameter, so a tag code carrying one would come back as a 500 rather than an unknown tag.
  app.addHook('preValidation', async (request, reply) => {
    const code = (request.params as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && code.includes('\0')) return reply.code(404).send({ error: 'That tag is not on this stall.' });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PayPalError) {
      request.log.error({ status: error.status, debugId: error.debugId, issue: error.issue, operation: error.operation }, 'PayPal request failed');
      return reply.code(502).send({ error: 'PayPal could not complete this request. Check the PayPal activity before trying again.' });
    }
    const code = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    request.log.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Request failed');
    return reply.code(status).send({ error: status < 500 ? 'Invalid request.' : 'Unable to complete this request. Please try again later.' });
  });

  void app.register(cookie, { secret: config.sessionSecret });
  const model = options.model ?? (config.anthropicApiKey ? createAnthropic({ apiKey: config.anthropicApiKey, fetch: options.fetcher })('claude-sonnet-5-5') : undefined);
  const dailyCap = Number(config.aiDailyCapUsd || 3);
  const ledgerCap = Number(config.aiLedgerDailyCapUsd || 1);
  if (!Number.isFinite(ledgerCap) || ledgerCap < 0) throw new Error('AI_LEDGER_DAILY_CAP_USD must be a non-negative number');
  // Built per check, so a start without PayPal credentials still serves everything else, and a check never reuses the token the toolkit caches without expiry.
  const closing = {
    summaries: summaryService({ db: options.db, model, dailyCap, now: options.now ?? (() => new Date()) }),
    toolkit: () => options.toolkit ?? installedToolkit(config.clientId, config.clientSecret),
  };
  const reviews = priceReviewService({ db: options.db, model, dailyCap, now: options.now ?? (() => new Date()), notify: updates.notify, log: errorType => { app.log.warn({ errorType }, 'Price review model call failed'); } });
  void app.register(ownerRoutes, { config, db: options.db, storage, retail, updates, demo, newItems, reviews, recheck: recovery.recheck, closing, ledger: { model, dailyCap, ledgerCap, licenceKey: config.agStudioLicenceKey, toolkit: closing.toolkit }, now: options.now ?? (() => new Date()) });
  const chat = chatService({ db: options.db, model, retail, dailyCap, now: options.now ?? (() => new Date()), notify: updates.notify });
  void app.register(buyerRoutes, { db: options.db, retail, production: config.production, now: options.now ?? (() => new Date()), chat });
  void app.register(chat.register);
  void app.register(offerRoutes, { db: options.db, now: options.now ?? (() => new Date()) });
  void app.register(photoPublicRoutes, { db: options.db, storage });
  void app.register(async scope => { await demoRoutes(scope, options.db, config); });
  app.get('/api/health', async () => ({ status: 'ok', commit: config.commit || 'unknown' }));
  app.get('/api/config', async () => ({ clientId: config.clientId, donateButtonId: config.donateButtonId || null }));
  void app.register(checkoutRoutes, { db: options.db, paypal, notify: updates.notify, now: options.now ?? (() => new Date()) });
  void app.register(freeRoutes, { db: options.db, notify: updates.notify, now: options.now ?? (() => new Date()) });
  void app.register(async webhooks => {
    webhooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => { done(null, body); });
    webhooks.post('/api/webhooks/paypal', async (request, reply) => {
      if (!config.webhookId) return reply.code(503).send({ error: 'Webhook is not configured.' });
      const rawEvent = request.body;
      const event = typeof rawEvent === 'string' ? parseEvent(rawEvent) : null;
      const names = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
      const headers: Record<string, string> = {};
      for (const name of names) {
        const value = request.headers[name];
        if (typeof value !== 'string' || !value.trim()) return reply.code(400).send({ error: 'Malformed webhook headers.' });
        headers[name] = value;
      }
      if (typeof rawEvent !== 'string' || !event || Array.isArray(event) || typeof event.id !== 'string' || !event.id || typeof event.event_type !== 'string' || !event.event_type || !event.resource || typeof event.resource !== 'object') {
        return reply.code(400).send({ error: 'Malformed webhook event.' });
      }
      if (!await paypal.verifyWebhook(rawEvent, headers, config.webhookId)) return reply.code(400).send({ error: 'Webhook verification failed.' });
      await options.db.query('insert into webhook_inbox(event_id,event_type,raw_body,next_attempt_at) values ($1,$2,$3,$4) on conflict(event_id) do nothing', [event.id, event.event_type, rawEvent, (options.now ?? (() => new Date()))()]);
      await processor.process(event.id);
      return { received: true };
    });
  });

  // Only mount the web app when a build exists, so API-only runs and tests need no web build.
  const webDist = config.webDist && existsSync(join(config.webDist, 'index.html')) ? config.webDist : undefined;
  if (webDist) void app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/') || request.url.startsWith('/api?');
    const isPageRequest = request.method === 'GET' || request.method === 'HEAD';
    // Unknown /api paths must stay JSON so clients never parse the web app's HTML as an API answer.
    // A missing build file is a 404 too, so a script or stylesheet request is never handed the web app.
    const isAsset = request.url.startsWith('/assets/');
    if (webDist && !isApi && !isAsset && isPageRequest) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found.' });
  });
  return app;
}
