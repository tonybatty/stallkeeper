import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const item = { code: 'K7Q2', name: 'Brass lamp', notes: 'Tested. Scuff on base', askingPence: 2800, mode: 'haggle', seeded: false };
const card = { id: 'issued-card', itemName: item.name, code: item.code, totalPence: 2400, kind: 'counter', note: "Price checked against the stallholder's rules", expiresAt: '2026-11-05T12:30:00Z' };
const initial = { item, stallName: 'Garden stall', availability: 'available', chatAvailable: true, checkout: null, card: null, agreedPrice: null, messages: [] };
const label = 'Stallkeeper, looking after Garden stall';
let pageBody: object;
let reply: { reply: string; card: typeof card | null };
beforeEach(() => {
  pageBody = {}; reply = { reply: 'I can offer £24. Choose the card to agree.', card };
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: () => ({ start: async () => undefined }) }) });
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (String(url).endsWith('/chat') && init?.method === 'POST') return Response.json({ ...reply, turnsLeft: 19, chatAvailable: true, agreedPrice: null });
    return Response.json({ ...initial, ...pageBody });
  }));
});
async function page(body: object = {}) {
  pageBody = body;
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push('/i/K7Q2'); await router.isReady();
  const wrapper = mount(App, { attachTo: document.body, global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}
type Wrapper = Awaited<ReturnType<typeof page>>;
type PayPalCallbacks = { onApprove: (data: { orderId: string }) => Promise<void>; onCancel: () => Promise<void> };
const button = (wrapper: Wrapper, text: string) => wrapper.findAll('button').find(candidate => candidate.text() === text);
const before = (first: Element, second: Element) => !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
async function ask(wrapper: Wrapper, question = '£15') {
  await wrapper.find('#chat-question').setValue(question);
  await wrapper.find('.chat-form').trigger('submit'); await flushPromises();
}

it('opens a haggle item with Ask or make an offer as the primary button above a secondary Buy now naming the asking price', async () => {
  const wrapper = await page();
  expect(wrapper.text()).not.toContain("You'll chat with Stallkeeper. It answers from the stallholder's notes.");
  const buy = button(wrapper, 'Buy now for £28')!;
  const askButton = button(wrapper, 'Ask or make an offer')!;
  expect(buy.isVisible()).toBe(true); expect(askButton.isVisible()).toBe(true);
  expect(before(askButton.element, buy.element)).toBe(true);
  expect(askButton.classes()).not.toContain('sec'); expect(buy.classes()).toContain('sec');
  expect(wrapper.find('#tag-code').exists()).toBe(false);
  expect(wrapper.find('.checkout').isVisible()).toBe(false);
  expect(wrapper.text()).toContain('Scuff on base');
});
describe('item photo', () => {
  // The page's own stylesheet, applied to the test document, so the photo's frame is the one the browser cascade resolves against the shared height rules.
  const sheet = document.createElement('style');
  beforeAll(() => {
    sheet.textContent = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');
    document.head.append(sheet);
  });
  afterAll(() => sheet.remove());

  it.each(['haggle', 'fixed', 'pwyw', 'free'])('shows a %s item photo above its name, price and condition notes', async mode => {
    const wrapper = await page({ item: { ...item, mode, illustration: 'lamp', photoUrl: '/lamp.jpg' } });
    const photo = wrapper.get('img.buyer-photo');
    expect(photo.attributes()).toMatchObject({ src: '/lamp.jpg', alt: item.name });
    const frame = getComputedStyle(photo.element);
    expect([frame.objectFit, frame.aspectRatio, frame.height, frame.maxHeight]).toEqual(['cover', '4 / 3', 'auto', 'none']);
    expect(wrapper.find('.item-illustration').exists()).toBe(false);
    expect(before(photo.element, wrapper.get('h1').element)).toBe(true);
    expect(before(photo.element, wrapper.get('.price-chip').element)).toBe(true);
    expect(wrapper.get('.row').element.nextElementSibling).toBe(wrapper.get('.notes').element);
    expect(wrapper.get('.notes').text()).toContain(item.notes);
  });
});
it('keeps a missing or failed photo readable and loads a replacement on navigation', async () => {
  const wrapper = await page({ item: { ...item, photoUrl: null } });
  expect(wrapper.get('.photo-placeholder').text()).toBe('No photo added');
  pageBody = { item: { ...item, code: 'L8R3', photoUrl: '/broken.jpg' } };
  await wrapper.vm.$router.push('/i/L8R3'); await flushPromises();
  await wrapper.get('img.buyer-photo').trigger('error');
  expect(wrapper.find('img.buyer-photo').exists()).toBe(false);
  expect(wrapper.get('.photo-placeholder').text()).toBe('No photo added');
  expect(wrapper.get('h1').text()).toBe(item.name);
  pageBody = { item: { ...item, code: 'M9S4', photoUrl: '/replacement.jpg' } };
  await wrapper.vm.$router.push('/i/M9S4'); await flushPromises();
  expect(wrapper.get('img.buyer-photo').attributes('src')).toBe('/replacement.jpg');
});
it('keeps the demo illustration when an item has no photograph', async () => {
  const wrapper = await page({ item: { ...item, illustration: 'lamp', photoUrl: null } });
  expect(wrapper.get('.item-illustration').attributes('aria-label')).toBe('Plain illustration, not a photograph');
  expect(wrapper.find('.buyer-photo').exists()).toBe(false);
});
it('takes Buy now to Review and pay with the total directly above the PayPal button, without remounting the checkout', async () => {
  const wrapper = await page();
  const checkout = wrapper.find('.checkout').element;
  const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
  await button(wrapper, 'Buy now for £28')!.trigger('click'); await flushPromises();
  expect(wrapper.find('.checkout').element).toBe(checkout);
  expect(wrapper.find('.checkout').isVisible()).toBe(true);
  expect(wrapper.find('.checkout h2').text()).toBe('Review and pay');
  expect(before(wrapper.find('.checkout .total').element, wrapper.find('.paypal-container').element)).toBe(true);
  expect(wrapper.find('.buy-now').exists()).toBe(false);
  expect(wrapper.find('.item-card').exists()).toBe(false);
  expect(wrapper.findAll('p').some(line => line.text() === label && line.isVisible())).toBe(false);
  expect(document.activeElement).toBe(checkout);
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  expect(button(wrapper, 'Ask or make an offer')!.isVisible()).toBe(true);
});
it.each([
  ['approved after its reservation lapsed', (session: PayPalCallbacks) => session.onApprove({ orderId: 'ORDER1' }), 'Payment could not be confirmed. Refresh to check your checkout before trying again.'],
  ['cancelled', (session: PayPalCallbacks) => session.onCancel(), 'Take it only when this page says Paid.'],
])('shows the checkout card, not the landing, on a full-page return from PayPal %s', async (_outcome, resume, status) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: (session: PayPalCallbacks) => ({ start: async () => undefined, hasReturned: () => true, resume: () => resume(session) }) }) });
  const wrapper = await page();
  expect(wrapper.find('.checkout').isVisible()).toBe(true);
  expect(wrapper.find('.checkout [role=status]').text()).toBe(status);
  expect(wrapper.find('.buy-now').exists()).toBe(false);
});
it('goes straight to paying for a fixed item, an agreed price and a held checkout', async () => {
  const fixed = await page({ item: { ...item, mode: 'fixed' }, chatAvailable: false });
  expect(fixed.find('.checkout').isVisible()).toBe(true); expect(fixed.find('.buy-now').exists()).toBe(false);
  expect(fixed.find('.checkout').classes()).toContain('compact'); expect(fixed.find('.checkout h2').exists()).toBe(false);
  expect(fixed.find('#tag-code').exists()).toBe(false);
  const agreed = await page({ agreedPrice: card });
  expect(agreed.find('.checkout').isVisible()).toBe(true); expect(agreed.find('.buy-now').exists()).toBe(false);
  expect(agreed.find('.checkout .total').text()).toBe('Agreed price £24');
  const held = await page({ checkout: { checkoutId: 'checkout1', paypalOrderId: 'ORDER1', state: 'awaiting_approval', totalPence: 2800, reservedUntil: new Date(Date.now() + 300_000).toISOString(), reviewRequired: false } });
  expect(held.find('.checkout').isVisible()).toBe(true); expect(held.find('.buy-now').exists()).toBe(false);
});
it('goes straight to paying when chat is unavailable and nothing was said', async () => {
  const wrapper = await page({ chatAvailable: false });
  expect(wrapper.find('.checkout').isVisible()).toBe(true); expect(wrapper.find('.buy-now').exists()).toBe(false);
});
it('shows the offer card without leaving the landing screen', async () => {
  const wrapper = await page({ card });
  expect(wrapper.find('.offer-card').text()).toContain('Accept £24');
  expect(wrapper.find('.checkout').isVisible()).toBe(false);
});

const transcript = [
  { role: 'user', content: 'Does it work?' }, { role: 'assistant', content: 'The stallholder says it works.' },
];
it('restores this buyer\'s conversation after a reload and calls the landing button View your chat', async () => {
  const wrapper = await page({ messages: transcript });
  expect(button(wrapper, 'Ask or make an offer')).toBeUndefined();
  await button(wrapper, 'View your chat')!.trigger('click');
  expect(wrapper.findAll('.chat-message').map(line => line.text())).toEqual(['You: Does it work?', 'Stallkeeper: The stallholder says it works.']);
  // Visible speaker label on AI bubbles only; hidden from assistive tech so the sr-only prefix is the single announcement.
  const labels = wrapper.findAll('.thread .speaker');
  expect(labels.map(label => label.text())).toEqual(['Stallkeeper AI']);
  expect(labels[0]!.attributes('aria-hidden')).toBe('true');
  expect(wrapper.find('#chat-question').exists()).toBe(true);
  await ask(wrapper, 'How tall is it?');
  expect(wrapper.findAll('.chat-message')).toHaveLength(4);
});
it('keeps a restored conversation readable once chat has closed', async () => {
  const wrapper = await page({ messages: transcript, chatAvailable: false });
  expect(wrapper.find('.buy-now').exists()).toBe(true);
  await button(wrapper, 'View your chat')!.trigger('click');
  expect(wrapper.findAll('.chat-message')).toHaveLength(2);
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.text()).toContain('Chat has ended');
});
const stoppedCheckout = (state: string) => ({ checkoutId: 'checkout1', paypalOrderId: 'ORDER1', state, totalPence: 2400, reservedUntil: new Date(Date.now() + 300_000).toISOString(), reviewRequired: false });
const heldPage = { agreedPrice: card, availability: 'reserved', chatAvailable: false, checkout: stoppedCheckout('awaiting_approval') };
it.each([
  ['a page load', heldPage],
  ['a refresh during the visit', { agreedPrice: card, checkout: stoppedCheckout('failed') }],
])('reopens the chat after the buyer\'s own checkout, when the hold was seen on %s', async (_when, start) => {
  const pageFetch = fetch;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => String(url).startsWith('/api/checkouts/') ? Response.json(stoppedCheckout('cancelled')) : pageFetch(url, init)));
  const wrapper = await page({ messages: transcript, ...start });
  if (start !== heldPage) {
    pageBody = { messages: transcript, ...heldPage };
    await button(wrapper, 'Check availability and try again')!.trigger('click'); await flushPromises();
  }
  await button(wrapper, 'View your chat')!.trigger('click');
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  await button(wrapper, 'Back to the item')!.trigger('click');
  await button(wrapper, 'Cancel and keep my agreed price')!.trigger('click'); await flushPromises();
  pageBody = { messages: transcript, agreedPrice: card, checkout: stoppedCheckout('cancelled') };
  await button(wrapper, 'Check availability and try again')!.trigger('click'); await flushPromises();
  await button(wrapper, 'View your chat')!.trigger('click');
  expect(wrapper.find('#chat-question').isVisible()).toBe(true);
  expect(wrapper.text()).not.toContain('Chat has ended');
});
it('keeps chat closed after a failed send, even when a refresh reports chat as available', async () => {
  const pageFetch = fetch;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => init?.method === 'POST' ? Response.json({ chatAvailable: false }, { status: 503 }) : pageFetch(url, init)));
  const wrapper = await page({ messages: transcript, checkout: stoppedCheckout('cancelled') });
  await button(wrapper, 'View your chat')!.trigger('click');
  await ask(wrapper);
  expect(wrapper.text()).toContain('Chat has ended');
  await button(wrapper, 'Back to the item')!.trigger('click');
  await button(wrapper, 'Check availability and try again')!.trigger('click'); await flushPromises();
  await button(wrapper, 'View your chat')!.trigger('click');
  expect(wrapper.find('#chat-question').exists()).toBe(false);
  expect(wrapper.text()).toContain('Chat has ended');
});
it('says View your chat after a conversation in this visit too', async () => {
  const wrapper = await page();
  await button(wrapper, 'Ask or make an offer')!.trigger('click');
  await ask(wrapper);
  await button(wrapper, 'Back to the item')!.trigger('click');
  expect(button(wrapper, 'View your chat')!.isVisible()).toBe(true);
  expect(button(wrapper, 'Ask or make an offer')).toBeUndefined();
});

it('greets in one line with the rules folded, and folds the whole opening once a conversation has started', async () => {
  const wrapper = await page();
  await button(wrapper, 'Ask or make an offer')!.trigger('click');
  expect(wrapper.find('.buyer-chat .bubble.intro').text()).toBe("I'm Stallkeeper, looking after this stall.");
  const rules = wrapper.find('.buyer-chat details.opening');
  expect(rules.attributes('open')).toBeUndefined(); expect(rules.text()).toContain("Offers are checked against the stallholder's rules");
  await ask(wrapper);
  expect(wrapper.find('.buyer-chat .bubble.intro').exists()).toBe(false);
  const opening = wrapper.find('.buyer-chat details.opening');
  expect(opening.exists()).toBe(true); expect(opening.attributes('open')).toBeUndefined();
  expect(opening.text()).toContain("I'm Stallkeeper, looking after this stall.");
  expect(wrapper.find('.app-titlebar').text()).toBe('Stallkeeper');
});

function viewport(top: number, bottom: number, buttonBottom: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.chat-message:last-child')) return { top, bottom, height: bottom - top } as DOMRect;
    // The speaker label is its own element, 22px above the newest AI bubble.
    if (this.matches('.speaker:nth-last-child(2)')) return { top: top - 22, bottom: top - 4, height: 18 } as DOMRect;
    if (this.matches('.offer-card button')) return { top: buttonBottom - 52, bottom: buttonBottom, height: 52 } as DOMRect;
    return { top: 0, bottom: 0, height: 0 } as DOMRect;
  });
  vi.stubGlobal('innerHeight', 844);
}
it('scrolls to reveal the Accept button when a card arrives below the fold, without moving focus', async () => {
  const wrapper = await page();
  await button(wrapper, 'Ask or make an offer')!.trigger('click');
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  viewport(560, 640, 1100);
  await ask(wrapper);
  expect(scrollBy).toHaveBeenCalledTimes(1);
  expect(scrollBy).toHaveBeenCalledWith({ top: 1100 + 12 - 844, behavior: 'smooth' });
  expect(focus).not.toHaveBeenCalled();
});
it('scrolls a long reply that has no card until its speaker label clears the title bar, and leaves a message already in view alone', async () => {
  reply = { reply: 'A long answer', card: null };
  const wrapper = await page();
  await button(wrapper, 'Ask or make an offer')!.trigger('click');
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  viewport(700, 2000, 0);
  await ask(wrapper);
  expect(scrollBy).toHaveBeenLastCalledWith({ top: 700 - 22 - 12, behavior: 'smooth' });
  scrollBy.mockClear();
  viewport(300, 400, 0);
  await ask(wrapper, 'And the height?');
  expect(scrollBy).not.toHaveBeenCalled();
});
it('jumps instead of gliding when the device asks for reduced motion', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
  const wrapper = await page();
  await button(wrapper, 'Ask or make an offer')!.trigger('click');
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  viewport(560, 640, 1100);
  await ask(wrapper);
  expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
});
it('scrolls to the newest message when a restored conversation is opened', async () => {
  const wrapper = await page({ messages: transcript });
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  viewport(900, 980, 0);
  await button(wrapper, 'View your chat')!.trigger('click'); await flushPromises();
  expect(scrollBy).toHaveBeenCalledWith({ top: 980 + 12 - 844, behavior: 'smooth' });
});
