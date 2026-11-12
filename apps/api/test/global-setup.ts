import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext { adminDatabaseUrl: string }
}

// A free port, so test runs in parallel checkouts don't collide.
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => { if (address && typeof address === 'object') resolve(address.port); else reject(new Error('No port assigned')); });
    });
  });
}

export default async function setup(project: TestProject) {
  const databaseDir = await mkdtemp(join(tmpdir(), 'stallkeeper-test-'));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => undefined });
  await postgres.initialise();
  await postgres.start();
  project.provide('adminDatabaseUrl', `postgres://postgres:postgres@localhost:${port}/postgres`);
  return () => postgres.stop();
}
