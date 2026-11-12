# Capture tooling

Runs one simulated sale across three iOS simulators with nobody holding a phone, and records each. Appium drives Safari and `simctl io recordVideo` records the screen.

**What runs today.** A take goes from the owner showing an item's tag to the buyer standing at PayPal's login page. With `--stall own` the owner signs in, adds a haggle item, shows its tag on the print sheet and opens the stall. With `--stall demo` the owner signs in to the published demo stall and shows the tag of one of its haggle items. Either way the tool reads the QR image off the print sheet and decodes it (jsQR, from the API's dependencies), checks that the URL is the item's page on the service host with nothing after the code, and has the buyer open that decoded URL. The buyer asks up to two questions, offers less than the asking price, and taps Accept on Stallkeeper's offer. The buyer then taps Buy now, which a haggle item shows once chat is closed, and taps Pay. A second buyer opens the same tag and is refused while the first is paying. The owner's simulator waits on the live feed with its totals at the top of the screen, so the sale row appears in view when the capture lands and the webhook verified mark arrives in the same shot. On the owner's form, the take holds the counter-offer ladder preview in view before saving.

With `--through capture` the buyer carries on: logs in to PayPal as the sandbox buyer, approves, and waits for the completed capture to show the paid line ("Take the item with this tag.") on the buyer's paid screen. The take also reads the paid amount from the screen's item and price line and times the approval against the five-minute reservation.

With `--through sale` the take then waits for the owner feed to show that item's sale with the webhook verified mark, and checks that a `PAYMENT.CAPTURE.COMPLETED` webhook names the capture. This needs a host PayPal can deliver webhooks to, so a local server skips that beat and its take fails the webhook checks, which is expected for a rehearsal.

With `--through closing`, the only reach a take can be complete at, the owner then closes the stall, which builds the closing report at once, and flags one unsold item (`--stage-absent`, default "Wooden stool") as not at the stall from the report's "Something missing?" fold. The report then shows that one difference, and the take checks that the difference is exactly that item, the sold item is under "Sold, gone with the buyer", the report is final, nothing is unresolved, the report's recorded sales equal the feed's, and the owner's screen showed the difference. The difference is staged and the footage must say so. On the owner's own stall the take adds the staged item over the API first.

**What does not run.** The beats that `beats.ts` marks as pending, with their reasons, are logged as skipped. A take that stops before closing is `stopped`, never `complete`, and is never evidence. A local run gets no PayPal webhook, so it cannot pass the feed or webhook checks.

**Out of date since 8 November 2026.** Two entries in `selectors.ts` no longer match the app. `owner.field.mode` looks for a "Price mode" field, and the item form now has buttons under "How to sell it". `buyer.paid` waits for "Match this tag.", which the paid screen no longer shows. Update both before the next take with `--stall own` or `--through capture` and beyond. The takes recorded in `docs/evidence` are dated 6 November 2026, before either change.

**Demo stall and hosted runs.** `--stall demo` takes the demo owner's password and the judge buyer's login from `/api/demo`, which publishes both, so no secret is needed for those. It also sells an item that is already on the stall: name it with `--item`, and note that a simulator keeps its cookies, so an agreed price on an item lasts 30 minutes in that simulator and a rerun in that window should sell another item or erase the simulator. The hosted database is reachable only by the service, so against a host with no `DATABASE_URL` the take reads the order and its captures from PayPal's API and the webhook events from PayPal's webhook list, with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set (names only; never printed). PayPal's list has trailed a delivery by more than a minute, so a take through sale waits up to five minutes for it. Each question and offer to a hosted service is a real chat turn and counts against its daily AI budget, so rehearse locally with `STALLKEEPER_SCRIPTED_MODEL=1` first.

**The demo stall also resets itself.** The service resets the demo stall once it has sat closed, or without an available item that takes offers, for 20 minutes, and never while a payment is active. A take is not cut across. Before owner setup, any take signed in as the demo owner, with `--stall demo` or `--stall own`, resets a stall in either of those states, so the timer has nothing to count during setup, and it stops if a payment refuses that reset. The main stall is left as it is. After that, each flagged item, each checkout and each new item on a closed stall restarts the 20 minutes, so a take that keeps tapping through the closing beat holds its stall. A pause of more than 20 minutes inside a take on the demo stall would let the reset run, so rerun that take. After a reset the ended session's closing report stays readable and its flags stay usable, so a take that finishes reading the report still can. `node tools/capture/reset-demo.ts <origin>` is still how to leave the stall as seeded after the takes.

## Prerequisites

Xcode with an iOS simulator runtime, and Appium with its XCUITest driver. Appium stays out of the workspace on purpose, because its dependency tree is large and CI has no simulator. Install it anywhere outside the repository:

```sh
npm install appium@3
npx appium driver install xcuitest
npx appium --port 4723
```

Create and boot one simulator per role, and keep the UDIDs:

```sh
xcrun simctl create capture-buyer com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcrun simctl boot <udid>
xcrun simctl bootstatus <udid> -b
```

Shut each one down and delete it when you finish.

## Run

Start the app with `pnpm dev` and the PayPal sandbox variables set. Without a real sandbox client ID the PayPal button never appears. To rehearse with no Anthropic key, also set `STALLKEEPER_SCRIPTED_MODEL=1`: the API then answers from a small scripted stand-in that quotes the owner's notes or says it does not know. It refuses to start in production. Then:

```sh
node tools/capture/sale.ts --buyer <udid> --owner <udid> --rival <udid> --base-url http://localhost:5173 --out <dir>
```

To go through approval and capture, add `--through capture` and give the sandbox buyer's login in two environment variables, `PAYPAL_BUYER_EMAIL` and `PAYPAL_BUYER_PASSWORD`, or the names given to `--buyer-email-env` and `--buyer-password-env`. Neither is printed or logged. Recordings must use the judge-only sandbox buyer. A rejected login stops the take and is never retried, because PayPal locks a sandbox account for about half an hour after a few failed attempts, and a rerun would try again.

Run with `--help` for the other options. `--out` must be outside the repository. Each run is a take: `<out>/take-N/` holds one MP4 per simulator, `take.json`, `captions.srt` with timed captions for the take, and a PNG of each recording's last frame, and `<out>/takes.jsonl` gets one line per take. The first run builds WebDriverAgent for each simulator under `--wda`, which later runs reuse.

`--wda-port` gives the first simulator's WebDriverAgent port, and the next two follow it, so concurrent runs on one machine can each have their own. `--offer` defaults to 15, so the fixture asking £28 gets a £24 counter-offer on the demo stall.

The owner password comes from `OWNER_PASSWORD` (or the variable named by `--owner-password-env`) and is never printed or logged. On localhost it falls back to `owner`. The script reads the database to tie the recording to a payment, from `DATABASE_URL`, or the embedded database `pnpm dev` starts on localhost.

## Takes

Every take is a whole sale on a new item the owner adds on screen, so a failed take cannot be continued: a rerun starts from the owner adding the item, gets the next take number and names the failed take it replaces in `supersedes`. Nothing resumes, and nothing carries an approval from one take to another.

`take.json` logs the item code, the asking price, the agreed price when there was one, the checkout total, the PayPal order, capture and webhook event suffixes, the host PayPal's tab landed on as `paypalHost`, the recorded sales and items sold before and after, the build (the commit the server reports on `/api/health`, or the script's own commit on localhost, plus the web bundle name) and the host. On a take through capture it also logs `approval`: the time from the tap on Pay to the login form, to the paid line, and from PayPal's own Pay button to the paid line, the 300-second reservation to compare them with, whether the buyer's page was in front when its capture request left, whether that page reloaded, and how long after payment PayPal's tab closed. Suffixes are the last six characters, enough to find the transaction in PayPal's dashboard. Full PayPal IDs are checked in memory and never written. `tag` holds the path the tag's QR image decoded to and the item name the buyer's page showed after opening it, and the take fails when the URL is not the item's page or opens another item. The decoded image is saved beside the take as `tag-<code>.png`. It also logs each beat's start, end and outcome, when each recording began, and the AI replies exactly as the page showed them. `model` says whether Claude or the scripted stand-in answered, and `mode` is `dry-run` on localhost and `real` elsewhere.

`take-log.ts` decides whether a take shows one continuous sale. It fails a take when:

- the approval page's PayPal order is not the checkout's order, or a capture belongs to another checkout
- the agreed price, checkout total, capture, paid page and feed amounts differ
- there is not exactly one completed capture, or no `PAYMENT.CAPTURE.COMPLETED` webhook names it
- the feed lacks the verified mark, or the totals did not rise by exactly the sale

A take through capture checks the order and the amounts, and that the checkout is paid with one completed capture at the checkout total, but not the webhook, the feed mark or the totals. A take that did not set out to capture only checks the order and that no capture exists. At the end of a take that has not paid, the script cancels that take's reservation from the buyer's own page after the footage and the database read, because a buyer session holds one reservation and the simulator keeps its cookies between takes.

## Evidence beside the takes

`evidence.ts` reads and sends through PayPal's sandbox REST API with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. `resend` asks PayPal to deliver a take's completed-capture event again and checks that the order still has one capture and the owner feed is unchanged. `decline` captures a GBP order with PayPal's negative-testing header and records the 422 `INSTRUMENT_DECLINED` that comes back. The decline talks to PayPal directly, so it shows what PayPal sends, not how the service handles it. Both keep suffixes only.

## The screens

`selectors.ts` holds every label, selector and path the script reads from the app. When a screen changes, edit that file. `beats.ts` holds the order of a take's beats and which of them are ready.

## What to know before extending this

**Tap PayPal's button in the native context.** Find the element by label in the native tree and click it there, which is a real touch. A web-context click runs the page's handler but carries no user gesture, so PayPal opens an in-page modal in place of the new tab a buyer gets. Appium's `nativeWebTap` option missed the button altogether. `XCUIElementTypeWebView` reports the full screen, so its rect gives no offset for page coordinates either: the page starts 62 points lower on an iPhone 17. Our own buttons are clicked in the web context, which is fine for them.

**The button's native label is "Pay with PayPal".** It comes from the `pay` button type.

**Check that the tap worked.** On the first page load after a simulator is erased, the first tap can report success and do nothing, even though the button has not moved. The cause is unknown, so the script taps until the PayPal tab appears. Repeating is safe because the page ignores taps once checkout has started.

**PayPal's pages are only in the web context.** The native tree shows our page by label, but on PayPal's page it shows only Safari's controls and the keyboard. Switch to the new web context and use the DOM. The login is two steps on one URL. The first has `#email` and a button whose text is "Next". The second replaces the email with a hidden `publicCredential` field and shows `#password` and a button whose text is "Log In". Neither button has an id, so find them by their text. A script click on "Next" moved to the password step; pressing Enter in the email field did nothing. No captcha appeared for a scripted login, and the form's hidden captcha fields stayed hidden. The first judge buyer's "Log In" was accepted and PayPal then declined the transaction on `/pay/generic-error`, in Safari under Appium and in desktop Chrome alike. The recreated judge buyer pays, see [the judge buyer checkout](../../docs/EVIDENCE.md#judge-access). The order ID is the `token` in PayPal's URL.

**Tap PayPal's own Pay button through the element.** In PayPal's web context `session.click` is a script click, not a real touch, and a native touch behaved the same, so the tap method does not decide the outcome. The script reads the button by its id and waits for its text to read "Pay", because it reads "Loading..." while PayPal works.

**A take that cancels after Pay is an integration fault, not a flake of this tooling.** On iPhone Safari without the PayPal app, PayPal's App Switch bridge sometimes sends the PayPal tab to the bare host `sandbox.paypal.com`. The PayPal SDK only accepts messages from `www.sandbox.paypal.com`, so it never hears the approval, PayPal closes its tab and the SDK reports a cancel. The order is then `APPROVED` at PayPal and nothing is captured. The app sets `app_switch_preference` on the order to avoid the bridge, and its SDK cancel route reads the order from PayPal and captures it if it is approved. Each take records the host PayPal's tab landed on as `paypalHost` in `take.json`, so a take that still cancels shows whether it was on the bare host.

**What happens after approval.** PayPal closes its own tab within a second of the paid line and Safari shows our page again. `onApprove` fires in our page, which stays loaded behind PayPal's tab, hidden, with its JavaScript state kept. There was no redirect back and no reload, and the capture request leaves while our page is hidden. A full approval, from the tap on Pay to the paid line, took 12 to 14 seconds, of which PayPal's own Pay button took 3 to 5. That is a small part of the five-minute reservation.

**Keep the recorders running for 20 seconds after payment.** With three simulators recording, a recording trails the screen, and stopping it as soon as the paid line shows ends the video on PayPal's spinner. The script waits 20 seconds first. Check a take's last frame for the paid page.

**The DOM runs ahead of the screen.** `#email` exists while PayPal's spinner still covers it, so wait until the field is the top element at its own centre. Check a take's last frame as well as its exit code.

**Safari interrupts a fresh simulator.** It shows a tip about its menu over the bottom of the first page, and offers to save the password after the owner logs in and again after the buyer logs in to PayPal. The script dismisses all three. Left up on PayPal's page, the prompt kept PayPal's tab from closing after payment in the one take that missed it. Blur the focused field before a click, or the keyboard stays up over the page.

**Each simulator needs its own ports and build folder.** The script gives each one its own WebDriverAgent port, MJPEG port and derived data folder.

**Stop `recordVideo` before ending the session, and use SIGINT.** Ending the session closes Safari, which would put the home screen at the end of the take. The recorder writes a frame only when the screen changes, so a still screen gives a low frame count and is not a fault.

## Why Appium

`idb` also works with this Xcode: it taps, and starts faster because it has nothing to build. Its accessibility output covered only Safari's controls, though, so every tap on a page would be a pixel position with no way to read the page back. Appium gives labels on our pages and the DOM on PayPal's.
