import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { migrationsDir, runMigrations } from '../src/db.js';

async function asAdmin(sql: string) {
  const admin = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  try { await admin.query(sql); } finally { await admin.end(); }
}

export function emptyDatabase() {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(inject('adminDatabaseUrl'));
  url.pathname = `/${name}`;
  const db = new pg.Pool({ connectionString: url.href });
  beforeAll(() => asAdmin(`create database ${name}`));
  afterAll(async () => {
    await db.end();
    await asAdmin(`drop database ${name}`);
  });
  return db;
}

// Call once at the top of a test file: that file gets its own migrated database.
export function testDatabase() {
  const db = emptyDatabase();
  beforeAll(() => runMigrations(db, migrationsDir));
  return db;
}
