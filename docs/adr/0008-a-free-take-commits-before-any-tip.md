# A free take commits before any tip, and a tip never touches the item

A free item must always be takeable, whatever happens to the tip a buyer adds on the same page. The take is therefore its own record, written in one transaction that locks the item row, with no PayPal call, and a tip is a separate checkout that can start only after that take. A tip never reserves, sells or releases the item and does not count as the buyer's one reservation, so cancelling it, declining it or letting it expire leaves the item taken, and two phones on one tag meet only the row lock: one wins and the other is told the item has gone.

## Considered Options

- Reserve the free item, then take it when the tip's capture completes: reuses the pay-what-you-want reservation, but a buyer who cancels at PayPal holds the item for five minutes and then loses the take they were promised.
- Take the item only when the tip is paid or skipped: the same stranding, and the free take would depend on PayPal being reachable.
- Record a free take as a £0 checkout: the capture rules (ADR 0004) and the amount constraints assume money, and a £0 order would reach PayPal's cross-check as a missing capture.

## Consequences

A tip is a `kind='tip'` checkout through the same create, capture, webhook and repair code as a pay-what-you-want amount. Its completed capture is still the only proof of payment (ADR 0004), and it counts in recorded sales. The taker's thank-you message lives on the take, runs from taker to owner only, and is never given to the AI stallholder. A reply from the owner is not built, and the take row leaves room for one.
