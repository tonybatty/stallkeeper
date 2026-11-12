# Stallkeeper

The language of an unstaffed stall where printed tags lead buyers to an AI that answers questions and handles offers within the owner's limits, and the buyer pays in PayPal.

## People and agents

**Stallholder**:
The person who runs the stall, sets its prices and reads its recorded sales. Usually nearby but busy, not staffing the table. App labels that name the role keep "owner", such as "Owner login" and owner-only pages, and code calls this person the owner.
_Avoid_: Seller, merchant, shopkeeper

**Buyer**:
A person at the stall who scans a tag to ask about, bargain for or pay for an item. Needs no Stallkeeper account.
_Avoid_: Customer, user

**Stallkeeper** (the AI):
The AI that looks after the stall and deals with buyers on the stallholder's behalf, within limits the stallholder set.
_Avoid_: AI stallholder, shopkeeper, bot, assistant

**Buyer session**:
One buyer's anonymous visit, which agreed prices and checkouts belong to.
_Avoid_: Account, login

## The stall

**Stallkeeper**:
The product, and the name of its AI that deals with buyers. Never the person.

**Stall**:
One owner's collection of items on sale in one place.
_Avoid_: Shop, store

**Demo stall**:
A seeded stall kept for judges to try, separate from the owner's main stall.
_Avoid_: Test stall

**Item**:
One physical thing or declared set on the stall, sold whole through one tag.
_Avoid_: Product, listing

**Tag**:
The printed label on an item, carrying its QR code and short code.
_Avoid_: Label, sticker, QR

## Prices

**Asking price**:
The price the owner displays for an item, which a buyer can pay without bargaining.
_Avoid_: List price, RRP

**Floor**:
The lowest price the owner will accept for an item, private from buyers. Every `haggle` item has one, and a `fixed` item has one only to allow price drops. Owner-facing copy may say "your minimum".
_Avoid_: Reserve, minimum price, lowest price

**Pricing mode**:
How an item's price is set: `fixed` at the asking price, `haggle` between the asking price and the floor, `pwyw` (pay what you want), where the buyer chooses the amount, or `free`, where the buyer takes the item with no payment. For `pwyw` the asking price is the owner's expected amount, an optional figure for the owner's own records that is never sent to buyers, and the owner may set a minimum, which buyers do see. For `free` it is the owner's expected tip, optional and never sent to buyers either.
_Avoid_: Price type

**Minimum**:
The lowest amount a buyer can pay for a `pwyw` item, set by the owner and shown to buyers. Unlike a floor, it is public.
_Avoid_: Floor

**Offer**:
A price a buyer puts to Stallkeeper for an item.
_Avoid_: Bid

**Counter-offer**:
A price Stallkeeper puts to a buyer in reply to their offer. It binds nobody until the buyer accepts it.
_Avoid_: Proposal, quote

**Offer card**:
A server-issued card naming an item, its tag and a total, which the buyer taps to make that total the agreed price.
_Avoid_: Quote

**Agreed price**:
A price the buyer and Stallkeeper have settled for an item. It does not reserve the item or take payment.
_Avoid_: Deal, accepted offer

**Price review**:
Claude's look at a stall's unsold items late in a trading session, at most twice per session, proposing lower asking prices that the server accepts or refuses.
_Avoid_: Repricing

**Price drop**:
A lower asking price the server accepted from a price review, with its old price, new price and reason on record. It never touches a floor, and it stays until the owner changes the price.
_Avoid_: Markdown, discount, sale

## Selling

**Reservation**:
A buyer's short, exclusive right to pay for an item, starting when they press Pay.
_Avoid_: Hold, lock

**Checkout**:
One attempt by a buyer to pay for a reservation or a tip, ending in a sale or tip, or ending without one. PayPal's side of it is the PayPal order.
_Avoid_: Order, payment

**Sale**:
An item and the completed capture that paid for it. Approval alone is never a sale.
_Avoid_: Purchase, transaction

**Take**:
A buyer's claim on a free item, recorded the moment they tap Take it, with no payment and no PayPal step. It is the only buyer action that ends a free item's time on sale, and it is never a sale.
_Avoid_: Free sale, claim

**Tip**:
Money a buyer chooses to pay through PayPal for an item they have already taken free. It is a checkout with its own capture, counts in recorded sales, and never holds, sells or releases the item. It is not a reservation, so it does not stop the buyer reserving another item.
_Avoid_: Donation, payment for the item

**Thank-you message**:
A short plain-text note, at most 280 characters, that the taker of a free item leaves for the owner. It is a stranger's text, so it is shown as text and never given to Stallkeeper.
_Avoid_: Review, comment

## Closing

**Trading session**:
One period of a stall being open, from opening until every checkout admitted before Close has finished or is flagged for the owner.
_Avoid_: Day, shift

**Closing time**:
The time of day, UK time, the owner usually packs up, which sets when price reviews run. It does not close the stall.
_Avoid_: Close, end of day

**Flagged item**:
An unsold item the owner marks as not at the stall from the closing report. It is optional: with no flag, an unsold item counts as still at the stall and a sold or taken item counts as gone with its buyer.
_Avoid_: Shelf check, stocktake, inventory

**Recorded sales**:
The total of completed captures in a trading session, less completed refunds. Tips are included. It says nothing about what left the table.
_Avoid_: Takings, revenue

**Pledge**:
The whole-number percentage of a session's recorded sales that the owner promises to a named charity, shown to buyers in one line and worked out on the closing report. The amount is rounded down to the penny. A session's pledge is fixed from its first recorded sale, so a later change applies from the next session and cannot rewrite its report.
_Avoid_: Commission, cut

**Donation**:
A payment made through PayPal's Donate button towards the pledge. Kept apart from sales: it is never a capture, never changes recorded sales, and the closing report records only what the button reported.
_Avoid_: Payout, transfer

**Stall ledger**:
The owner's read-only report across every session: what sold, how offers went and whether PayPal agrees. The closing report stays the record of a session.
_Avoid_: Dashboard, analytics

**Stall clerk**:
The AI agent on the stall ledger that answers the owner's questions from the stall's records. It reads and never changes anything. It is part of Stallkeeper, and is not the AI that talks to buyers.
_Avoid_: Bot, assistant

**Closing report**:
The list of a trading session's items by what was recorded against them, built when the stall closes. Provisional only while a payment is unresolved, and it reports differences without accusing anyone.
_Avoid_: Reconciliation, audit
