// A small W3C WebDriver client for a local Appium server. Plain fetch keeps Appium's
// large dependency tree out of the workspace lockfile and out of CI.

type Json = Record<string, unknown>;

export const NATIVE = 'NATIVE_APP';

export type AppiumOptions = {
  server: string;
  udid: string;
  /** WebDriverAgent's port on the host. Each simulator needs its own. */
  wdaPort: number;
  /** Where WebDriverAgent is built. Parallel builds must not share one. */
  derivedDataPath: string;
  initialUrl: string;
};

export class AppiumSession {
  readonly base: string;

  private constructor(base: string) { this.base = base; }

  static async start(options: AppiumOptions) {
    const { sessionId } = await request<{ sessionId: string }>(`${options.server}/session`, 'POST', {
      capabilities: {
        alwaysMatch: {
          platformName: 'iOS',
          browserName: 'Safari',
          'appium:automationName': 'XCUITest',
          'appium:udid': options.udid,
          'appium:wdaLocalPort': options.wdaPort,
          'appium:mjpegServerPort': options.wdaPort + 1000,
          'appium:derivedDataPath': options.derivedDataPath,
          'appium:safariInitialUrl': options.initialUrl,
          'appium:wdaLaunchTimeout': 300_000,
          'appium:newCommandTimeout': 600,
        },
        firstMatch: [{}],
      },
    });
    return new AppiumSession(`${options.server}/session/${sessionId}`);
  }

  private command<T>(path: string, body?: Json) {
    return request<T>(`${this.base}${path}`, body ? 'POST' : 'GET', body);
  }

  quit() { return request(this.base, 'DELETE'); }
  url() { return this.command<string>('/url'); }
  context() { return this.command<string>('/context'); }
  contexts() { return this.command<string[]>('/contexts'); }
  setContext(name: string) { return this.command('/context', { name }); }
  execute<T>(script: string, args: unknown[] = []) { return this.command<T>('/execute/sync', { script, args }); }
  navigate(url: string) { return this.command('/url', { url }); }

  async findWeb(css: string) {
    const element = await this.command<Record<string, string>>('/element', { using: 'css selector', value: css });
    return Object.values(element)[0];
  }
  clear(element: string) { return this.command(`/element/${element}/clear`, {}); }
  /** Types into a DOM element with real key events. */
  sendKeys(element: string, text: string) { return this.command(`/element/${element}/value`, { text }); }

  /** Finds a native element. In native context, a click is a real touch. */
  async findNative(predicate: string) {
    const element = await this.command<Record<string, string>>('/element', { using: '-ios predicate string', value: predicate });
    return Object.values(element)[0];
  }
  click(element: string) { return this.command(`/element/${element}/click`, {}); }
}

async function request<T = unknown>(url: string, method: string, body?: Json): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const { value } = await response.json() as { value: T & { error?: string; message?: string } };
  if (!response.ok) throw new Error(`${method} ${url}: ${value?.error}: ${value?.message}`);
  return value;
}
