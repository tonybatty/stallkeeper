// Runs one simulated sale across three iOS simulators and records each: the buyer, the owner
// (who adds the item and then watches the feed) and a second buyer who is refused while the
// first is paying. Each run is a take, logged in full. Run with --help. See README.md.
//
// A take ends at PayPal's login page, or with --through capture it logs in as the sandbox buyer,
// approves and waits for the buyer's page to say it is paid after the completed capture.
// With --through sale it also waits for the owner feed's webhook verified mark, and with --through closing
// the owner closes the stall and flags one unsold item as not at the stall. With --stall demo it
// sells an item from the published demo stall, with the demo owner and the judge buyer, and needs no database.

import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AppiumSession, NATIVE } from './appium.ts';
import { beats, captionsSrt, runOrder, type Role } from './beats.ts';
import { chooseOption, clickControl, controlExists, fillField, pageText, flagNotAtStall, scrollTo, textsOf, waitForText } from './page.ts';
import { readHostedPayments } from './hosted.ts';
import { approve, logIn } from './paypal.ts';
import { buyer, owner, paths, paypal } from './selectors.ts';
import { record, sleep, tapUntilPayPalOpens, waitFor } from './simulator.ts';
import { buildOf, readDemo, readPayments, Stall } from './stall.ts';
import { checkTagUrl, decodeQr, pngOf } from './tag.ts';
import { differenceGroup, finishTake, nextTake, type ApprovalTiming, type BeatLog, type Observations, type Reach, type Recording, type Take } from './take-log.ts';

const { values } = parseArgs({
  options: {
    buyer: { type: 'string' }, owner: { type: 'string' }, rival: { type: 'string' },
    'base-url': { type: 'string' }, out: { type: 'string' }, wda: { type: 'string' },
    appium: { type: 'string', default: 'http://127.0.0.1:4723' },
    'wda-port': { type: 'string', default: '8101' },
    'stage-absent': { type: 'string', default: 'Wooden stool' },
    model: { type: 'string' },
    'owner-password-env': { type: 'string', default: 'OWNER_PASSWORD' },
    'database-url-env': { type: 'string', default: 'DATABASE_URL' },
    through: { type: 'string', default: 'login' },
    stall: { type: 'string', default: 'own' },
    item: { type: 'string', default: 'Brass desk lamp' },
    offer: { type: 'string', default: '15' },
    questions: { type: 'string', default: '2' },
    'buyer-email-env': { type: 'string', default: 'PAYPAL_BUYER_EMAIL' },
    'buyer-password-env': { type: 'string', default: 'PAYPAL_BUYER_PASSWORD' },
    pace: { type: 'string', default: '1' },
    help: { type: 'boolean', default: false },
  },
});

const usage = `Usage: node tools/capture/sale.ts --buyer <udid> --owner <udid> --rival <udid> --base-url <origin> --out <dir> [options]

  --out <dir>               Where takes go: one folder per take, and takes.jsonl. Outside the repository.
  --wda <dir>               Where WebDriverAgent builds, reused across takes. Default <out>/wda.
  --model scripted|claude   What answers the buyer. Default scripted on localhost, claude elsewhere.
  --owner-password-env      Name of the variable holding the owner password. Default OWNER_PASSWORD.
  --database-url-env        Name of the variable holding the database URL. Default DATABASE_URL.
                            On localhost it falls back to the database that pnpm dev starts.
  --through login|capture|sale|closing
                            Where the take stops. login stops at PayPal's login page. capture logs in, approves
                            and waits for the paid line. sale also waits for the owner feed's webhook verified
                            mark and checks the webhook, so it needs a host PayPal can reach. closing then has the
                            owner close the stall and flag one unsold item as not at the stall, and is the
                            only reach a take can be complete at. Default login.
  --stall own|demo          own: the owner adds a new item (OWNER_PASSWORD). demo: sell a haggle item from the
                            published demo stall, signing in with the demo owner and judge buyer logins that
                            /api/demo publishes. A hosted demo take reads the sale from PayPal's API, so set
                            PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Default own. Either way, a take on the demo
                            stall first resets it if it is closed or has no available item that takes offers.
  --item <name>             With --stall demo, the haggle item to sell. Default "Brass desk lamp".
  --offer <pounds>          The buyer's offer, which the server counters. Default 15.
  --stage-absent <name>     With --through closing, the unsold item the owner flags as not at the stall, so the report has one
                            difference. Default "Wooden stool". On the owner's own stall the take adds it as a fixed item.
  --wda-port <n>            WebDriverAgent's port for the first simulator, then the next two. Default 8101.
                            Give each concurrent run its own, as simulators on one machine share ports.
  --questions <n>           Questions the buyer asks before offering, 0 to 2. Default 2. Each is a chat turn.
  --buyer-email-env         Name of the variable holding the sandbox buyer's email. Default PAYPAL_BUYER_EMAIL.
  --buyer-password-env      Name of the variable holding the sandbox buyer's password. Default PAYPAL_BUYER_PASSWORD.
                            Use the judge-only buyer for any run that is recorded. Neither is ever printed or logged.
  --pace <n>                Multiplies the pauses that let a viewer read each screen. Default 1.
  --appium <server>         Default http://127.0.0.1:4723.`;

const udids: Record<Role, string | undefined> = { buyer: values.buyer, owner: values.owner, rival: values.rival };
if (values.help || !values.out || !values['base-url'] || !udids.buyer || !udids.owner || !udids.rival) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
const out = values.out;
const base = new URL(values['base-url']).origin;
const host = new URL(base).hostname;
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const model = values.model ?? (local ? 'scripted' : 'claude');
if (model !== 'scripted' && model !== 'claude') throw new Error('--model must be scripted or claude.');
const through = values.through as Reach;
if (!['login', 'capture', 'sale', 'closing'].includes(through)) throw new Error('--through must be login, capture, sale or closing.');
const wdaPort = Number(values['wda-port']);
if (!Number.isInteger(wdaPort) || wdaPort < 1024 || wdaPort > 60_000) throw new Error('--wda-port must be a port number.');
if (values.stall !== 'own' && values.stall !== 'demo') throw new Error('--stall must be own or demo.');
const demoStall = values.stall === 'demo';
const offerPence = Math.round(Number(values.offer) * 100);
if (!(offerPence > 0)) throw new Error('--offer must be an amount in pounds.');
const questionCount = Number(values.questions);
if (![0, 1, 2].includes(questionCount)) throw new Error('--questions must be 0, 1 or 2.');
// The demo stall's logins are published on /api/demo for judges, so a demo take reads them from there.
const demo = demoStall ? await readDemo(new URL(values['base-url']).origin) : null;
const buyerLogin = through === 'login' ? null
  : demo ? demo.buyer
  : { email: process.env[values['buyer-email-env']], password: process.env[values['buyer-password-env']] };
if (through !== 'login' && !(buyerLogin?.email && buyerLogin.password)) throw new Error(demoStall ? 'The demo page shows no buyer login.' : `Set ${values['buyer-email-env']} and ${values['buyer-password-env']} to the sandbox buyer's login.`);
const pace = Number(values.pace);
if (!(pace >= 0)) throw new Error('--pace must be a number, 0 or more.');
const password = demo?.ownerPassword ?? process.env[values['owner-password-env']] ?? (local ? 'owner' : undefined);
if (!password) throw new Error(`Set ${values['owner-password-env']} to the owner password.`);
const databaseUrl = process.env[values['database-url-env']] ?? (local ? 'postgres://postgres:postgres@localhost:54329/postgres' : undefined);
// Without a database URL the sale is read from PayPal's API instead. That works for a hosted demo take only.
const paypalLogin = process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? { clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET } : null;
if (!databaseUrl && !(through !== 'login' && paypalLogin)) throw new Error(`Set ${values['database-url-env']}, or for a take through capture set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. The script reads PayPal IDs to check a take.`);

const stall = new Stall(base);
await stall.login(password);
await stall.resetIdleDemo();

const dwell = (ms: number) => sleep(ms * pace);
const roles = ['buyer', 'owner', 'rival'] as const;

// The fixture: an item the owner adds on screen, so every take is a whole new sale.
const newItem = { name: 'Brass desk lamp', notes: 'Tested, it works. Scuff on the base. Made in 1970. Height 30 cm.', askingPounds: '28', floorPounds: '18', askingPence: 2800 };
// A demo take sells an item that is already on the demo stall, named by --item. Read after the reset above, which replaces every tag.
const demoItems = demo && (await readDemo(base)).items;
const chosen = demoItems?.find(candidate => candidate.name === values.item && candidate.mode === 'haggle' && candidate.availability === 'available');
if (demo && !chosen) throw new Error(`The demo stall has no available haggle item called "${values.item}".`);
const item = chosen ? { ...newItem, name: chosen.name, askingPence: chosen.askingPence } : newItem;
const questions = ['Does it work?', 'Is the shade original?'].slice(0, questionCount);

const pounds = (pence: number) => `£${pence % 100 ? (pence / 100).toFixed(2) : pence / 100}`;
await mkdir(out, { recursive: true });
const logPath = join(out, 'takes.jsonl');
const previous = (await readFile(logPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Take);
const { takeId, supersedes } = nextTake(previous);
const takeDir = join(out, takeId);
await mkdir(takeDir, { recursive: true });
const start = {
  takeId, supersedes, mode: local ? 'dry-run' : 'real', model, environment: 'iOS Simulator, Safari, iPhone 17', build: await buildOf(base, local), host,
  startedAt: new Date().toISOString(), reach: through,
} as const;
console.log(`${takeId}${supersedes ? `, rerunning ${supersedes} as a whole new sale` : ''}: ${start.mode} against ${host}, build ${start.build.commit} / ${start.build.web}`);

const beatLogs: BeatLog[] = [];
const aiReplies: Take['aiReplies'] = [];
const seen: Observations = { itemCode: '', askingPence: item.askingPence, agreedPence: null, paidPagePence: null, approvalOrderId: null, paypalHost: null, checkout: null, captures: [], webhookEvents: [], feedSale: null, tag: null, totalsBefore: null, totalsAfter: null, closing: null, aiSpend: null };

async function beat(id: (typeof runOrder)[number], run: () => Promise<void>, skip?: string) {
  const definition = beats.find(candidate => candidate.id === id)!;
  const startedAt = new Date().toISOString();
  const reason = definition.pending ?? skip;
  if (reason) {
    beatLogs.push({ id, startedAt, endedAt: startedAt, outcome: 'skipped', note: reason });
    return;
  }
  try { await run(); beatLogs.push({ id, startedAt, endedAt: new Date().toISOString(), outcome: 'done' }); }
  catch (error) {
    beatLogs.push({ id, startedAt, endedAt: new Date().toISOString(), outcome: 'failed', note: String(error) });
    throw error;
  }
}

const sessions = {} as Record<Role, AppiumSession>;
const recordings: Recording[] = [];
const stops: Array<() => Promise<void>> = [];
let failure: string | undefined;

async function showTagOnPrintSheet(session: AppiumSession, code: string) {
  await session.navigate(`${base}${paths.ownerTags}`);
  await waitFor(`tag ${code} on the print sheet`, async () => (await textsOf(session, owner.tagCode)).some(text => text.includes(code)) || undefined);
  await session.execute(`
    const [css, code] = arguments;
    [...document.querySelectorAll(css)].find(tag => tag.innerText.includes(code))?.scrollIntoView({ block: 'center' });
  `, [owner.printedTag.css, code]);
}

// Safari asks to save the password a moment after a login, owner's or PayPal's. Waits briefly, because it may not appear.
// Left up on PayPal's page, it stops PayPal's tab closing after payment. Returns to the context it was called from.
async function declineSavePassword(session: AppiumSession, back: string) {
  await session.setContext(NATIVE);
  const decline = await waitFor('the save password prompt', () => session.findNative(owner.savePasswordDecline), 4_000).catch(() => undefined);
  if (decline) await session.click(decline);
  await session.setContext(back);
}

// Reads the QR image printed on the tag and decodes it. The URL the buyer then opens is the decoded one, never typed.
async function decodeShownTag(session: AppiumSession, code: string) {
  const dataUrl = await session.execute<string | null>(`
    const [css, code] = arguments;
    const tag = [...document.querySelectorAll(css)].find(candidate => candidate.innerText.includes(code));
    return tag?.querySelector('img')?.src ?? null;
  `, [owner.printedTag.css, code]);
  if (!dataUrl) throw new Error(`The print sheet shows no QR image for tag ${code}.`);
  const png = pngOf(dataUrl);
  await writeFile(join(takeDir, `tag-${code}.png`), png);
  const decodedUrl = decodeQr(png);
  seen.tag = { decodedUrl, urlProblems: checkTagUrl(decodedUrl, base, code), openedItemName: null, itemName: item.name };
}

async function ownerOpensStall(session: AppiumSession) {
  await session.navigate(`${base}${paths.ownerHome}`);
  if ((await stall.items()).sessionStatus === 'closed') {
    await clickControl(session, owner.openStall);
    await waitForText(session, owner.stallOpen);
  }
}

// A demo take sells an item already on the demo stall, so the owner only signs in and shows its tag.
async function ownerShowsDemoTag() {
  const session = sessions.owner;
  await session.navigate(`${base}${paths.ownerLogin}`);
  const field = await waitFor('the password field', async () => session.findWeb(owner.password.css));
  await session.sendKeys(field, password!);
  const origin = await session.context();
  await clickControl(session, owner.logIn);
  await declineSavePassword(session, origin);
  seen.itemCode = chosen!.code;
  await showTagOnPrintSheet(session, seen.itemCode);
  await decodeShownTag(session, seen.itemCode);
  await dwell(3000);
  await ownerOpensStall(session);
  await dwell(1500);
}

async function ownerAddsItem() {
  if (demoStall) return ownerShowsDemoTag();
  const session = sessions.owner;
  // The unsold item the closing check will leave off the shelf. It is added over the API, off screen, before the lamp.
  if (through === 'closing' && !(await stall.items()).items.some(existing => existing.name === values['stage-absent'] && existing.status === 'available')) await stall.addFixedItem(values['stage-absent'], 2200);
  const known = new Set((await stall.items()).items.map(existing => existing.code));
  await session.navigate(`${base}${paths.ownerLogin}`);
  const field = await waitFor('the password field', async () => session.findWeb(owner.password.css));
  await session.sendKeys(field, password!);
  const origin = await session.context();
  await clickControl(session, owner.logIn);
  await declineSavePassword(session, origin);
  await clickControl(session, owner.addItem);
  await waitFor('the item form', async () => (await controlExists(session, owner.save)) || undefined);
  await fillField(session, owner.field.name, item.name);
  await fillField(session, owner.field.notes, item.notes);
  await chooseOption(session, owner.field.mode, owner.haggleMode);
  await fillField(session, owner.field.asking, item.askingPounds);
  await fillField(session, owner.field.floor, item.floorPounds);
  // The ladder preview sits under the floor field and is the point of the shot, so wait for the server's answer, put the
  // keyboard away and hold it in view before saving.
  await waitFor('the counter-offer ladder preview', async () => (await textsOf(session, owner.ladderPreview)).length > 0 || undefined);
  await session.execute('document.activeElement?.blur(); document.querySelector(arguments[0])?.scrollIntoView({ block: "center" });', [owner.ladderPreview]);
  await dwell(4000);
  await clickControl(session, owner.save);
  await waitFor('the saved item', async () => (await textsOf(session, owner.itemName.css)).includes(item.name) || undefined);
  const created = (await stall.items()).items.filter(candidate => !known.has(candidate.code));
  if (created.length !== 1) throw new Error(`Expected one new item, found ${created.length}.`);
  seen.itemCode = created[0]!.code;
  await showTagOnPrintSheet(session, seen.itemCode);
  await decodeShownTag(session, seen.itemCode);
  await dwell(3000);
  await ownerOpensStall(session);
  await dwell(1500);
}

async function buyerOpensTag() {
  const session = sessions.buyer;
  // The decoded URL is what a scan would open. A tag that did not decode stops the take here.
  if (!seen.tag?.decodedUrl) throw new Error('There is no decoded tag URL to open.');
  await session.navigate(seen.tag.decodedUrl);
  await waitFor('the item name', async () => (await textsOf(session, buyer.itemName)).includes(item.name) || undefined);
  seen.tag.openedItemName = (await textsOf(session, buyer.itemName))[0] ?? null;
  const price = (await textsOf(session, buyer.price))[0];
  // A simulator keeps its cookies between takes, and an agreed price lasts 30 minutes, so a rerun on the same item shows the old agreed price.
  if (price !== pounds(item.askingPence)) throw new Error(`The page shows ${price} for an item asking ${pounds(item.askingPence)}. If the buyer simulator agreed a price for this item in the last 30 minutes, sell another item or erase the simulator.`);
  await dwell(3000);
}

async function buyerAsks() {
  const session = sessions.buyer;
  // The spend is the whole service's, so other buyers' chat turns count in it too.
  const beforeUsd = await stall.aiSpentUsd();
  seen.aiSpend = { beforeUsd, afterUsd: beforeUsd };
  await openChat(session);
  for (const question of questions) {
    const field = await waitFor('the question box', async () => session.findWeb(buyer.questionBox));
    await session.sendKeys(field, question);
    const before = (await textsOf(session, buyer.chatReply)).length;
    await clickControl(session, buyer.send);
    const replies = await waitFor('the stallholder\'s reply', async () => {
      const found = await textsOf(session, buyer.chatReply);
      return found.length >= before + 2 ? found : undefined;
    }, 60_000);
    const reply = replies.at(-1)!.replace(buyer.chatReplyLabel, '').trim();
    aiReplies.push({ question, reply });
    await dwell(3000);
  }
}

async function openChat(session: AppiumSession) {
  if (!(await controlExists(session, buyer.askQuestion)) && (await session.findWeb(buyer.questionBox).catch(() => undefined))) return;
  await clickControl(session, buyer.askQuestion);
  await waitFor('the question box', async () => session.findWeb(buyer.questionBox));
}

let counterPence: number | null = null;

// The buyer offers less than the asking price and the server answers with a card. The price on the card is the server's.
async function buyerOffers() {
  const session = sessions.buyer;
  await openChat(session);
  await clickControl(session, buyer.makeOffer);
  const field = await waitFor('the offer box', async () => session.findWeb(buyer.offerBox));
  await session.sendKeys(field, String(offerPence / 100));
  const before = (await textsOf(session, buyer.chatReply)).length;
  await clickControl(session, buyer.sendOffer);
  const replies = await waitFor('the offer card', async () => {
    const found = await textsOf(session, buyer.chatReply);
    return found.length >= before + 2 && (await controlExists(session, { css: buyer.offerCard })) ? found : undefined;
  }, 60_000);
  const question = replies.at(-2)!.replace(/^You:\s*/, '').trim();
  aiReplies.push({ question, reply: replies.at(-1)!.replace(buyer.chatReplyLabel, '').trim() });
  const [total] = await textsOf(session, buyer.offerTotal);
  counterPence = Math.round(Number(total?.replace(/[^0-9.]/g, '')) * 100);
  if (!(counterPence > 0)) throw new Error(`The offer card shows "${total}".`);
  seen.aiSpend = { beforeUsd: seen.aiSpend?.beforeUsd ?? 0, afterUsd: await stall.aiSpentUsd() };
  await dwell(3000);
}

// Tapping the card's button is the only way a price becomes agreed. The page then shows that price and the Pay button.
async function buyerAgrees() {
  const session = sessions.buyer;
  await clickControl(session, buyer.acceptOffer);
  await waitFor('the agreed price', async () => (await textsOf(session, buyer.price))[0] === pounds(counterPence!) || undefined);
  seen.agreedPence = counterPence;
  await dwell(3000);
}

// Posts the cancel from the buyer's own page, because only the session that made a checkout can cancel it.
async function cancelCheckout(session: AppiumSession, checkoutId: string) {
  await session.setContext(buyerOrigin);
  await session.execute(`window.cancelled = undefined; fetch('/api/checkouts/' + arguments[0] + '/cancel', { method: 'POST' }).then(response => { window.cancelled = response.status; });`, [checkoutId]);
  const status = await waitFor('the cancel reply', async () => (await session.execute<number | null>('return window.cancelled ?? null')) ?? undefined);
  if (status !== 200) throw new Error(`Cancel returned ${status}`);
}

async function rivalIsRefused() {
  const session = sessions.rival;
  await waitFor('the item to be reserved', async () => (await stall.items()).items.find(candidate => candidate.code === seen.itemCode)?.status === 'reserved' || undefined, 60_000);
  await session.navigate(`${base}${paths.item(seen.itemCode)}`);
  await waitForText(session, buyer.reservedNotice);
  await dwell(4000);
}

// The sale row and its webhook mark sit below the totals, off screen on a phone. Park the totals at the top before anyone
// pays, so the row appears in view when the capture lands and the mark arrives in the same shot.
async function ownerParksOnFeed() {
  const session = sessions.owner;
  await session.navigate(`${base}${paths.ownerFeed}`);
  await waitFor('the feed totals', async () => (await controlExists(session, { css: owner.feedTotals })) || undefined);
  await scrollTo(session, owner.feedTotals, 'start');
}

let buyerOrigin = '';
let paypalContext = '';
let tapStartedAt = 0;
let loginFormAt = 0;
let approval: ApprovalTiming | null = null;

async function buyerStartsPayment() {
  const session = sessions.buyer;
  const origin = buyerOrigin = await session.context();
  const before = await session.contexts();
  // A haggle item opens on the stallholder; the checkout is behind Buy now.
  if (await controlExists(session, buyer.buyNow)) await clickControl(session, buyer.buyNow);
  await waitFor('the PayPal button', async () => (await session.execute<boolean>('return !!document.querySelector("paypal-button")')) || undefined);
  await scrollTo(session, buyer.paypalContainer);
  seen.totalsBefore = await stall.totals();
  await session.setContext(NATIVE);
  const tip = await session.findNative(buyer.safariTipClose).catch(() => undefined);
  if (tip) await session.click(tip);
  const button = await waitFor('the PayPal button', () => session.findNative(buyer.paypalNative));
  // Notes whether the page is in front when its capture request leaves, and whether it reloads: a redirect back from PayPal would.
  await session.setContext(origin);
  await session.execute(`
    window.__capture = { sentWhile: null };
    const send = window.fetch;
    window.fetch = function (input, init) {
      if (/\\/capture$/.test(String(input)) && init?.method === 'POST') window.__capture.sentWhile = document.visibilityState;
      return send.apply(this, arguments);
    };
  `);
  await session.setContext(NATIVE);
  tapStartedAt = Date.now();
  const tapped = await tapUntilPayPalOpens(session, button, before);
  paypalContext = tapped.paypalContext;
  await session.setContext(paypalContext);
  await waitFor('the PayPal login form', async () => await session.execute<boolean>(paypal.emailShowing) || undefined);
  loginFormAt = Date.now();
  const url = new URL(await session.url());
  seen.approvalOrderId = url.searchParams.get('token');
  seen.paypalHost = url.host;
  await dwell(2500);
  await session.setContext(origin);
}

async function buyerApproves() {
  const session = sessions.buyer;
  await session.setContext(paypalContext);
  await logIn(session, buyerLogin!.email!, buyerLogin!.password!);
  await declineSavePassword(session, paypalContext);
  // PayPal picks the host per order, before login. Reading it again on the review page is the one that matters for Pay.
  seen.paypalHost = new URL(await session.url()).host;
  await dwell(2500);
  const approveAt = Date.now();
  await approve(session);
  await session.setContext(buyerOrigin);
  let ended: string | undefined;
  await waitFor('the paid page', async () => {
    const text = await pageText(session);
    if (buyer.paid.test(text)) return true;
    ended = buyer.checkoutEnded.exec(text)?.[0];
    return ended ? true : undefined;
  }, 90_000);
  if (ended) throw new Error(`The checkout ended without payment: ${ended}`);
  const paidAt = Date.now();
  // The price follows the last middle dot, so digits in the item name are not read as the amount.
  const [line] = await textsOf(session, buyer.paidItemLine);
  seen.paidPagePence = Math.round(Number(line?.split('·').pop()?.replace(/[^0-9.]/g, '')) * 100);
  seen.totalsAfter = await stall.totals();
  const capture = await session.execute<{ sentWhile: 'visible' | 'hidden' | null } | null>('return window.__capture ?? null');
  // Watch for PayPal's own tab to close itself.
  const closed = await waitFor('PayPal to close its tab', async () => (await session.contexts()).includes(paypalContext) ? undefined : Date.now(), 20_000).catch(() => null);
  const shown = await waitFor('the buyer page to come back in front', async () => (await session.execute<string>('return document.visibilityState')) === 'visible' ? Date.now() : undefined, 20_000).catch(() => null);
  // The recording runs well behind the screen with three simulators recording, and stopping it early ends the
  // video on PayPal's spinner. This wait ignores --pace for that reason.
  await sleep(20_000);
  approval = {
    reservationSeconds: 300, loginFormMs: loginFormAt - tapStartedAt, reservedToPaidMs: paidAt - tapStartedAt, approveToPaidMs: paidAt - approveAt,
    captureSentWhile: capture?.sentWhile ?? null, pageReloaded: capture === null, paypalTabClosedAfterMs: closed === null ? null : closed - paidAt,
    buyerPageShownAfterMs: shown === null ? null : shown - paidAt,
  };
}

// After payment the owner's feed gets the sale at once and the verified mark when PayPal's webhook arrives and checks out.
async function ownerSeesWebhook() {
  const session = sessions.owner;
  const sale = await waitFor('the sale on the owner feed with its webhook mark', async () => {
    const found = (await stall.feed()).sales.find(candidate => candidate.code === seen.itemCode);
    return found?.webhookVerifiedAt ? found : undefined;
  }, 180_000);
  seen.feedSale = { code: sale.code, amountPence: sale.amountPence, webhookVerified: true };
  // The page is live over the feed stream, so the row should show the mark without a reload. Look for this item's row, because other sales may be verified.
  await waitFor('the verified mark on the item\'s row', async () => (await session.execute<boolean>(`
    const [rows, code, mark] = arguments;
    return [...document.querySelectorAll(rows)].some(row => row.innerText.includes('Tag ' + code) && !!row.querySelector(mark));
  `, [owner.feedSale, seen.itemCode, owner.feedVerified])) || undefined, 60_000);
  await dwell(5000);
}

// The owner closes the stall and the report is built at once. The sold item has left with its buyer and the rest count as
// still at the stall, so the take flags one unsold item as not there. The report then shows that one difference and says what it cannot know.
async function ownerCloses() {
  const session = sessions.owner;
  await session.navigate(`${base}${paths.ownerHome}`);
  await clickControl(session, owner.closeStall);
  await waitForText(session, owner.closingPage);
  const shelf = await waitFor('the closing report items', async () => { const report = await stall.closing(); return report?.items.length ? report : undefined; });
  const staged = shelf.items.filter(candidate => candidate.name === values['stage-absent'] && candidate.code !== seen.itemCode);
  if (staged.length !== 1) throw new Error(`Expected one unsold item called "${values['stage-absent']}" in the closing report, found ${staged.length}.`);
  const stagedCode = staged[0]!.code;
  await dwell(2000);
  await flagNotAtStall(session, stagedCode);
  // The report is on the page from the start, so wait for its heading to be in view.
  await waitFor('the closing report', async () => (await session.execute<boolean>(`
    const [css, text] = arguments;
    const heading = [...document.querySelectorAll(css)].find(candidate => candidate.textContent.trim() === text);
    return !!heading && heading.getBoundingClientRect().top < window.innerHeight;
  `, [owner.reportHeading.css, owner.reportHeading.text])) || undefined);
  const report = await stall.closing();
  if (!report) throw new Error('The closing report is empty.');
  const difference = report.groups.find(group => group.key === differenceGroup);
  const shownOnScreen = !!difference && await session.execute<boolean>(`
    const [css, label, code] = arguments;
    return [...document.querySelectorAll(css)].some(card => card.querySelector('h3')?.textContent.trim() === label && card.innerText.includes(code));
  `, [owner.reportGroup, difference.label, stagedCode]);
  seen.closing = { stagedCode, status: report.status, recordedSalesPence: report.recordedSalesPence, groups: report.groups.map(group => ({ key: group.key, codes: group.items.map(candidate => candidate.code) })), shownOnScreen };
  await dwell(6000);
}

try {
  await Promise.all(roles.map(async (role, index) => {
    sessions[role] = await AppiumSession.start({ server: values.appium, udid: udids[role]!, wdaPort: wdaPort + index, derivedDataPath: join(values.wda ?? join(out, 'wda'), role), initialUrl: `${base}/` });
  }));
  // Safari's menu tip covers the bottom of the first page on a fresh simulator, so clear it before any recording starts.
  await Promise.all(roles.map(async role => {
    const session = sessions[role];
    const web = await session.context();
    await session.setContext(NATIVE);
    const tip = await waitFor('Safari\'s menu tip', () => session.findNative(buyer.safariTipClose), 6_000).catch(() => undefined);
    if (tip) await session.click(tip);
    await session.setContext(web);
  }));
  for (const role of roles) {
    stops.push(record(udids[role]!, join(takeDir, `${role}.mp4`)));
    recordings.push({ role, file: `${role}.mp4`, startedAt: new Date().toISOString() });
  }
  await beat('earlier', ownerAddsItem);
  await beat('tag-url', buyerOpensTag);
  await beat('question', buyerAsks);
  await beat('offer', buyerOffers);
  await beat('agree', buyerAgrees);
  // The reservation exists the moment Pay is tapped, so the refusal is live, not an earlier moment.
  await beat('reserve', async () => {
    const owners = ownerParksOnFeed();
    await Promise.all([buyerStartsPayment(), rivalIsRefused(), owners]);
  });
  await beat('approve', buyerApproves, through === 'login' ? 'This take stops at PayPal\'s login page. Run with --through capture.' : undefined);
  await beat('paid', async () => undefined);
  await beat('feed', ownerSeesWebhook, local ? 'A local server gets no PayPal webhook, so there is no verified mark to wait for.' : through === 'sale' || through === 'closing' ? undefined : 'This take stops before the feed. Run with --through sale on a host PayPal can reach.');
  await beat('closing', ownerCloses, through === 'closing' ? undefined : 'This take stops before closing. Run with --through closing.');
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  // Recording stops before the sessions end, because ending a session closes Safari and would
  // put the home screen at the end of the take.
  for (const stop of stops) await stop().catch(error => { failure ??= `A recording did not finish: ${error}`; });
}

// Only the buyer's own session may read a checkout, so the read goes out from the buyer's page.
async function readCheckoutFromBuyerPage(checkoutId: string) {
  const session = sessions.buyer;
  await session.setContext(buyerOrigin);
  await session.execute(`window.checkoutRead = undefined; fetch('/api/checkouts/' + arguments[0]).then(response => response.json()).then(body => { window.checkoutRead = body; });`, [checkoutId]);
  const body = await waitFor('the checkout read', async () => (await session.execute<{ checkoutId: string; state: string; totalPence: number; paypalOrderId: string | null } | null>('return window.checkoutRead ?? null')) ?? undefined);
  return { id: body.checkoutId, state: body.state, totalPence: body.totalPence, paypalOrderId: body.paypalOrderId };
}

// What the database says about the sale, read after the footage is done and before the checkout is released.
let observed: Observations | null = null;
if (seen.itemCode) {
  try {
    const payments = databaseUrl ? await readPayments(databaseUrl, seen.itemCode)
      : seen.approvalOrderId ? await readHostedPayments(paypalLogin!, seen.approvalOrderId, new Date(start.startedAt), { readCheckout: readCheckoutFromBuyerPage }, through === 'sale' || through === 'closing' ? 300_000 : 0)
      : { checkout: null, captures: [], webhookEvents: [] };
    observed = { ...seen, ...payments };
  }
  catch (error) { failure ??= `Could not read the payment records: ${error}`; }
}
// A buyer session holds one reservation at a time, and the simulator keeps its cookie between takes.
// Release a take's reservation so the next take is not refused. A paid checkout is not active, so this changes nothing there.
if (observed?.checkout && ['creating', 'awaiting_approval'].includes(observed.checkout.state)) {
  await cancelCheckout(sessions.buyer, observed.checkout.id).catch(error => console.error('Could not release the reservation', error));
}
for (const role of roles) await sessions[role]?.quit().catch(error => console.error(`${role}: could not end the session`, error));

const take = finishTake(start, observed, beatLogs, recordings, aiReplies, new Date().toISOString(), failure, approval);
await writeFile(join(takeDir, 'take.json'), `${JSON.stringify(take, null, 2)}\n`);
await appendFile(logPath, `${JSON.stringify(take)}\n`);
await writeFile(join(takeDir, 'captions.srt'), captionsSrt({ askingPence: item.askingPence, priceAgreedPence: take.agreedPence, counterPence, dryRun: take.mode === 'dry-run' }));

// The recorder writes a frame only when the screen changes, so check each take's last frame, not just the exit code.
for (const role of roles) {
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-1', '-i', join(takeDir, `${role}.mp4`), '-frames:v', '1', '-update', '1', join(takeDir, `last-${role}.png`)]); }
  catch { console.error(`${role}: no last frame could be read from the recording`); }
}

console.log(JSON.stringify({ takeId: take.takeId, status: take.status, problems: take.problems, itemCode: take.itemCode, approvalOrderSuffix: take.approvalOrderSuffix, paypalHost: take.paypalHost, orderSuffix: take.orderSuffix, skipped: beatLogs.filter(log => log.outcome === 'skipped').map(log => log.id) }, null, 2));
if (take.status === 'failed') process.exitCode = 1;
