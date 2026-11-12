# Stallkeeper Postman collection

Import `stallkeeper.postman_collection.json` as a Postman collection. It covers the implemented application API, not direct credential-bearing PayPal endpoints. The server owns those external calls. No credentials or external-service mocks are bundled, and no Postman run is claimed.

## Local setup

1. Follow the root README: `pnpm install --frozen-lockfile`, then `pnpm dev`.
2. Keep `baseUrl` at `http://localhost:5173`. Use one origin consistently so cookies match. Set local `ownerPassword` to `owner` for the main stall or `demo` for the seeded stall. For a hosted service, supply the configured password as a private local value; do not export it into the committed collection.
3. Enable the Postman cookie jar. Owner login stores the owner cookie. Opening an item stores the separate buyer cookie. Use a different cookie jar for a second buyer. Browser and Postman cookies are not automatically shared.
4. Send requests individually. This is a reference collection with alternative and destructive operations, not a "Run all" success script. Reset changes demo stock and codes; remove, close and cancel each alter the selected journey. The SSE request stays open until cancelled.

## Credential-free stock and closing walkthrough

Send Owner login, Create haggle item, Open trading session, and Open item. The create response saves `itemId` and `code`. Read the owner list, tag data and public item. Close trading session saves `sessionId`. Read closing report, which the server builds when the stall closes, and which starts the AI summary on its own. Record closing exception is optional: `absent` flags an unsold item as not at the stall, `unknown` clears the flag, and a scripted flag should be labelled as scripted. Write closing summary only retries a summary and spends model tokens. Check closing with PayPal runs only when sent and reads sandbox orders and changes nothing. Use `removed` with a non-empty `reason` for a recorded removal. This also takes available stock off sale; correcting the observation can restore it unless a completed capture exists.

For the seeded stall, set the owner password to `demo`, log in and read `/api/demo` and Owner items. Select a matching item ID and code manually. Reset is a separate optional operation which generates new codes, so refresh variables afterwards. Payments still in progress block reset; flagged checkouts do not, and their items stay available for review. Photo uploads require the main stall and configured Supabase Storage; choose a JPEG at most 512 KiB in the binary body picker. Do not send the empty file placeholder.

## Chat and payment walkthrough

Chat requires an Anthropic key, an open stall and an available haggle item. Open item first, then ask a question or submit a structured offer. A returned card sets `cardId`; accepting it sets `agreedPriceId`. Select either asking-price checkout with `{}` or agreed-price checkout with the stored ID. The server does not ignore extra fields: it rejects an amount in the request for fixed and haggle items. A pay-what-you-want item is the exception. Create it with Create pay-what-you-want item, open it, and send Reserve at a chosen amount with `amountPence`; it has no chat and no card. An amount below the item's public `minimumPence`, or above £500, gets a 422 that states the limit and reserves nothing. Prices are integer pence in this API.

A checkout request requires configured PayPal sandbox credentials and records `checkoutId` and `paypalOrderId`. Genuine approval takes place through PayPal's sandbox browser flow, not this collection. For an end-to-end payment, use the app's buyer page and its own cookie/session throughout. To inspect a manually approved Postman-created order, keep the original Postman buyer cookie and approve that exact order before calling capture. Never substitute a different browser checkout ID. The owner can send Recheck flagged payment with a checkout ID from the feed to read PayPal evidence again. A successful check can leave it unresolved. Read checkout after uncertainty; do not create another payment to guess whether the first succeeded.

Unavailable and error responses are expected, and each says something: no AI configuration disables chat, absent payment credentials prevent order creation, an unavailable item or stale card gives a conflict, and another buyer's checkout cannot be read with this cookie. A successful order or approval is not a completed capture. Collection requests do not fake payment success.

## Webhooks and evidence

Use real PayPal dashboard delivery/resend for external acceptance. The webhook request is a manual reference: set all five transmission headers and paste the exact original event body from the same delivery. `{}` with empty headers deliberately supplies no valid signature. The API also needs the matching webhook ID. Do not edit signed event amounts to simulate a failure and then call it a real verified event. Never commit tokens, signatures or account credentials.

Mocked failure scenarios are reproducible with `pnpm test`; see [evidence](../docs/EVIDENCE.md). Postman does not provide browser approval, service credentials, automatic assertions of physical collection or a live sandbox proof. A successful manual run needs a dated redacted result tied to its commit and exact scenario.
