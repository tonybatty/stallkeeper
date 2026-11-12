import { expect, it } from 'vitest';
import { testDatabase } from '../test/database.js';

const db = testDatabase();

// A migration only covers the tables that exist when it runs, so this fails for any later table left without it.
it('turns on row-level security, unforced, for every table in public', async () => {
  const { rows } = await db.query<{ relname: string }>(
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and (not c.relrowsecurity or c.relforcerowsecurity) order by 1");
  expect(rows.map(row => row.relname)).toEqual([]);
});

it('gives a role with table grants no rows and no writes, while the owning role keeps working', async () => {
  const probe = `rls_probe_${process.pid}`;
  const client = await db.connect();
  try {
    await client.query('begin');
    // Stands in for the Data API's anon role, which Supabase grants every privilege on new public tables.
    await client.query(`create role ${probe} nologin`);
    await client.query(`grant usage on schema public to ${probe}`);
    await client.query(`grant all on all tables in schema public to ${probe}`);
    await client.query(`set local role ${probe}`);
    expect((await client.query<{ n: number }>('select count(*)::int as n from stalls')).rows[0].n).toBe(0);
    expect((await client.query<{ n: number }>('select count(*)::int as n from item_floors')).rows[0].n).toBe(0);
    await client.query('savepoint write');
    await expect(client.query("insert into stalls (name, location_label, is_demo) values ('x', 'x', false)")).rejects.toThrow(/row-level security/);
    await client.query('rollback to savepoint write');
    // The service connects as the tables' owner, not a superuser, and an owner bypasses unforced row-level security.
    await client.query('reset role');
    await client.query(`alter table stalls owner to ${probe}`);
    await client.query(`set local role ${probe}`);
    expect((await client.query<{ n: number }>('select count(*)::int as n from stalls')).rows[0].n).toBeGreaterThan(0);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
