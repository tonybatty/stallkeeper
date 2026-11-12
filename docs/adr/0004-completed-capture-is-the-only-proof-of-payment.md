# A completed capture is the only proof of payment, from either source

A sale commits when PayPal reports a capture status of `COMPLETED` with the expected order and amount, whether that arrives in the capture API response or a verified webhook, through the same update code. Webhook-only would leave the buyer waiting on delivery and stranded by a lost event. Approval, a pending capture, an order-level `COMPLETED` and browser callbacks are never proof. The webhook still confirms each sale visibly in the owner's feed, and unique capture IDs stop the two sources counting the same money twice.
