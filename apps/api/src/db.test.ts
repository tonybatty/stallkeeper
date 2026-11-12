import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, inject, it } from 'vitest';
import { emptyDatabase } from '../test/database.js';
import { migrationsDir, openPool, poolOptions, runMigrations } from './db.js';
import { transaction } from './checkouts.js';

const db = emptyDatabase();

async function migrations(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'stallkeeper-migrations-'));
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)));
  return dir;
}
const applied = async () => (await db.query<{ name: string }>('select name from schema_migrations order by applied_at, name')).rows.map(row => row.name);

it('applies files in name order, once each, and picks up new ones on the next start', async () => {
  // 0002 needs the table 0001 creates, so running out of order would fail.
  const dir = await migrations({
    '0002_row.sql': "insert into ordered (value) values ('second');",
    '0001_table.sql': 'create table ordered (value text);',
    'notes.txt': 'not sql',
  });
  await runMigrations(db, dir);
  await runMigrations(db, dir);
  expect((await db.query('select value from ordered')).rows).toEqual([{ value: 'second' }]);
  await writeFile(join(dir, '0003_row.sql'), "insert into ordered (value) values ('third');");
  await runMigrations(db, dir);
  expect((await db.query('select value from ordered order by value')).rows).toEqual([{ value: 'second' }, { value: 'third' }]);
  expect(await applied()).toEqual(['0001_table.sql', '0002_row.sql', '0003_row.sql']);
});

it('leaves nothing behind when a file fails', async () => {
  const before = await applied();
  const dir = await migrations({ '0001_good.sql': 'create table half_done (value text);', '0002_bad.sql': 'select from nowhere;' });
  await expect(runMigrations(db, dir)).rejects.toThrow();
  expect(await applied()).toEqual(before);
  expect((await db.query("select to_regclass('half_done') as found")).rows).toEqual([{ found: null }]);
});

it('seeds one main stall and one demo stall', async () => {
  await runMigrations(db, migrationsDir);
  const { rows } = await db.query('select is_demo from stalls order by is_demo');
  expect(rows).toEqual([{ is_demo: false }, { is_demo: true }]);
});

it('verifies TLS for any host that is not local, unless the URL says otherwise', () => {
  const resolvedSsl = (url: string) => new pg.Client(poolOptions(url)).ssl;
  const hosted = 'postgres://user:secret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres';
  expect(resolvedSsl(hosted)).toEqual({ rejectUnauthorized: true });
  expect(resolvedSsl('postgres://user:secret@localhost/postgres?host=db.example.com')).toEqual({ rejectUnauthorized: true });
  expect(resolvedSsl(`${hosted}?sslmode=no-verify`)).toEqual({ rejectUnauthorized: false });
  expect(resolvedSsl(`${hosted}?sslmode=disable`)).toBe(false);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(resolvedSsl(`postgres://postgres:postgres@${host}:54329/postgres`)).toBe(false);
});

it('gives local and hosted pools a connection timeout, a query timeout and keep-alive', () => {
  const limits = { connectionTimeoutMillis: 10_000, query_timeout: 30_000, keepAlive: true, keepAliveInitialDelayMillis: 10_000 };
  expect(poolOptions('postgres://postgres:postgres@localhost:54329/postgres')).toMatchObject(limits);
  expect(poolOptions('postgres://user:secret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres')).toMatchObject(limits);
});

it('keeps running when a checked-out connection drops mid-transaction, and serves the next query', async () => {
  const pool = openPool(inject('adminDatabaseUrl'));
  const uncaught: unknown[] = [];
  const record = (error: unknown) => { uncaught.push(error); };
  process.on('uncaughtException', record);
  try {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await client.query('begin');
    const sleeping = client.query('select pg_sleep(2)');
    await db.query('select pg_terminate_backend($1)', [pid]);
    await expect(sleeping).rejects.toThrow();
    // The dropped socket reports itself after the query has failed.
    await new Promise(resolve => setTimeout(resolve, 200));
    client.release(true);
    expect((await pool.query<{ one: number }>('select 1 as one')).rows).toEqual([{ one: 1 }]);
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener('uncaughtException', record);
    await pool.end();
  }
});

it('closes a client whose query timed out rather than handing it to the next caller', async () => {
  const pool = new pg.Pool({ connectionString: inject('adminDatabaseUrl'), max: 1, query_timeout: 200 });
  try {
    await expect(transaction(pool, tx => tx.query('select pg_sleep(10)'))).rejects.toThrow('Query read timeout');
    expect((await pool.query<{ one: number }>({ text: 'select 1 as one', query_timeout: 3_000 })).rows).toEqual([{ one: 1 }]);
  } finally { await pool.end(); }
});
