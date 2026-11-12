// `pnpm dev` entry. It fills in what a fresh clone lacks, then runs the normal server under watch.
// Postgres runs here, outside the watched process, so a file save restarts the API and leaves the database up.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 54329;
const env = { ...process.env };
env.PAYPAL_CLIENT_ID ||= 'not-configured';
env.PAYPAL_CLIENT_SECRET ||= 'not-configured';
env.SESSION_SECRET ||= 'local-development-only';
env.PUBLIC_BASE_URL ||= 'http://localhost:5173';
if (!env.OWNER_PASSWORD || !env.DEMO_OWNER_PASSWORD) console.log('Local owner passwords: `owner` opens the main stall, `demo` opens the demo stall, unless set in .env.');
env.OWNER_PASSWORD ||= 'owner';
env.DEMO_OWNER_PASSWORD ||= 'demo';

let postgres: EmbeddedPostgres | undefined;
if (!env.DATABASE_URL) {
  const databaseDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
  postgres = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port: PORT, persistent: true, onLog: () => undefined });
  if (!existsSync(join(databaseDir, 'PG_VERSION'))) await postgres.initialise();
  await postgres.start();
  env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PORT}/postgres`;
}

const api = spawn(process.execPath, ['./node_modules/tsx/dist/cli.mjs', 'watch', 'src/index.ts'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { api.kill(signal); });
api.once('exit', code => { void (postgres?.stop() ?? Promise.resolve()).then(() => process.exit(code ?? 0)); });
