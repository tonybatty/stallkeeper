import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
import BuyerOffer from './components/BuyerOffer.vue';
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const item = { code: 'K7Q2', name: 'Brass lamp', notes: 'Tested. Scuff on base', askingPence: 2800, mode: 'haggle', seeded: false };
const card = { id: 'issued-card', itemName: item.name, code: item.code, totalPence: 2400, kind: 'counter', note: "Price checked against the stallholder's rules", expiresAt: '2026-11-05T12:30:00Z' };
const initial = { item, stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null, card: null, agreedPrice: null };
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let responseCard: typeof card | null;
let rejectAccept: boolean;
let lastTurn: boolean;
let chatReply: string;
let captureState: string;
let postState: string;
let startFails: boolean;
let checkoutTotal: number;
let pageBody: object;
let chatFailure: (() => Response) | null;
let paypalSession: { onApprove: (approval: { orderId: string }) => Promise<void>; onCancel: () => Promise<void> };
const live = (state: string) => ({ checkoutId: 'checkout1', paypalOrderId: 'ORDER1', state, totalPence: checkoutTotal, reservedUntil: new Date(Date.now() + 300_000).toISOString(), reviewRequired: false });
beforeEach(() => {
  responseCard = card; rejectAccept = false; lastTurn = false; chatReply = 'I can do £24. Tap Accept if that works for you.'; captureState = 'paid'; postState = 'awaiting_approval'; startFails = false; checkoutTotal = 2400; pageBody = {}; chatFailure = null;
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: (callbacks: typeof paypalSession) => { paypalSession = callbacks; return { start: async (_options: unknown, order: Promise<unknown>) => { await order; if (startFails) throw new Error('PayPal closed'); } }; } }) });
  fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (String(url).endsWith('/chat') && chatFailure) return chatFailure();
    if (String(url).endsWith('/chat')) {
      const payload = JSON.parse(String(init?.body));
      return Response.json({ reply: chatReply, ...(payload.offerPence === undefined ? {} : { message: 'Would you take £15?' }), turnsLeft: lastTurn ? 0 : 19, chatAvailable: !lastTurn, card: responseCard, agreedPrice: null });
    }
    if (String(url).endsWith('/accept')) return rejectAccept ? Response.json({}, { status: 409 }) : Response.json({ agreedPrice: card });
    if (String(url).endsWith('/checkout') && init?.method === 'POST') return Response.json(live(postState));
    if (String(url).startsWith('/api/checkouts/') && init?.method !== 'POST') return Response.json(live(postState));
    if (String(url).endsWith('/capture')) return Response.json(live(captureState));
    if (/\/(sdk-)?cancel$/.test(String(url))) return Response.json(live('cancelled'));
    return Response.json({ ...initial, ...pageBody });
  });
  vi.stubGlobal('fetch', fetcher);
});
async function page(body: object = {}) {
  pageBody = body;
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push('/i/K7Q2'); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}
async function open() {
  const wrapper = await page();
  await wrapper.findAll('button').find(button => button.text() === 'Ask or make an offer')!.trigger('click');
  return wrapper;
}
it('posts structured pence, shows the server card, and pays the tapped agreement with no client total', async () => {
  const wrapper = await open();
  await wrapper.findAll('button').find(button => button.text() === 'Make an offer')!.trigger('click');
  await wrapper.find('#buyer-offer').setValue('15.00');
  await wrapper.find('#buyer-offer').element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/i/K7Q2/chat', expect.objectContaining({ body: JSON.stringify({ offerPence: 1500 }) }));
  const offer = wrapper.find('.offer-card');
  for (const text of ["Stallkeeper's offer: £24", "Checked against the stallholder's limits", 'Accept £24', "Lasts 30 minutes. It doesn't hold the item."]) expect(offer.text()).toContain(text);
  expect(wrapper.find('.from-buyer').text()).toBe('You: Would you take £15?');
  expect(wrapper.text()).not.toContain('Agreed price £24');
  expect(wrapper.find('.checkout').isVisible()).toBe(false);
  await offer.find('button').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/i/K7Q2/cards/issued-card/accept', { method: 'POST' });
  expect(wrapper.text()).toContain('Agreed price £24. Not paid yet.');
  // At payment PayPal's button is the one filled button, so the way back to the chat is a text link.
  expect(wrapper.findAll('button').find(button => button.text() === 'View your chat')!.classes()).toEqual(['text-button']);
  expect(wrapper.find('.checkout .total').text()).toContain('£24');
  expect(wrapper.find('.price-chip').exists()).toBe(false);
  expect(wrapper.find('.checkout').text().match(/£24/g)).toHaveLength(1); expect(wrapper.find('.checkout .status-pill').exists()).toBe(false); expect(wrapper.find('.checkout').text()).toContain('Take it only when this page says Paid.');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/i/K7Q2/checkout', expect.objectContaining({ body: JSON.stringify({ agreedPriceId: card.id }) }));
});
it('never makes a card from model prose and never agrees on a rejected tap', async () => {
  responseCard = null;
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.text()).toContain('I can do £24'); expect(wrapper.find('.offer-card').exists()).toBe(false);
  responseCard = card;
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  rejectAccept = true;
  await wrapper.find('.offer-card button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('This price is no longer available.');
  expect(wrapper.text()).not.toContain('Agreed price £24');
});
it('keeps the last allowed turn card visible after chat reaches its cap', async () => {
  lastTurn = true;
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.find('.offer-card').text()).toContain('Accept £24');
});
it('shows an agreed amount restored from the server directly above PayPal', async () => {
  fetcher.mockImplementation(async url => Response.json(url === '/api/config' ? { clientId: 'test' } : { ...initial, agreedPrice: card, chatAvailable: false }));
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push('/i/K7Q2'); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } }); await flushPromises();
  expect(wrapper.text()).toContain('Agreed price £24. Not paid yet.');
  expect(wrapper.find('.checkout .total').text()).toBe('Agreed price £24');
  expect(wrapper.find('paypal-button').exists()).toBe(true);
});
it('stops saying not paid once an agreed checkout starts, and never beside Paid, take it', async () => {
  const wrapper = await page({ agreedPrice: card });
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.text()).not.toContain('Not paid yet');
  await paypalSession.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(wrapper.find('.checkout h2').text()).toBe('Paid, take it');
  expect(wrapper.text()).not.toContain('Not paid yet');
  expect(wrapper.text()).not.toContain('Leave it here');
});
it('says checking, not not paid, while a capture is unresolved', async () => {
  captureState = 'checking';
  const wrapper = await page({ agreedPrice: card });
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await paypalSession.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(wrapper.text()).toContain("Checking payment. Please don't pay again.");
  expect(wrapper.text()).not.toContain('Not paid yet');
});
it('shows the agreed price again after the buyer cancels PayPal', async () => {
  const wrapper = await page({ agreedPrice: card });
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await paypalSession.onCancel(); await flushPromises();
  expect(wrapper.find('.checkout [role=status]').text()).toBe('Checkout cancelled. Your agreed price is still shown below.');
  expect(wrapper.find('.checkout [role=status]').element.compareDocumentPosition(wrapper.find('.checkout .notice').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(wrapper.find('.checkout .notice').text()).toContain('Agreed price £24. Not paid yet.');
});
it('keeps the agreed price beside another buyer\'s reservation', async () => {
  const wrapper = await page({ agreedPrice: card, availability: 'reserved', chatAvailable: false });
  expect(wrapper.text()).toContain('Agreed price £24. Not paid yet.');
  expect(wrapper.text()).toContain('Someone is paying for this now.');
  expect(wrapper.find('paypal-button').exists()).toBe(false);
  expect(wrapper.find('.item-card h1').text()).toBe('Brass lamp');
});
it('recovers a card issued before a failed send, without reopening chat', async () => {
  const wrapper = await open();
  chatFailure = () => Response.json({ chatAvailable: false }, { status: 503 }); pageBody = { card };
  await wrapper.find('#chat-question').setValue('£24'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.offer-card').text()).toContain('Accept £24');
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.text()).toContain('Chat is unavailable.');
});
it('recovers a card when the send never got a response', async () => {
  const wrapper = await open();
  vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
  chatFailure = () => { throw new Error('Network down'); }; pageBody = { card };
  await wrapper.find('#chat-question').setValue('£24'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.offer-card').text()).toContain('Accept £24');
});
it('keeps a held counter on screen after a mistyped above-asking offer', async () => {
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  chatReply = 'That offer is above the asking price of £28. It has been refused for review.';
  await wrapper.findAll('button').find(button => button.text() === 'Make an offer')!.trigger('click');
  await wrapper.find('#buyer-offer').setValue('240.00');
  await wrapper.find('#buyer-offer').element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(wrapper.text()).toContain('It has been refused for review.');
  await wrapper.find('.offer-card button').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/i/K7Q2/cards/issued-card/accept', { method: 'POST' });
  expect(wrapper.text()).toContain('Agreed price £24. Not paid yet.');
});
const chatEntry = (wrapper: Awaited<ReturnType<typeof page>>) => wrapper.findAll('button').some(button => button.text() === 'Ask or make an offer');
it('takes a held offer card and the chat entry away while a checkout holds the item, through to paid', async () => {
  const wrapper = await page({ card, agreedPrice: { ...card, id: 'agreed-card', totalPence: 2300 } });
  expect(wrapper.find('.offer-card').exists()).toBe(true); expect(chatEntry(wrapper)).toBe(true);
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.find('.offer-card').exists()).toBe(false); expect(chatEntry(wrapper)).toBe(false);
  await paypalSession.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(wrapper.find('.checkout h2').text()).toBe('Paid, take it');
  expect(wrapper.find('.offer-card').exists()).toBe(false); expect(chatEntry(wrapper)).toBe(false);
});
it('gives the held card and chat entry back when the buyer cancels PayPal', async () => {
  const wrapper = await page({ card });
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await paypalSession.onCancel(); await flushPromises();
  expect(wrapper.find('.offer-card').text()).toContain('Accept £24'); expect(chatEntry(wrapper)).toBe(true);
});
it('pays a card accepted after cancelling a checkout at the asking price', async () => {
  checkoutTotal = 2800;
  const wrapper = await page({ card });
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await paypalSession.onCancel(); await flushPromises();
  expect(wrapper.find('.checkout h2').text()).toBe('Checkout stopped');
  expect(wrapper.text()).not.toContain('Checkout total');
  await wrapper.find('.offer-card button').trigger('click'); await flushPromises();
  expect(wrapper.find('.checkout h2').text()).toBe('Review and pay');
  expect(wrapper.find('.checkout .total').text()).toBe('Agreed price £24');
  expect(wrapper.find('.price-chip').exists()).toBe(false);
  expect(wrapper.find('.checkout').text().match(/£24/g)).toHaveLength(1); expect(wrapper.find('.checkout .status-pill').exists()).toBe(false); expect(wrapper.find('.checkout').text()).toContain('Take it only when this page says Paid.');
  expect(wrapper.text()).not.toContain('Checkout total');
  expect(wrapper.find('.paypal-container').isVisible()).toBe(true);
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/i/K7Q2/checkout', expect.objectContaining({ body: JSON.stringify({ agreedPriceId: card.id }) }));
});
it('announces Stallkeeper\'s offer and agreed price in a status region mounted before either arrives', async () => {
  const wrapper = await open();
  const region = wrapper.find('main > [role=status]').element;
  expect(region.textContent).toBe('');
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('main > [role=status]').element).toBe(region);
  expect(region.textContent).toBe("Stallkeeper's offer: £24 for Brass lamp.");
  await wrapper.find('.offer-card button').trigger('click'); await flushPromises();
  expect(wrapper.find('main > [role=status]').element).toBe(region);
  expect(region.textContent).toContain('Agreed price £24. Not paid yet.');
});
it('shows no card beside a checkout restored from the server', async () => {
  const wrapper = await page({ card, checkout: live('awaiting_approval') });
  expect(wrapper.find('.offer-card').exists()).toBe(false); expect(chatEntry(wrapper)).toBe(false);
});
it('keeps the live checkout state when a parent refresh brings an older copy of it', async () => {
  vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
  postState = 'capturing'; startFails = true;
  const wrapper = await page();
  pageBody = { checkout: live('awaiting_approval') };
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Confirming your payment. Leave the item here for now.');
  expect(wrapper.find('.paypal-container').isVisible()).toBe(false);
});
const pressed = (wrapper: Awaited<ReturnType<typeof page>>, label: string) => wrapper.findAll('button').find(button => button.text() === label)!.trigger('click');
// The pay card says to take the item only once the page says Paid, so the chat carries no not-paid note of its own.
it('adds no not-paid note under the chat, even with an offer to accept', async () => {
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('Has it been paid?'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.offer-card').exists()).toBe(true);
  expect(wrapper.find('.composer').text()).not.toContain('Not paid yet');
});
it('drops the chat once this buyer is paid', async () => {
  lastTurn = true;
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('£15'); await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  await pressed(wrapper, 'Back to the item');
  await wrapper.find('paypal-button').trigger('click'); await flushPromises();
  await paypalSession.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(wrapper.find('.checkout h2').text()).toBe('Paid, take it');
  // The paid screen replaces the item page, so there is no chat left to reopen.
  expect(wrapper.find('.buyer-chat').exists()).toBe(false);
});
const chip = (wrapper: Awaited<ReturnType<typeof open>>, label: string) => wrapper.findAll('.chat-prompts button').find(button => button.text() === label);
const chatCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/chat'));
it('shows prompt buttons before a conversation and sends the fixed text as a normal turn', async () => {
  const wrapper = await open();
  expect(wrapper.findAll('.chat-prompts button').map(button => button.text())).toEqual(['Make an offer', 'Does it work?', 'Any damage?']);
  for (const button of wrapper.findAll('.chat-prompts button')) expect(button.attributes('type')).toBe('button');
  await chip(wrapper, 'Any damage?')!.trigger('click'); await flushPromises();
  expect(JSON.parse(String(chatCalls()[0]?.[1]?.body))).toEqual({ message: 'Any damage?' });
  expect(wrapper.text()).toContain('You: Any damage?');
  expect(wrapper.text()).not.toContain('turns left');
  expect(wrapper.findAll('.chat-prompts button').map(button => button.text())).toEqual(['Make an offer']);
});
it('opens the offer box from the offer chip without sending text or scrolling', async () => {
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  const wrapper = await open();
  await chip(wrapper, 'Make an offer')!.trigger('click'); await flushPromises();
  expect(chip(wrapper, 'Make an offer')!.attributes('aria-expanded')).toBe('true');
  const input = wrapper.find('#buyer-offer').element;
  expect(document.activeElement).toBe(input);
  expect(scroll).not.toHaveBeenCalled();
  expect(chatCalls()).toHaveLength(0);
});
it('focuses the offer box without scrolling when the offer chip opens mid-conversation', async () => {
  const wrapper = await open();
  await chip(wrapper, 'Does it work?')!.trigger('click'); await flushPromises();
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  const toggle = wrapper.findAll('button').find(button => button.text() === 'Make an offer')!;
  (toggle.element as HTMLElement).focus();
  await toggle.trigger('click'); await flushPromises();
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(wrapper.find('#buyer-offer').exists()).toBe(true);
  expect(document.activeElement).toBe(wrapper.find('#buyer-offer').element);
  expect(scroll).not.toHaveBeenCalled();
});
it('keeps a typed question and offer when a prompt button sends', async () => {
  const wrapper = await open();
  await wrapper.find('#chat-question').setValue('Is the flex original?');
  await chip(wrapper, 'Make an offer')!.trigger('click');
  await wrapper.find('#buyer-offer').setValue('22.00');
  await chip(wrapper, 'Does it work?')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('You: Does it work?');
  expect((wrapper.find('#chat-question').element as HTMLTextAreaElement).value).toBe('Is the flex original?');
  expect((wrapper.find('#buyer-offer').element as HTMLInputElement).value).toBe('22.00');
});
it('hides the chips once chat has ended', async () => {
  lastTurn = true;
  const wrapper = await open();
  await chip(wrapper, 'Does it work?')!.trigger('click'); await flushPromises();
  expect(wrapper.find('.chat-prompts').exists()).toBe(false);
  const unavailable = await page({ chatAvailable: false });
  expect(unavailable.find('.chat-prompts').exists()).toBe(false);
});

it('says Accepting while the accept request is in flight', () => {
  const card = { id: 'card', kind: 'counter', itemName: 'Brass lamp', code: 'K7Q2', totalPence: 2400 } as never;
  expect(mount(BuyerOffer, { props: { card, busy: false } }).find('button').text()).toBe('Accept £24');
  const busy = mount(BuyerOffer, { props: { card, busy: true } }).find('button');
  expect([busy.text(), busy.attributes('disabled')]).toEqual(['Accepting…', '']);
});

it('keeps the draft and lets a buyer retry after chat admission is limited', async () => {
  const wrapper = await open();
  chatFailure = () => Response.json({ error: 'Internal detail must not be shown' }, { status: 429 });
  await wrapper.find('#chat-question').setValue('Does it work?');
  await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.text()).toContain('Stallkeeper is busy. Please try again in a minute.');
  expect(wrapper.text()).not.toContain('Internal detail');
  expect(wrapper.find<HTMLInputElement>('#chat-question').element.value).toBe('Does it work?');
  expect(wrapper.find('#chat-question').attributes('disabled')).toBeUndefined();
  expect(wrapper.findAll('.from-buyer')).toHaveLength(0);
  chatFailure = null;
  await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
  expect(wrapper.find('.from-buyer').text()).toContain('Does it work?');
  expect(wrapper.text()).not.toContain('Stallkeeper is busy');
});
