// Reading and driving our own pages in Safari's web context. Everything here finds things by what
// the page shows, through the names in selectors.ts. PayPal's page and native taps are elsewhere.

import type { AppiumSession } from './appium.ts';
import type { Control } from './selectors.ts';
import { waitFor } from './simulator.ts';

const found = (value: boolean | null | undefined) => (value ? true : undefined);

export const pageText = (session: AppiumSession) => session.execute<string>('return document.body.innerText');

export function waitForText(session: AppiumSession, pattern: RegExp, timeoutMs = 30_000) {
  return waitFor(`text ${pattern}`, async () => {
    const text = await pageText(session);
    return pattern.test(text) ? text : undefined;
  }, timeoutMs);
}

export function clickControl(session: AppiumSession, control: Control, timeoutMs = 30_000) {
  return waitFor(`control ${control.text ?? control.css}`, async () => found(await session.execute<boolean>(`
    const [css, text] = arguments;
    const element = [...document.querySelectorAll(css)].find(candidate => (text === null || candidate.textContent.trim() === text) && !candidate.disabled);
    if (!element) return false;
    // Blurring puts the on-screen keyboard away, so it does not cover the page in the recording.
    document.activeElement?.blur();
    element.scrollIntoView({ block: 'center' });
    element.click();
    return true;
  `, [control.css, control.text ?? null])), timeoutMs);
}

export const controlExists = (session: AppiumSession, control: Control) => session.execute<boolean>(`
  const [css, text] = arguments;
  return [...document.querySelectorAll(css)].some(candidate => text === null || candidate.textContent.trim() === text);
`, [control.css, control.text ?? null]);

/**
 * Flags an unsold item as not at the stall from the closing report. The "Something missing?" fold is opened first, then the item's
 * button is found by its aria-label, "Not at the stall: <code>", and the take waits for the button to leave the page, which is how
 * the report says the flag is saved: the item has moved to another group.
 */
export async function flagNotAtStall(session: AppiumSession, code: string, timeoutMs = 30_000) {
  const label = `Not at the stall: ${code}`;
  await waitFor(`${label} in the closing report`, async () => found(await session.execute<boolean>(`
    const [label] = arguments;
    const fold = document.querySelector('details.exception');
    if (fold && !fold.open) fold.open = true;
    const target = [...document.querySelectorAll('details.exception button')].find(candidate => candidate.getAttribute('aria-label') === label && !candidate.disabled);
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  `, [label])), timeoutMs);
  await waitFor(`the report to save ${label}`, async () => found(await session.execute<boolean>(`
    const [label] = arguments;
    return ![...document.querySelectorAll('button')].some(candidate => candidate.getAttribute('aria-label') === label);
  `, [label])), timeoutMs);
}

export function fieldByLabel(session: AppiumSession, label: string) {
  return waitFor(`field ${label}`, async () => {
    const reference = await session.execute<Record<string, string> | null>(`
      const [label] = arguments;
      const owner = [...document.querySelectorAll('label')].find(candidate => candidate.textContent.trim().startsWith(label));
      const field = owner?.querySelector('input, textarea, select');
      field?.scrollIntoView({ block: 'center' });
      return field ?? null;
    `, [label]);
    return reference ? Object.values(reference)[0] : undefined;
  });
}

/** Replaces a field's contents by typing, so the recording shows the keyboard. */
export async function fillField(session: AppiumSession, label: string, text: string) {
  const field = await fieldByLabel(session, label);
  await session.clear(field!);
  await session.sendKeys(field!, text);
}

export async function chooseOption(session: AppiumSession, label: string, value: string) {
  await fieldByLabel(session, label);
  await session.execute(`
    const [label, value] = arguments;
    const owner = [...document.querySelectorAll('label')].find(candidate => candidate.textContent.trim().startsWith(label));
    const select = owner.querySelector('select');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  `, [label, value]);
}

export const textsOf = (session: AppiumSession, css: string) => session.execute<string[]>('return [...document.querySelectorAll(arguments[0])].map(element => element.innerText.trim())', [css]);

export const textOf = (session: AppiumSession, css: string) => waitFor(`text of ${css}`, async () => (await textsOf(session, css))[0]);

export const scrollTo = (session: AppiumSession, css: string, block: 'center' | 'start' = 'center') => session.execute('document.querySelector(arguments[0])?.scrollIntoView({ block: arguments[1] })', [css, block]);
