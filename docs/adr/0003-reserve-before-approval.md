# Reserve the item before PayPal approval, then capture immediately

Two buyers must never both pay for one physical item, and a database rollback cannot undo a capture. Pressing Pay reserves the item for five minutes, approval is followed by immediate capture, and a second buyer cannot reach a payable checkout. An expired reservation never revives, even if the item is still free, and a capture that has started is never released by the timer.

## Considered Options

- Reserving just before capture: safe, but a buyer can finish PayPal approval and then lose the item.
- Authorise, then capture: adds void and expiry handling and still needs the same lock.
- Capture both and refund the loser: rejected, because the losing buyer pays for goods they cannot have.
