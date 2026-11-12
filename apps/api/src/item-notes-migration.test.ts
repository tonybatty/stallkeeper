import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { emptyDatabase } from '../test/database.js';
import { migrationsDir, runMigrations } from './db.js';

const db = emptyDatabase();

it("keeps each existing item's condition and notes as one notes field", async () => {
  const merge = '0017_item_notes_merge.sql';
  const earlier = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql') && name < merge);
  const dir = await mkdtemp(join(tmpdir(), 'stallkeeper-migrations-'));
  for (const name of earlier) await writeFile(join(dir, name), await readFile(join(migrationsDir, name), 'utf8'));
  await runMigrations(db, dir);
  const stall = (await db.query<{ id: string }>('select id from stalls limit 1')).rows[0]!.id;
  const rows = [['AAAA', 'Tested, it works.', 'Small scuff.'], ['BBBB', 'Not tested', 'Shutter clicks.'], ['CCCC', 'Good condition!', ''], ['DDDD', 'Used', '']];
  for (const [code, condition, notes] of rows) await db.query("insert into items (stall_id, code, name, condition, notes, mode, asking_pence) values ($1,$2,'Thing',$3,$4,'fixed',100)", [stall, code, condition, notes]);
  await runMigrations(db, migrationsDir);
  const merged = (await db.query<{ code: string; notes: string }>('select code, notes from items order by code')).rows;
  expect(merged).toEqual([
    { code: 'AAAA', notes: 'Tested, it works. Small scuff.' },
    { code: 'BBBB', notes: 'Not tested. Shutter clicks.' },
    { code: 'CCCC', notes: 'Good condition!' },
    { code: 'DDDD', notes: 'Used' },
  ]);
  expect((await db.query("select 1 from information_schema.columns where table_name = 'items' and column_name = 'condition'")).rowCount).toBe(0);
});
