# Price drops never publish a figure worked out from the floor, and tags carry no price

Late in the trading day Claude may propose lowering an unsold item's asking price, so a printed price would go stale. Tags therefore carry the item name, QR code, fallback line and one line that fits every sale type, "Take it only when the page says it is yours.", and the buyer reads the live price after scanning. The old "Pay first" line goes because a free item needs no payment, and a different line on free tags would be a sale type. This replaces story 13 and the tag copy in issue #6.

Later change: the take line is no longer printed, so each tag has room for a larger QR code and tag code, six to an A4 sheet. The item page itself says when the item is the buyer's, and the rest of this decision stands. The fallback line went later too, when the owner asked for a simpler tag, so a tag now carries the item name, QR code and tag code.

As with counter-offers (ADR 0005), the model suggests and the server decides. The model never sees the floor, or anything worked out from it. A drop must be at most 20% of the current asking price and leave at least a quarter of the gap between asking price and floor, or it is refused. Refused, not moved to the limit: a price moved to the limit would be a published figure computed from the floor, and with the repository public a buyer who saw both prices could work the floor back out. So a published price depends only on the old asking price and the proposal, and the asking price never lands on the floor. ADR 0001's claim stands: no price below the floor is ever agreed. That claim does not hide the floor from a buyer who knows the counter-offer rule. A counter-offer is worked out from the floor, so one counter-offer is enough to work the floor back out.

An item with a live reservation or a live agreed price is held out of the review, because a buyer that close means the item is selling, and because a lower asking price would otherwise fail `validateOffer` against their agreed amount at checkout. A drop otherwise behaves as an owner's price edit does: it bumps the price version, which ends open offer cards. The price stays down after closing until the owner changes it.

## Considered Options

- Move a proposal to the nearest allowed price: more drops would land, but the published price would carry the floor.
- Give the model a list of allowed prices: the list's length would tell the model about the floor, which ADR 0001 keeps from it.
- Keep agreed prices alive across a drop: needs checkout to honour a total above the asking price, and changes bargaining code for a buyer who could then see a lower price than the one they agreed.
- A scheduled job or external cron: the service already runs one 30-second timer on one instance (ADR 0007). The review has its own guard on that timer, so a model call never delays payment repair.
