import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';

export const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_LOCK = 72540011;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Without these a query on a connection that has silently died never settles, and one such query stops the repair timer for good.
// All four act in this process, so nothing new is sent to the database or its pooler at connect time. Node leaves keep-alive to the
// system default otherwise, which is about two hours on Linux. No request query is expected to come near 30 seconds.
const limits = { connectionTimeoutMillis: 10_000, query_timeout: 30_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 };

export function poolOptions(connectionString: string): PoolConfig {
  if (LOCAL_HOSTS.has(new pg.Client({ connectionString }).host)) return { connectionString, ...limits };
  return { connectionString, ssl: { rejectUnauthorized: true }, ...limits };
}

// The pool listens for errors on idle clients only, so a connection that drops while a client is checked out would emit with
// no listener and end the process. The query in flight still rejects, so this listener has nothing else to do.
// 'connect' fires once for each new client, so a reused client never gains a second listener.
export function openPool(connectionString: string) {
  const pool = new pg.Pool(poolOptions(connectionString));
  pool.on('connect', client => { client.on('error', () => undefined); });
  return pool;
}

// One transaction, so a failed file leaves the database as it was and the next start retries it.
export async function runMigrations(db: Pool, dir: string) {
  const files = (await readdir(dir)).filter(file => file.endsWith('.sql')).sort();
  const client = await db.connect();
  try {
    await client.query('begin');
    // A migration may wait for the lock or run long, so the pool's 30-second limit does not apply here.
    const unhurried = { query_timeout: 30 * 60_000 };
    await client.query({ text: 'select pg_advisory_xact_lock($1)', values: [MIGRATION_LOCK], ...unhurried });
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const { rows } = await client.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(rows.map(row => row.name));
    for (const file of files.filter(name => !applied.has(name))) {
      await client.query({ text: await readFile(join(dir, file), 'utf8'), ...unhurried });
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
