import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export class SupabasePhotoStorage {
  constructor(private readonly url: string, private readonly serviceKey: string, private readonly fetcher: typeof fetch = fetch) {}
  private async request(key: string, bytes?: Buffer) {
    const response = await this.fetcher(new URL(`/storage/v1/object/item-photos/${key}`, this.url), {
      method: bytes ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, 'content-type': 'image/jpeg' },
      body: bytes ? new Uint8Array(bytes) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Photo storage request failed: ${response.status}`);
    return response;
  }
  async put(key: string, bytes: Buffer) { await this.request(key, bytes); }
  async get(key: string) { return Buffer.from(await (await this.request(key)).arrayBuffer()); }
}

export function isJpeg(bytes: unknown): bytes is Buffer {
  return Buffer.isBuffer(bytes) && bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

export async function photoOwnerRoutes(app: FastifyInstance, db: Pool, storage?: SupabasePhotoStorage) {
  app.post<{ Params: { id: string }; Body: Buffer }>('/api/owner/items/:id/photo', {
    bodyLimit: 512 * 1024,
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } },
  }, async (request, reply) => {
    const item = (await db.query<{ code: string; is_demo: boolean }>('select i.code, s.is_demo from items i join stalls s on s.id=i.stall_id where i.id=$1 and i.stall_id=$2', [request.params.id, request.stallId])).rows[0];
    if (!item) return reply.code(404).send({ error: 'Item not found.' });
    if (item.is_demo) return reply.code(403).send({ error: 'Photos are turned off for this stall. Your item details are saved.' });
    const bytes = request.body;
    if (!isJpeg(bytes)) {
      return reply.code(400).send({ error: 'Choose a JPEG photo.' });
    }
    if (!storage) return reply.code(503).send({ error: 'Photos are unavailable. You can still save item details.' });
    const key = `${request.stallId}/${request.params.id}/${randomUUID()}.jpg`;
    try {
      await storage.put(key, bytes);
      await db.query('update items set photo_key=$3 where id=$1 and stall_id=$2', [request.params.id, request.stallId, key]);
      return { photoUrl: `/api/i/${item.code}/photo` };
    } catch (error) {
      request.log.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Photo upload failed');
      return reply.code(502).send({ error: 'Photo was not added. Your item details are saved.' });
    }
  });
}

export async function photoPublicRoutes(app: FastifyInstance, { db, storage }: { db: Pool; storage?: SupabasePhotoStorage }) {
  app.get<{ Params: { code: string } }>('/api/i/:code/photo', async (request, reply) => {
    const item = (await db.query<{ photo_key: string | null }>('select photo_key from items where code=$1', [request.params.code.toUpperCase()])).rows[0];
    if (!item?.photo_key || !storage) return reply.code(404).send({ error: 'Photo unavailable.' });
    try {
      const bytes = await storage.get(item.photo_key);
      return reply.type('image/jpeg').header('x-content-type-options', 'nosniff').header('cache-control', 'no-store').send(bytes);
    } catch (error) {
      request.log.error({ errorType: error instanceof Error ? error.name : 'Unknown' }, 'Photo read failed');
      return reply.code(502).send({ error: 'Photo unavailable.' });
    }
  });
}
