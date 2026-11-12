import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOf, Stall } from './stall.ts';

const page = '<script src="/assets/index-Ab12.js"></script>';
function serve(health: Response | Error) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/health')) { if (health instanceof Error) throw health; return health; }
    return new Response(page);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('buildOf', () => {
  it('records the commit a hosted server reports, shortened, with the web bundle name', async () => {
    serve(Response.json({ status: 'ok', commit: '0123456789abcdef0123456789abcdef01234567' }));
    expect(await buildOf('https://stall.example', false)).toEqual({ commit: '0123456', web: 'index-Ab12.js' });
  });

  it('records unknown rather than the local checkout when a hosted server reports no commit', async () => {
    serve(Response.json({ status: 'ok' }));
    expect((await buildOf('https://stall.example', false)).commit).toBe('unknown');
    serve(Response.json({ status: 'ok', commit: 'unknown' }));
    expect((await buildOf('https://stall.example', false)).commit).toBe('unknown');
  });

  it('records the script commit on localhost, where the server reports none', async () => {
    serve(Response.json({ status: 'ok', commit: 'unknown' }));
    // The suite also has to pass in a copy with no git history, where there is no commit to record.
    let checkout = true;
    try { execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }); } catch { checkout = false; }
    expect((await buildOf('http://localhost:3000', true)).commit).toMatch(checkout ? /^[0-9a-f]{7,}(-dirty)?$/ : /^unknown$/);
  });

  it('records unknown when a hosted health check cannot be read', async () => {
    serve(new Error('offline'));
    expect((await buildOf('https://stall.example', false)).commit).toBe('unknown');
  });
});

describe('resetIdleDemo', () => {
  const haggle = (status: string) => ({ id: 'id', code: 'CODE', name: 'Lamp', status, mode: 'haggle', askingPence: 2800 });
  function serveStall(page: { items: unknown[]; sessionStatus: string }, resetStatus = 200) {
    const resets = vi.fn(() => new Response('{}', { status: resetStatus }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/owner/demo/reset') ? resets() : Response.json(page)));
    return resets;
  }
  const stall = new Stall('https://stall.example');

  it.each(['closed', 'closing'])('resets a %s stall', async sessionStatus => {
    const resets = serveStall({ items: [haggle('available')], sessionStatus });
    await stall.resetIdleDemo();
    expect(resets).toHaveBeenCalledOnce();
  });

  it('resets an open stall with no available item that takes offers', async () => {
    const resets = serveStall({ items: [haggle('sold'), haggle('reserved'), { ...haggle('available'), mode: 'fixed' }], sessionStatus: 'open' });
    await stall.resetIdleDemo();
    expect(resets).toHaveBeenCalledOnce();
  });

  it('leaves an open stall that can take offers as it is', async () => {
    const resets = serveStall({ items: [haggle('sold'), haggle('available')], sessionStatus: 'open' });
    await stall.resetIdleDemo();
    expect(resets).not.toHaveBeenCalled();
  });

  it('carries on when the server refuses because this is the main stall', async () => {
    serveStall({ items: [], sessionStatus: 'closed' }, 403);
    await expect(stall.resetIdleDemo()).resolves.toBeUndefined();
  });

  it('stops the take when a payment holds the demo stall', async () => {
    serveStall({ items: [], sessionStatus: 'closed' }, 409);
    await expect(stall.resetIdleDemo()).rejects.toThrow('Demo reset failed: 409');
  });
});
