// Driving PayPal's own pages in their web context: the login form and the approve button. Names
// come from selectors.ts. PayPal's pages are not in the native tree, so everything here is DOM.

import type { AppiumSession } from './appium.ts';
import { paypal } from './selectors.ts';
import { sleep, waitFor } from './simulator.ts';

const clickByText = (session: AppiumSession, text: string) => session.execute<boolean>(`
  const button = [...document.querySelectorAll('button')].find(candidate => candidate.innerText.trim() === arguments[0]);
  if (!button) return false;
  button.click();
  return true;
`, [text]);

// The password step is the one with a Log In button. The #password field can be in the DOM, with height, while the
// email step is still showing, so the field alone does not say which step this is.
const logInShowing = (session: AppiumSession) => session.execute<boolean>(`
  const button = [...document.querySelectorAll('button')].find(candidate => candidate.innerText.trim() === arguments[0]);
  return !!button && button.offsetParent !== null;
`, [paypal.logIn]);

/** The visible lines of the page that carry no email, to say why PayPal stopped. */
const pageLines = (session: AppiumSession) => session.execute<string[]>(`
  return document.body.innerText.split('\\n').map(line => line.trim()).filter(line => line && line.length < 120 && !line.includes('@')).slice(0, 6);
`);

/**
 * Logs in and waits for the review page. PayPal offers two layouts: email, then Next, then password, or
 * email and password together when it remembers the browser, with the old email filled in. Clear the
 * email either way. It never retries: a rejected login stops the take, because repeated failures lock
 * the sandbox account for half an hour.
 */
export async function logIn(session: AppiumSession, email: string, password: string) {
  const emailField = await waitFor('the email field', () => session.findWeb(paypal.email));
  await session.clear(emailField!);
  await session.sendKeys(emailField!, email);
  if (!(await logInShowing(session))) {
    await waitFor('the Next button', async () => (await clickByText(session, paypal.next)) || undefined);
    await waitFor('the Log In button', async () => (await logInShowing(session)) || undefined);
  }
  const passwordField = await session.findWeb(paypal.password);
  await session.clear(passwordField!);
  await session.sendKeys(passwordField!, password);
  await waitFor('the Log In button', async () => (await clickByText(session, paypal.logIn)) || undefined);
  // waitFor swallows errors thrown inside its attempt, so the reason is kept here and thrown after.
  let stopped: string | undefined;
  await waitFor('the review page', async () => {
    const path = await session.execute<string>('return location.pathname');
    if (path.startsWith(paypal.declinedPath)) { stopped = `PayPal declined the transaction at login: ${(await pageLines(session)).join(' / ')}`; return true; }
    if (path.startsWith(paypal.reviewPath)) return true;
    if (paypal.loginRejected.test(await session.execute<string>('return document.body.innerText'))) {
      stopped = 'PayPal did not accept the buyer login. Not retrying, because repeated failures lock the account.';
      return true;
    }
    return undefined;
  }, 60_000);
  if (stopped) throw new Error(stopped);
}

/**
 * Taps PayPal's own Pay button through the element. In a web context Appium's click is a script click, not a real
 * touch, and that is fine: whether a take pays depends on the host PayPal's tab landed on (see `paypalHost` in
 * take.json), not on how the button is tapped.
 */
export async function approve(session: AppiumSession) {
  await waitFor('the Pay button to be ready', async () => (await session.execute<boolean>(`
    const button = document.querySelector(arguments[0]);
    return !!button && !button.disabled && button.innerText.trim() === 'Pay';
  `, [paypal.pay])) || undefined);
  await sleep(1_000);
  const element = await session.execute<Record<string, string>>('return document.querySelector(arguments[0])', [paypal.pay]);
  await session.click(Object.values(element)[0]!);
}
