import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buyerId, takenByAnother, transaction } from './checkouts.js';

const THANK_YOU_MAX_CHARACTERS = 280;
export interface Take { takenAt: Date; message: string | null }

// The message is a stranger's text that the owner reads. Whitespace runs become one space, so it stays one line, and control
// and bidirectional override characters are dropped, because the first can break the database and the second can reorder
// what the owner reads. Blank means no message. Anything left is shown as text and never sent to a model.
const stripped = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;
export function cleanMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replaceAll(/\s+/gu, ' ').replaceAll(stripped, '').trim();
  return text || null;
}

export async function takeFor(db: Pick<Pool, 'query'>, buyer: string | undefined, itemId: string): Promise<Take | null> {
  if (!buyer) return null;
  const row = (await db.query<{ taken_at: Date; message: string | null }>('select taken_at,message from free_takes where item_id=$1 and buyer_session_id=$2', [itemId, buyer])).rows[0];
  return row ? { takenAt: row.taken_at, message: row.message } : null;
}

const messageBody = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', maxLength: THANK_YOU_MAX_CHARACTERS } } };
const closed = 'This stall is closed. Please leave the item here.';

// A free item is taken with no PayPal step. The take is its own record and the only buyer action that ends the item's time on sale,
// so a tip, which is a separate checkout that can only start afterwards, can never lose or strand it.
export async function freeRoutes(app: FastifyInstance, { db, now, notify }: { db: Pool; now: () => Date; notify: (stallId: string) => void }) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.post<{ Params: { code: string } }>('/api/i/:code/take', async (request, reply) => {
    const buyer = await buyerId(db, request);
    if (!buyer) return reply.code(401).send({ error: 'Open the item page before taking it.' });
    const found = (await db.query<{ id: string; stall_id: string }>("select id,stall_id from items where code=$1 and mode='free'", [request.params.code.toUpperCase()])).rows[0];
    if (!found) return reply.code(404).send({ error: 'This item is not free to take.' });
    const result = await transaction(db, async tx => {
      // The session lock comes first, as it does for a checkout, so a take and a close or a reservation never interleave.
      const session = (await tx.query<{ id: string; status: string }>("select id,status from trading_sessions where stall_id=$1 and status <> 'closed' for update", [found.stall_id])).rows[0];
      const item = (await tx.query<{ status: string; mode: string; reserved_checkout_id: string | null }>('select status,mode,reserved_checkout_id from items where id=$1 for update', [found.id])).rows[0]!;
      const mine = await takeFor(tx, buyer, found.id);
      if (mine) return { take: mine, created: false };
      if (item.status === 'sold') return { error: takenByAnother };
      if (item.status === 'removed') return { error: 'This item is no longer for sale. Please leave it here.' };
      // The mode was read before this lock, and an owner edit can have moved the item out of free since.
      if (item.mode !== 'free') return { error: 'This item is not free to take.' };
      if (!session || session.status !== 'open' || item.reserved_checkout_id) return { error: closed };
      const time = now();
      await tx.query('insert into free_takes (item_id,stall_id,trading_session_id,buyer_session_id,taken_at) values ($1,$2,$3,$4,$5)', [found.id, found.stall_id, session.id, buyer, time]);
      await tx.query("update items set status='sold', sold_at=$2 where id=$1", [found.id, time]);
      return { take: { takenAt: time, message: null } as Take, created: true };
    });
    if ('error' in result) return reply.code(409).send({ error: result.error });
    if (result.created) notify(found.stall_id);
    return reply.code(result.created ? 201 : 200).send({ take: result.take });
  });

  // The thank-you message comes after the take, on the same screen as the tip, so it is set once on the buyer's own take.
  // Like a tip, it needs the take's own trading session to still be open, so nothing changes a closed session's report.
  app.post<{ Params: { code: string }; Body: { message: string } }>('/api/i/:code/take/message', { schema: { body: messageBody } }, async (request, reply) => {
    const buyer = await buyerId(db, request);
    if (!buyer) return reply.code(401).send({ error: 'Open the item page before leaving a message.' });
    const message = cleanMessage(request.body.message);
    if (!message) return reply.code(400).send({ error: 'Write a message first.' });
    type Outcome = { status: number; error: string } | { take: Take; stallId: string | null };
    const result = await transaction(db, async (tx): Promise<Outcome> => {
      const take = (await tx.query<{ id: string; item_id: string; stall_id: string; trading_session_id: string }>(`select f.id,f.item_id,f.stall_id,f.trading_session_id from free_takes f join items i on i.id=f.item_id
        where i.code=$1 and f.buyer_session_id=$2`, [request.params.code.toUpperCase(), buyer])).rows[0];
      if (!take) return { status: 404, error: 'Take the item first, then you can leave a message.' };
      // The session lock comes first, as it does for a take, so a message and a close never interleave.
      const session = (await tx.query<{ status: string }>('select status from trading_sessions where id=$1 for update', [take.trading_session_id])).rows[0];
      if (session?.status !== 'open') return { status: 409, error: 'This stall has closed, so messages are no longer taken.' };
      const row = (await tx.query<{ taken_at: Date; message: string }>('update free_takes set message=$2 where id=$1 and message is null returning taken_at,message', [take.id, message])).rows[0];
      if (row) return { take: { takenAt: row.taken_at, message: row.message }, stallId: take.stall_id };
      // A repeat of the same message, such as a retry after a timeout, gets the stored take back. A different one is refused.
      const stored = (await takeFor(tx, buyer, take.item_id))!;
      return stored.message === message ? { take: stored, stallId: null } : { status: 409, error: 'Your message is already with the stallholder.' };
    });
    if ('error' in result) return reply.code(result.status).send({ error: result.error });
    if (result.stallId) notify(result.stallId);
    return reply.send({ take: result.take });
  });
}
