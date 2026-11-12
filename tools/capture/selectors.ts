// Every label, selector and path the sale script reads from the app, in one place. When a screen
// changes, edit this file and nothing else. A control is found by its CSS selector and, when set,
// the exact trimmed text of the element, so a button is found by what the buyer reads on it.

export interface Control { css: string; text?: string }

export const paths = {
  ownerLogin: '/owner/login',
  ownerHome: '/owner',
  ownerTags: '/owner/tags',
  ownerFeed: '/owner/feed',
  ownerClosing: '/owner/closing',
  item: (code: string) => `/i/${code}`,
};

export const owner = {
  password: { css: 'input[type=password]' },
  logIn: { css: 'button', text: 'Log in' },
  addItem: { css: 'a', text: 'Add item' },
  itemForm: { css: '.item-form' },
  // The item form's fields, by the start of their label.
  field: { name: 'Name', notes: 'What buyers should know', mode: 'Price mode', asking: 'Asking price', floor: "Lowest you'd take" },
  haggleMode: 'haggle',
  // The counter-offer ladder the form previews once a haggle item has an asking price and a floor.
  ladderPreview: '.ladder-preview',
  save: { css: 'button', text: 'Save item' },
  openStall: { css: 'button', text: 'Open stall' },
  closeStall: { css: '[data-test=close-stall]' },
  // Closing a stall takes the owner to the closing page, whose heading is "Closing".
  closingPage: /Closing report/,
  // The closing report is built when the stall closes, and each group is a card headed by its label.
  reportHeading: { css: 'h2', text: 'Closing report' },
  reportGroup: 'section.card',
  // Shown on the Items page, where saving an item lands, and on the Stall tab once the stall is open.
  itemName: { css: '.stock-row b' },
  stallOpen: /Stall open/i,
  // iOS offers to save the password after login, over the page, and only dismissing it clears it.
  savePasswordDecline: `type == 'XCUIElementTypeButton' AND label == 'Not Now'`,
  printedTag: { css: '.printed-tag' },
  // The text of the code on a printed tag, such as "· K7Q2".
  tagCode: '.tag-code',
  // One sale on the feed. A sale's webhook mark sits inside its row, so find the row by its tag code.
  feedSale: 'ol.feed-list li',
  // The takings tile above the list. Scrolled to the top of the screen, they leave room beneath them for the sale's row.
  feedTotals: '.takings',
  feedVerified: '.verified',
};

export const buyer = {
  itemName: 'h1',
  price: '.price-chip',
  // Its label carries the asking price, so it is found by class and not by text.
  buyNow: { css: 'button.buy-now' },
  askQuestion: { css: 'button', text: 'Ask or make an offer' },
  questionBox: '#chat-question',
  // The send buttons show an arrow, so they are found by their accessible name.
  send: { css: 'button[aria-label="Send"]' },
  // Messages in the thread only. The opening bubble shares the class but goes once the chat starts, so counting it would undercount replies.
  chatReply: '.thread .chat-message',
  chatReplyLabel: 'Stallkeeper:',
  backToItem: { css: 'button', text: 'Back to the item' },
  // The reservation notice a second buyer sees.
  reservedNotice: /Someone is paying for this now/,
  // PayPal's button is a native control labelled "Pay with PayPal"; the container is the DOM element to scroll to.
  paypalContainer: '.paypal-container',
  // The paid screen's item and price line, "Wooden stool · £24", which reads the paid amount.
  paidItemLine: '.paid-screen h2 + p',
  // The status line. It shows "Take the item with this tag." after a completed capture, after a screen-reader-only "Paid, take it." sentence, and the failure copy otherwise.
  checkoutStatus: '[role=status]',
  // The paid status line, which the page shows only after a completed capture.
  paid: /Take the item with this tag\./,
  // The copy of a checkout that stopped without payment, up to the end of its line.
  checkoutEnded: /(Checkout cancelled|Payment did not complete|Your reservation ran out|Payment needs checking)[^\n]*/,
  paypalNative: `type == 'XCUIElementTypeButton' AND label == 'Pay with PayPal' AND visible == 1`,
  // Safari shows a tip about its menu the first time it opens on a fresh simulator, over the bottom of the page.
  safariTipClose: `type == 'XCUIElementTypeButton' AND label == 'Close'`,
  // The first chip above the question box, shown for the whole chat. It opens the offer box.
  makeOffer: { css: 'button', text: 'Make an offer' },
  offerBox: '#buyer-offer',
  sendOffer: { css: 'button[aria-label="Send offer"]' },
  // The server's card for a price. Its total is the amount the buyer may accept, and its button reads "Accept £N".
  offerCard: '.offer-card',
  offerTotal: '.offer-card .offer-total',
  acceptOffer: { css: '.offer-card button' },
};

// PayPal's own page. These are in its DOM only, never the native tree.
export const paypal = {
  email: '#email',
  password: '#password',
  // The buttons have no ids, so they are found by their text.
  next: 'Next',
  logIn: 'Log In',
  // PayPal's own approve button, on the page after login. Its text is "Pay" once the page is ready and "Loading..." while it works.
  pay: '#one-time-cta',
  reviewPath: '/pay/checkout',
  declinedPath: '/pay/generic-error',
  // Shown over the login form when PayPal does not accept the buyer's email and password.
  loginRejected: /Check your info and try again|Too many password attempts/,
  // The field is in the DOM while PayPal's loading spinner still covers it, so check what is on top.
  emailShowing: `
    const field = document.querySelector('#email');
    if (!field) return false;
    const box = field.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!top && top.closest('form') === field.closest('form');
  `,
};
