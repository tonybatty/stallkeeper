import { spawn } from 'node:child_process';
import type { AppiumSession } from './appium.ts';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Starts `simctl io recordVideo`. The returned function stops it and resolves once the MP4 is finalised. */
export function record(udid: string, path: string) {
  const recorder = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', path], { stdio: 'ignore' });
  return () => new Promise<void>((resolve, reject) => {
    recorder.once('exit', code => { if (code === 0) resolve(); else reject(new Error(`recordVideo exited with ${code}`)); });
    // Any other signal leaves the MP4 without its index, and it will not play.
    recorder.kill('SIGINT');
  });
}

export async function waitFor<T>(what: string, attempt: () => Promise<T | undefined>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

// On the first load after a simulator is erased, a tap can report success and do nothing,
// though the button has not moved. The cause is unknown. Repeating is safe: the page ignores
// taps once checkout has started.
export async function tapUntilPayPalOpens(session: AppiumSession, button: string, before: string[]) {
  for (let taps = 1; taps <= 5; taps++) {
    await session.click(button);
    const paypalContext = await waitFor('the PayPal tab', async () => {
      const added = (await session.contexts()).filter(context => !before.includes(context));
      return added[0];
    }, 3_000).catch(() => undefined);
    if (paypalContext) return { paypalContext, taps };
  }
  throw new Error('The PayPal tab did not open after 5 taps');
}
