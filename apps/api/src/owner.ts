import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { photoOwnerRoutes, type SupabasePhotoStorage } from './photos.js';
import { feedRoutes, type feedUpdates } from './feed.js';
import { closingRoutes } from './closing.js';
import { charityRoutes } from './charity.js';
import { ledgerRoutes } from './ledger.js';
import { ledgerJourneyRoutes } from './ledger-journeys.js';
import type { demoStall } from './demo.js';
import { stockOwnerRoutes, type newItemLimit } from './items.js';
import { retailOwnerRoutes, type RetailService } from './retail.js';
import type { priceReviewService } from './price-review.js';
import { hourlyLimit } from './hourly-limit.js';

const COOKIE = 'stallkeeper_owner';
const COOKIE_PATH = '/api/owner';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const RESETS_PER_HOUR = 120;

declare module 'fastify' {
  interface FastifyRequest { stallId: string }
}

// Hashing first gives timingSafeEqual equal lengths, so a guess can't learn the password's length.
function matches(candidate: string, password: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(password));
}

// One customer commonly holds a whole /64, so the full address would give a client a fresh throttle bucket per address.
// The URL parser normalises case, leading zeros and a dotted tail, which leaves only the :: to expand.
function ipv6Network(address: string) {
  const [head = '', tail = ''] = new URL(`http://[${address}]`).hostname.slice(1, -1).split('::');
  const before = head.split(':').filter(Boolean);
  const after = tail.split(':').filter(Boolean);
  return [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after].slice(0, 4).join(':');
}

export async function ownerRoutes(app: FastifyInstance, { config, db, now, storage, retail, updates, demo, newItems, reviews, recheck, closing, ledger }: {
  config: { ownerPassword: string; demoOwnerPassword: string; production: boolean; publicBaseUrl: string; donateButtonId?: string };
  db: Pool; storage?: SupabasePhotoStorage; retail: RetailService;
  demo: ReturnType<typeof demoStall>;
  newItems: ReturnType<typeof newItemLimit>;
  reviews: ReturnType<typeof priceReviewService>;
  updates: ReturnType<typeof feedUpdates>;
  now: () => Date;
  recheck: (checkoutId: string) => Promise<boolean>;
  closing: Parameters<typeof closingRoutes>[4];
  ledger: Parameters<typeof ledgerRoutes>[3];
}) {
  // In memory because the service runs as one instance (ADR 0007).
  const failures = new Map<string, { count: number; resetAt: number }>();

  // Cloudflare documents CF-Connecting-IP as the visitor address
  // (https://developers.cloudflare.com/fundamentals/reference/http-request-headers/#cf-connecting-ip). Render documents
  // that a service is not directly reachable and that its load balancer forwards requests
  // (https://render.com/docs/web-services), but not its hop count, so that cannot be relied on to stay fixed.
  // Assumed, not sourced: request.ip is a shared Cloudflare edge address, every request passes through Cloudflare, and
  // Cloudflare replaces a CF-Connecting-IP the client sent. Without the header, or with a value that is not an address,
  // the fallback is request.ip, which a client cannot choose.
  function clientAddress(request: FastifyRequest) {
    const header = request.headers['cf-connecting-ip'];
    if (!config.production || typeof header !== 'string' || !isIP(header)) return request.ip;
    // isIP detects the address family, because only IPv6 is cut down to its network.
    return isIP(header) === 6 ? ipv6Network(header) : header;
  }

  function recordFailure(ip: string, time: number) {
    for (const [key, entry] of failures) if (entry.resetAt <= time) failures.delete(key);
    const entry = failures.get(ip) ?? { count: 0, resetAt: time + FAILURE_WINDOW_MS };
    failures.set(ip, { ...entry, count: entry.count + 1 });
  }

  app.post<{ Body: { password: string } }>('/api/owner/login', {
    schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (request, reply) => {
    const time = now().getTime();
    const { password } = request.body;
    // Both comparisons run before the throttle check, so a locked address cannot tell from timing which password it hit.
    const opensMain = matches(password, config.ownerPassword);
    const opensDemo = matches(password, config.demoOwnerPassword);
    // The demo password is printed on /demo, so throttling it protects nothing and would lock judges out. Only the
    // main stall's password is kept behind the throttle. A password that also opened the main stall gets no bypass.
    const publishedDemo = opensDemo && !opensMain;
    const throttled = failures.get(clientAddress(request));
    if (!publishedDemo && throttled && throttled.count >= MAX_FAILURES && throttled.resetAt > time) {
      return reply.code(429).header('retry-after', Math.ceil((throttled.resetAt - time) / 1000)).send({ error: 'Too many tries. Wait a few minutes and try again.' });
    }
    if (!opensMain && !opensDemo) {
      recordFailure(clientAddress(request), time);
      return reply.code(401).send({ error: 'That password does not open a stall.' });
    }
    const { rows } = await db.query<{ id: string; name: string }>('select id, name from stalls where is_demo = $1', [!opensMain]);
    const stall = rows[0];
    if (!stall) throw new Error('Stall row is missing');
    // The expiry sits inside the signed value because a client can replay a cookie past its Max-Age.
    const expiresAt = time + SESSION_SECONDS * 1000;
    reply.setCookie(COOKIE, `${stall.id}.${expiresAt}`, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: config.production, path: COOKIE_PATH, maxAge: SESSION_SECONDS,
    });
    return { name: stall.name };
  });

  app.post('/api/owner/logout', async (_request, reply) => {
    return reply.clearCookie(COOKIE, { path: COOKIE_PATH }).code(204).send();
  });

  function cookieStallId(request: FastifyRequest) {
    const raw = request.cookies[COOKIE];
    if (!raw) return;
    const { valid, value } = request.unsignCookie(raw);
    if (!valid) return;
    const [stallId, expiresAt] = value.split('.');
    return stallId && Number(expiresAt) > now().getTime() ? stallId : undefined;
  }

  // A reset takes fourteen tag codes that are never reused, from 31^4 in all, and the demo owner password is public.
  const resets = hourlyLimit(RESETS_PER_HOUR, now);

  const unauthorised = (reply: FastifyReply) => reply.code(401).send({ error: 'Log in to continue.' });

  // Every owner route goes in this scope, so the stall can only come from the signed cookie.
  await app.register(async owner => {
    owner.decorateRequest('stallId', '');
    owner.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));
    owner.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const stallId = cookieStallId(request);
      if (!stallId) return unauthorised(reply);
      request.stallId = stallId;
    });

    await photoOwnerRoutes(owner, db, storage);
    await closingRoutes(owner, db, now, updates.notify, closing);
    await charityRoutes(owner, db, now, updates.notify, !!config.donateButtonId);
    await ledgerRoutes(owner, db, now, ledger);
    await ledgerJourneyRoutes(owner, db);
    owner.post('/api/owner/demo/reset', async (request, reply) => {
      if (!resets.allow(request.stallId)) return reply.code(429).send({ error: 'This stall has been reset many times this hour. Try again later.' });
      let result: Awaited<ReturnType<typeof demo.reset>> | undefined;
      try {
        result = await demo.reset(request.stallId);
      } finally {
        if (result !== 'reset') resets.giveBack(request.stallId);
      }
      if (result === 'forbidden') return reply.code(403).send({ error: 'Log in with the owner password to reset this stall.' });
      if (result === 'busy') return reply.code(409).send({ error: 'A payment is in progress. Try the reset again when it has finished.' });
      return { reset: true };
    });

    owner.post('/api/owner/demo/price-review', async (request, reply) => {
      const result = await reviews.runNow(request.stallId);
      if (result === 'forbidden') return reply.code(403).send({ error: 'This control is not available on this stall.' });
      if (result === 'closed') return reply.code(409).send({ error: 'Open the stall first.' });
      if (result === 'used') return reply.code(409).send({ error: 'This trading session has had both its price reviews. Reset the stall to try again.' });
      if (result === 'busy') return reply.code(409).send({ error: 'A price review is already running.' });
      return result;
    });
    owner.put<{ Body: { closingTime: string | null } }>('/api/owner/stall/closing-time', {
      schema: { body: { type: 'object', additionalProperties: false, required: ['closingTime'], properties: { closingTime: { anyOf: [{ type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }, { type: 'null' }] } } } },
    }, async request => {
      await db.query('update stalls set closing_time=$2 where id=$1', [request.stallId, request.body.closingTime]);
      return { closingTime: request.body.closingTime };
    });

    await feedRoutes(owner, db, updates, now);
    await retailOwnerRoutes(owner, retail);
    await stockOwnerRoutes(owner, db, config.publicBaseUrl, now, updates.notify, retail, newItems);

    owner.post<{ Params: { id: string } }>('/api/owner/checkouts/:id/recheck', {
      schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
    }, async (request, reply) => {
      const checkout = (await db.query<{ review_required: boolean }>('select review_required from checkouts where id=$1 and stall_id=$2', [request.params.id, request.stallId])).rows[0];
      if (!checkout) return reply.code(404).send({ error: 'Checkout not found.' });
      if (!checkout.review_required) return reply.code(409).send({ error: 'This payment does not need review.' });
      if (!await recheck(request.params.id)) return reply.code(502).send({ error: 'Unable to read this payment from PayPal. Please try again shortly.' });
      return { checked: true };
    });

    owner.get('/api/owner/stall', async (request, reply) => {
      const { rows } = await db.query<{ name: string; closing_time: string | null; is_demo: boolean }>('select name,closing_time,is_demo from stalls where id = $1', [request.stallId]);
      const stall = rows[0];
      return stall ? { name: stall.name, closingTime: stall.closing_time, demo: stall.is_demo } : unauthorised(reply);
    });
  });
}
