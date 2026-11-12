import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testDatabase } from '../test/database.js';
import { buildApp } from './app.js';

const db = testDatabase();
const config = { clientId: 'test', clientSecret: 'test', ownerPassword: 'owner', demoOwnerPassword: 'demo', sessionSecret: 'secret', production: false, publicBaseUrl: 'http://localhost:5173', supabaseUrl: 'https://storage.example', supabaseServiceRoleKey: 'test-service-key' };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const lamp = { name: 'Lamp', notes: 'Not tested', mode: 'fixed', askingPence: 2800 };
function fakeSupabase() {
  const bucket = new Map<string, Buffer>();
  const state = { down: false };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (state.down) return new Response(null, { status: 503 });
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') { bucket.set(path, Buffer.from(init.body as Uint8Array)); return Response.json({ Key: path }); }
    const bytes = bucket.get(path);
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  });
  return { bucket, fetcher, state };
}
let app: ReturnType<typeof buildApp>;
let owner: Record<string, string>;
let demo: Record<string, string>;
let item: { id: string; code: string };
let supabase: ReturnType<typeof fakeSupabase>;
beforeEach(async () => {
  supabase = fakeSupabase(); app = buildApp(config, { db, fetcher: supabase.fetcher });
  const login = async (password: string) => ({ stallkeeper_owner: (await app.inject({ method: 'POST', url: '/api/owner/login', payload: { password } })).cookies[0]!.value });
  owner = await login('owner'); demo = await login('demo');
  item = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: owner, payload: lamp })).json();
});
afterEach(async () => { await app.close(); });
const upload = (payload = jpeg, cookies = owner, contentType = 'image/jpeg', id = item.id) => app.inject({ method: 'POST', url: `/api/owner/items/${id}/photo`, cookies, headers: { 'content-type': contentType }, payload });
it('keeps photos optional and round-trips a stall-scoped upload through the public API', async () => {
  expect((await app.inject(`/api/i/${item.code}`)).json().item.photoUrl).toBeNull();
  expect((await upload(jpeg, {})).statusCode).toBe(401);
  expect((await upload(jpeg, demo)).statusCode).toBe(404);
  expect(supabase.bucket.size).toBe(0);
  expect((await upload()).statusCode).toBe(200);
  const buyer = await app.inject(`/api/i/${item.code}`);
  expect(buyer.json().item.photoUrl).toBe(`/api/i/${item.code}/photo`);
  expect(buyer.body).not.toContain('photo_key');
  const photo = await app.inject(buyer.json().item.photoUrl);
  expect(photo.rawPayload).toEqual(jpeg);
  expect(photo.headers['content-type']).toBe('image/jpeg');
  expect(photo.headers['x-content-type-options']).toBe('nosniff');
  expect((await app.inject({ url: '/api/owner/items', cookies: owner })).json().items.find((row: { id: string }) => row.id === item.id).photoUrl).toBe(buyer.json().item.photoUrl);
});
it('rejects oversized and non-JPEG requests without touching storage', async () => {
  expect((await upload(Buffer.alloc(512 * 1024 + 1))).statusCode).toBe(413);
  expect((await upload(Buffer.from('<svg/>'))).statusCode).toBe(400);
  expect((await upload(jpeg, owner, 'image/svg+xml')).statusCode).toBe(415);
  expect(supabase.fetcher).not.toHaveBeenCalled();
});
it('leaves the old photo and editable item intact after a storage failure', async () => {
  await upload();
  supabase.state.down = true;
  expect((await upload()).statusCode).toBe(502);
  const unreadable = await app.inject(`/api/i/${item.code}/photo`);
  expect(unreadable.statusCode).toBe(502);
  expect(unreadable.json().error).toBe('Photo unavailable.');
  supabase.state.down = false;
  expect(supabase.bucket.size).toBe(1);
  expect((await app.inject(`/api/i/${item.code}/photo`)).rawPayload).toEqual(jpeg);
  const saved = await app.inject({ method: 'PATCH', url: `/api/owner/items/${item.id}`, cookies: owner, payload: { notes: 'Still saveable' } });
  expect(saved.statusCode).toBe(200); expect(saved.json().notes).toBe('Still saveable');
});
it('refuses demo stall uploads with an owner-facing message and leaves the item photo-free', async () => {
  const demoItem = (await app.inject({ method: 'POST', url: '/api/owner/items', cookies: demo, payload: lamp })).json();
  const refused = await upload(jpeg, demo, 'image/jpeg', demoItem.id);
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error).toBe('Photos are turned off for this stall. Your item details are saved.');
  expect(supabase.fetcher).not.toHaveBeenCalled();
  expect((await app.inject(`/api/i/${demoItem.code}`)).json().item.photoUrl).toBeNull();
});
it('sends uploads to Supabase Storage with the server credentials', async () => {
  expect((await upload()).statusCode).toBe(200);
  const [url, init] = supabase.fetcher.mock.calls[0]!;
  expect(String(url)).toMatch(new RegExp(`^https://storage.example/storage/v1/object/item-photos/[^/]+/${item.id}/[^/]+\\.jpg$`));
  expect(init?.headers).toMatchObject({ authorization: 'Bearer test-service-key', apikey: 'test-service-key', 'content-type': 'image/jpeg' });
  expect(Buffer.from(init?.body as Uint8Array)).toEqual(jpeg);
});
