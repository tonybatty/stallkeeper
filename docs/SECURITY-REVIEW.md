# Focused security review, 11 November 2026

This review covers dependency reachability, buyer-chat admission, ledger tool selection and HTML response headers. It is not a penetration test or a security sign-off. Tests use mocked external services. No real PayPal approval, model request or hosted configuration check ran for this change.

## Dependencies

`pnpm audit --json` initially reported 14 advisories: six high, six moderate and two low. The updated lockfile reports eight: two high, four moderate and two low. The audit still exits 1. `@paypal/agent-toolkit` 1.11.0 is the latest registry release checked on this date, so a toolkit upgrade cannot clear its advisories.

The dependency changes are scoped to existing consumers:

- `@fastify/static` advances within major 10 to 10.1.10, which adopts glob 14.
- Toolkit's `@langchain/core` advances within 0.3 to 0.3.80, fixing [GHSA-r399-636x-v7f6](https://github.com/advisories/GHSA-r399-636x-v7f6).
- Toolkit's mathjs uses 15.2.0, fixing [GHSA-29qv-4j9f-fjw5](https://github.com/advisories/GHSA-29qv-4j9f-fjw5) and [GHSA-jvff-x2qm-6286](https://github.com/advisories/GHSA-jvff-x2qm-6286). The installed entry only uses its `round` function in order creation, which the application does not enable. Neither permitted read reaches mathjs.
- AI SDK 4's jsondiffpatch uses 0.7.6, fixing [GHSA-j4fx-xxwh-2485](https://github.com/advisories/GHSA-j4fx-xxwh-2485) and [GHSA-33vc-wfww-vjfv](https://github.com/advisories/GHSA-33vc-wfww-vjfv). Its patch and HTML formatter functions are not used by the toolkit read wrappers.
- Remaining glob 13 consumers use 14.0.4 and minimatch 10 consumers use 11.0.1, fixing [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). Static-file serving, lint and the web tests exercise these consumers.

Remove the overrides when the upstream consumers adopt patched versions. These changes do not claim compatibility for toolkit actions that Stallkeeper does not enable.

### Remaining advisories and reachability

The only production toolkit import is `apps/api/src/paypal-check.ts`, using `@paypal/agent-toolkit/ai-sdk`. It constructs exactly `get_order` and `list_transactions` and rejects any extra tool. The closing and ledger routes call those tools directly with database order IDs, server-derived dates and a fixed page size of 100. They do not give this toolkit to a model.

Inspection of the installed bundle traced both wrappers through the toolkit dispatcher to OAuth and Axios GET requests. Its older AI SDK only supplies the identity `tool()` wrapper on this path. The toolkit constructs Zod schemas but does not parse these direct calls through them. LangChain, LangSmith, OpenAI and MCP entry points are not imported by the application's selected entry. The application uses its separate AI SDK 7 and Zod 4 dependencies for model calls and input validation.

| Package | Severity and advisory | Why the vulnerable operation is not reachable through the reviewed application paths |
| --- | --- | --- |
| langsmith 0.3.87 | High, [GHSA-3644-q5cj-c5c7](https://github.com/advisories/GHSA-3644-q5cj-c5c7) | LangSmith is not imported. No public prompt pull or manifest deserialisation runs. |
| langsmith 0.3.87 | Moderate, [GHSA-v34v-rq6j-cj6p](https://github.com/advisories/GHSA-v34v-rq6j-cj6p) | No LangSmith tracing client or tracing headers run. This advisory appears after the compatible LangChain patch resolves a newer LangSmith version. |
| langsmith 0.3.87 | Moderate, [GHSA-fw9q-39r9-c252](https://github.com/advisories/GHSA-fw9q-39r9-c252) | No LangSmith object setter runs. |
| langsmith 0.3.87 | Moderate, [GHSA-rr7j-v2q5-chgv](https://github.com/advisories/GHSA-rr7j-v2q5-chgv) | No LangSmith streaming or redaction runs. |
| uuid 10.0.0 | Moderate, [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | This copy belongs to the unused LangChain dependency. No caller supplies a buffer to its v3, v5 or v6 functions. |
| zod 3.25.76 | High, [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Toolkit only builds schemas on this path. No untrusted collection reaches Zod 3 parsing. The app's own Zod is patched 4.6.7. |
| ai 4.3.19 | Low, [GHSA-rwvc-j5jr-mgvh](https://github.com/advisories/GHSA-rwvc-j5jr-mgvh) | Only `tool()` runs. No SDK 4 file upload, model call or attachment processing runs. |
| @ai-sdk/provider-utils 2.2.8 | Low, [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) | The identity tool wrapper does not invoke provider response parsing or streaming utilities. |

LangSmith's patched line is outside LangChain 0.3's declared range. UUID, AI SDK, provider-utils and Zod fixes also require incompatible version changes. This pass keeps those dependencies rather than replacing contracts outside the application's used path. Recheck this analysis before enabling another toolkit entry, action, workflow or model integration.

`apps/api/src/paypal-toolkit.test.ts` executes both real installed toolkit wrappers with a mocked HTTP transport, verifies sandbox OAuth and read URLs, checks returned order and transaction data, and covers transport failure. The existing allowlist test rejects unexpected tools. The full suite also covers closing and ledger reads, checkout approval/capture, photo proxying and Studio integration.

## Buyer chat

All buyer sessions and stalls share a limit of four in-flight chat turns and 60 admitted turns in a rolling minute on the single API instance required by ADR 0007. A 429 response includes `Retry-After: 60`; the buyer sees a friendly retry message and keeps the unsent draft. A rejected concurrency or rate check consumes no session turn or model call. The limit releases on both success and failure.

Before issuing an offer or calling the model, the API reserves US$0.10 in the shared daily usage row, with an atomic check of the existing daily spend. Provider-reported usage replaces that estimate after a successful response, including a refusal. A failed or interrupted call keeps the estimate, including across session turnover and process restarts. Unknown usage adds no invented token counts. A concurrent request that loses the last daily reservation creates no offer card. UTC day rollover starts the next allowance.

US$0.10 is a fallback estimate, not a maximum provider charge. Actual usage can exceed it; other AI routes share the budget and have their existing accounting. The application cap is still not an absolute billing ceiling. Provider-side billing limits remain an operational check.

## Ledger and headers

The ledger accepts only `auto`, `none`, `required`, or an object with a non-empty tool name of at most 64 characters. The existing name allowlist still applies, and the handler guards null before reading the name. Malformed bodies return 400 without a model call.

HTML responses, including SPA fallbacks and HEAD requests, send `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: SAMEORIGIN`. No strict CSP or opener policy was added. API JSON, photo bytes and the ledger event stream keep their content types.

## Verification

`pnpm test` passed 1,477 tests in 59 files. `pnpm typecheck`, `pnpm lint` and `pnpm build` passed. The build still gives the existing large ledger-chunk warning. `pnpm audit --json` exits 1 with the eight advisories listed above.

A local built-server smoke using curl and mocked external services checked HTML headers, `/api/config`, JPEG bytes and content type through the photo proxy, four concurrent successful chat requests, a fifth request returning 429, and a successful retry after capacity released. No real credentials were loaded.

A browser smoke of the PayPal approval popup and AG Studio was not run. Existing mocked approval/capture and ledger tests passed; the hosted check after deployment must cover those browser paths.

## Follow-up

Verify the production ingress contract for the owner login throttle's `CF-Connecting-IP` header. This pass does not change that throttle, add limits to other routes, restructure the ledger bundle, perform a secret/media scan, or verify provider billing settings. Those checks remain separate work.

## Addendum, 12 November 2026

A pattern scan of the tracked files and of the commit history looked for keys, tokens, credential files and private URLs. It found only test fixtures and empty placeholders. The author and committer identities on each commit were checked too: most are GitHub no-reply addresses, and the rest are dealt with when the public repository is created. No dedicated scanner such as gitleaks ran. The committed PNG files carry no text or EXIF chunks.

Later the same day gitleaks 8.30.1 scanned the tracked files and the commit history. Its only hits were five upper-case placeholders in curl examples in reference notes that are not part of this repository.

Two per-stall limits were added, held in memory on the single instance: 120 completed demo resets in a rolling hour and 120 new items in a rolling hour. A reset that is refused, because a payment is in progress or the stall is not the demo stall, spends no allowance. A completed reset, from the button, the idle timer or the nightly timer, gives the stall its whole new-item allowance back, so the limit one visitor reaches does not keep the next visitor from adding an item once the stall is reset. A tag code is four characters from an alphabet of 31 and is never reused, a reset takes fourteen, and the demo owner password is public. Both refusals return 429 with plain wording. At these limits the reset button and the add-item form can take 16,200 codes from one stall in an hour, from 120 resets of fourteen and 120 new items before each reset and after the last, of 923,521 in all. One visitor who completes 120 resets in an hour still stops the reset button for everyone until the hour moves on, and the idle and nightly resets are not counted. The limits slow use of the code space and do not remove the risk. A longer code is the durable fix.

A third per-stall limit, held in memory the same way, covers `POST /api/owner/closing/donation`: 20 recorded donations in a rolling hour. The route records what the Donate button reported and nothing proves the money moved, so without a limit anyone with the public demo password could fill the demo ledger with donation rows. A refused request and a repeated transaction ID spend no allowance, and the refusal returns 429 with plain wording.

The owner login throttle now ignores a `CF-Connecting-IP` value that is not an IP address and falls back to the connection address. The ingress contract named under Follow-up is still unverified.

`pnpm audit --json` reports the same eight advisories.
