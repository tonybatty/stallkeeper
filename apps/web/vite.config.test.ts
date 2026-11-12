import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from './vite.config';

describe('dev proxy target', () => {
  const startDir = process.cwd();
  let repoRoot: string;

  beforeEach(() => {
    vi.stubEnv('PORT', undefined);
    repoRoot = mkdtempSync(join(tmpdir(), 'stallkeeper-vite-'));
    const webDir = join(repoRoot, 'apps', 'web');
    mkdirSync(webDir, { recursive: true });
    process.chdir(webDir);
  });

  afterEach(() => {
    process.chdir(startDir);
    rmSync(repoRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const apiProxyTarget = () => config({ command: 'serve', mode: 'development' }).server?.proxy?.['/api'];

  it('follows PORT from the root .env', () => {
    writeFileSync(join(repoRoot, '.env'), 'PORT=3001\n');
    expect(apiProxyTarget()).toBe('http://localhost:3001');
  });

  it('follows an exported PORT over the root .env, as the API does', () => {
    writeFileSync(join(repoRoot, '.env'), 'PORT=3001\n');
    vi.stubEnv('PORT', '3002');
    expect(apiProxyTarget()).toBe('http://localhost:3002');
  });

  it('defaults to 3000 when PORT is blank, as in the env example', () => {
    writeFileSync(join(repoRoot, '.env'), 'PORT=\n');
    expect(apiProxyTarget()).toBe('http://localhost:3000');
  });

  it('defaults to 3000 without a root .env', () => {
    expect(apiProxyTarget()).toBe('http://localhost:3000');
  });
});
