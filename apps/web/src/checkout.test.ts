import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CheckoutPayment from './components/CheckoutPayment.vue';
import type { Checkout } from './items.js';
import { buyer } from '../../../tools/capture/selectors.js';
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const c: Checkout = { checkoutId: 'checkout1', state: 'awaiting_approval', paypalOrderId: 'ORDER1', reservedUntil: new Date(Date.now() + 300_000).toISOString(), totalPence: 2800, reviewRequired: false };
let callbacks: { onApprove: (data: { orderId: string }) => Promise<void>; onCancel: () => Promise<void> };
const start = vi.fn();
beforeEach(() => {
  start.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('paypal', { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: () => true }), createPayPalOneTimePaymentSession: (value: typeof callbacks) => { callbacks = value; return { start }; } }) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/config' ? { clientId: 'test' } : c)));
});
it.each(['creating', 'awaiting_approval', 'capturing', 'checking', 'paid', 'expired', 'cancelled', 'failed'] as const)('allows collection only when %s is paid', async state => {
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 3000, initial: { ...c, state } } });
  await flushPromises();
  expect(wrapper.text().includes('Paid, take it')).toBe(state === 'paid');
  expect(wrapper.text()).toContain('£28');
});
it('totals a stopped checkout at the agreed price the buyer now holds', async () => {
  const agreedPrice = { id: 'agreed', itemName: 'Brass lamp', code: 'K7Q2', totalPence: 2400, kind: 'counter' as const, note: 'Checked', expiresAt: '2026-11-05T12:30:00Z' };
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, state: 'cancelled' }, agreedPrice } });
  await flushPromises();
  expect(wrapper.find('.total').text()).toBe('Total £24');
});
it('blocks collection even for a paid checkout that requires review', async () => {
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, state: 'paid', reviewRequired: true } } });
  await flushPromises(); expect(wrapper.text()).not.toContain('Paid, take it'); expect(wrapper.text()).toContain('speak to the stallholder');
});
it('passes the invoked checkout promise to the blue PayPal button session and captures approval', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/config' ? { clientId: 'test' } : url.endsWith('/capture') ? { ...c, state: 'paid' } : c));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: null } });
  await flushPromises();
  const button = wrapper.find('paypal-button'); expect(button.classes()).toContain('paypal-blue');
  await button.trigger('click'); await flushPromises();
  expect(start).toHaveBeenCalledWith({ presentationMode: 'auto' }, expect.any(Promise));
  expect(await start.mock.calls[0]![1]).toEqual({ orderId: 'ORDER1' });
  expect(wrapper.text()).toContain('Reserved for you'); expect(wrapper.text()).not.toContain('Paid, take it');
  await callbacks.onApprove({ orderId: 'ORDER1' }); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/checkouts/checkout1/capture', expect.objectContaining({ method: 'POST', body: '{}' }));
  expect(wrapper.text()).toContain('Paid, take it');
});
it('polls a checking checkout without offering another payment and shows the recovered sale', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fetcher = vi.fn(async () => Response.json({ ...c, state: 'paid' }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, state: 'checking' } } });
  await flushPromises();
  expect(wrapper.text()).toContain("Checking payment. Please don't pay again.");
  expect(wrapper.find('paypal-button').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Paid, take it');
  await vi.advanceTimersByTimeAsync(3000); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/checkouts/checkout1', expect.objectContaining({ method: 'GET' }));
  expect(wrapper.text()).toContain('Paid, take it');
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('offers Finish payment on return after approval and uses the existing capture route', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/config' ? { clientId: 'test' } : { ...c, state: 'paid' }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, approvedAt: new Date().toISOString() } } });
  await flushPromises();
  const finish = wrapper.findAll('button').find(button => button.text() === 'Finish payment');
  expect(finish).toBeDefined();
  expect(wrapper.find('.paypal-container').attributes('style')).toContain('display: none');
  await finish!.trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/checkouts/checkout1/capture', expect.objectContaining({ method: 'POST' }));
  expect(start).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('Paid, take it');
});
it('does not offer Finish payment beyond the reservation deadline', async () => {
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, approvedAt: '2020-01-01T12:00:00Z', reservedUntil: '2020-01-01T12:05:00Z' } } });
  await flushPromises();
  expect(wrapper.text()).not.toContain('Finish payment');
});
it('keeps item, tag and stored total while approval moves through checking to paid', async () => {
  let captured = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (url.endsWith('/capture')) { captured = true; return Response.json({ ...c, state: 'checking', totalPence: 2400 }); }
    return Response.json({ ...c, totalPence: 2400, state: captured ? 'paid' : 'awaiting_approval' });
  }));
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 3000, initial: { ...c, totalPence: 2400 } } });
    await flushPromises();
    expect(wrapper.findAll('paypal-button')).toHaveLength(1);
    await callbacks.onApprove({ orderId: 'ORDER1' }); await flushPromises();
    expect(wrapper.find('h2').text()).toBe('Checking payment');
    expect(wrapper.find('[role=status]').text()).toContain("Please don't pay again");
    expect(wrapper.find('.paypal-container').attributes('style')).toContain('display: none');
    expect(wrapper.find('.checkout-item').text()).toContain('Brass lamp');
    expect(wrapper.find('.checkout-item').text()).toContain('Tag K7Q2');
    expect(wrapper.find('.total').text()).toBe('Total £24');
    const liveRegion = wrapper.find('[role=status]').element;
    await vi.advanceTimersByTimeAsync(3000); await flushPromises();
    expect(wrapper.find('h2').text()).toBe('Paid, take it');
    expect(wrapper.find('.paid-screen').text()).toContain('£24');
    expect(wrapper.find('[role=status]').element).toBe(liveRegion);
    expect(liveRegion.textContent).toBe('Paid, take it. Take the Brass lamp with tag K7Q2. Take the item with this tag.');
    expect(wrapper.emitted('checkout')?.at(-1)).toEqual([expect.objectContaining({ state: 'paid', totalPence: 2400 })]);
    wrapper.unmount();
  } finally { vi.useRealTimers(); }
});
it('sends the SDK cancel to the rechecking route and the Cancel checkout button to the plain one', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === '/api/config' ? { clientId: 'test' } : { ...c, state: 'cancelled' }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: c } });
  await flushPromises();
  await callbacks.onCancel(); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/checkouts/checkout1/sdk-cancel', expect.objectContaining({ method: 'POST' }));
  fetcher.mockClear();
  await wrapper.setProps({ initial: { ...c, checkoutId: 'checkout2' } }); await flushPromises();
  await wrapper.find('button.sec').trigger('click'); await flushPromises();
  expect(fetcher).toHaveBeenCalledWith('/api/checkouts/checkout2/cancel', expect.objectContaining({ method: 'POST' }));
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('sdk-cancel'))).toBe(false);
});

it('gives the buttons back when the PayPal popup closes before the order exists', async () => {
  let answer: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/config' ? Response.json({ clientId: 'test' }) : new Promise<Response>(resolve => { answer = resolve; })));
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: null } });
  await flushPromises();
  await wrapper.find('paypal-button').trigger('click');
  await callbacks.onCancel();
  answer(Response.json(c)); await flushPromises();
  expect(wrapper.text()).toContain('Reserved for you');
  expect(wrapper.find('.paypal-container').classes()).not.toContain('busy');
  expect(wrapper.findAll('button').find(button => button.text() === 'Cancel checkout')!.attributes('disabled')).toBeUndefined();
  expect(wrapper.text()).not.toContain('Opening PayPal');
});
it('keeps Paid, take it when a poll sent before the capture answers after it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let answerPoll: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    if (url.endsWith('/capture')) return Response.json({ ...c, state: 'paid' });
    return new Promise<Response>(resolve => { answerPoll = resolve; });
  }));
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, approvedAt: new Date().toISOString() } } });
  await flushPromises();
  await vi.advanceTimersByTimeAsync(3000);
  await wrapper.findAll('button').find(button => button.text() === 'Finish payment')!.trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('Paid, take it');
  answerPoll(Response.json(c)); await flushPromises();
  expect(wrapper.text()).toContain('Paid, take it');
  expect(wrapper.emitted('checkout')?.at(-1)).toEqual([expect.objectContaining({ state: 'paid' })]);
});
it('keeps Paid, take it when a poll sent during the capture answers after it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let answerPoll: (value: Response) => void = () => {};
  let answerCapture: (value: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config') return Response.json({ clientId: 'test' });
    return new Promise<Response>(resolve => { if (url.endsWith('/capture')) answerCapture = resolve; else answerPoll = resolve; });
  }));
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass lamp', askingPence: 2800, initial: { ...c, approvedAt: new Date().toISOString() } } });
  await flushPromises();
  await wrapper.findAll('button').find(button => button.text() === 'Finish payment')!.trigger('click'); await flushPromises();
  await vi.advanceTimersByTimeAsync(3000);
  answerCapture(Response.json({ ...c, state: 'paid' })); await flushPromises();
  expect(wrapper.text()).toContain('Paid, take it');
  answerPoll(Response.json(c)); await flushPromises();
  expect(wrapper.text()).toContain('Paid, take it');
  expect(wrapper.emitted('checkout')?.at(-1)).toEqual([expect.objectContaining({ state: 'paid' })]);
});

const agreedPrice = { id: 'agreed', itemName: 'Brass desk lamp', code: 'K7Q2', totalPence: 2400, kind: 'counter' as const, note: 'Checked', expiresAt: '2026-11-05T12:30:00Z' };
const mountState = async (state: Checkout['state'], extra: object = {}, price?: typeof agreedPrice) => {
  const wrapper = mount(CheckoutPayment, { props: { code: 'K7Q2', itemName: 'Brass desk lamp', askingPence: 2800, initial: { ...c, state, totalPence: 2400, ...extra }, agreedPrice: price } });
  await flushPromises();
  return wrapper;
};
it('shows the stored amount, item and tag code on the paid screen, under the Paid, take it heading', async () => {
  const wrapper = await mountState('paid');
  expect(wrapper.find('h2').text()).toBe('Paid, take it');
  expect(wrapper.find('.paid-screen p').text()).toBe('Brass desk lamp · £24');
  expect(wrapper.find('.paid-screen .code').text()).toBe('K7Q2');
  expect(wrapper.find('[role=status]').text()).toBe('Paid, take it. Take the Brass desk lamp with tag K7Q2. Take the item with this tag.');
  expect(wrapper.find('[role=status] .sr-only').text()).toBe('Paid, take it. Take the Brass desk lamp with tag K7Q2.');
});
// Every animation the page's parsed style rules give this element, each with the media condition its rule sits under ('' for none).
function animationsOn(element: Element) {
  const found: Array<{ media: string; animation: string }> = [];
  const walk = (rules: CSSRuleList, media: string) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, rule.conditionText);
      else if (rule instanceof CSSStyleRule && element.matches(rule.selectorText)) {
        const animation = rule.style.animation || rule.style.animationName;
        if (animation) found.push({ media, animation });
      }
    }
  };
  for (const sheet of document.styleSheets) walk(sheet.cssRules, '');
  return found;
}
it('draws the paid tick as a stroke and plays the paid moment only for buyers who allow motion', async () => {
  const wrapper = await mountState('paid');
  expect(wrapper.find('.tick svg path').exists()).toBe(true);
  const allowsMotion = '(prefers-reduced-motion: no-preference)';
  expect(animationsOn(wrapper.find('.tick').element)).toEqual([{ media: allowsMotion, animation: expect.stringMatching(/^paid-land/) }]);
  expect(animationsOn(wrapper.find('.tick path').element)).toEqual([{ media: allowsMotion, animation: expect.stringMatching(/^paid-draw/) }]);
  expect(animationsOn(wrapper.find('.paid-tag').element)).toEqual([{ media: allowsMotion, animation: expect.stringMatching(/^paid-pop/) }]);
});
it.each([
  ['capturing', 'Confirming your payment. Leave the item here for now.'],
  ['checking', "Checking payment. Please don't pay again."],
  ['failed', 'Payment did not complete. Try another payment method.'],
  ['expired', 'Your reservation ran out and no payment was taken. Start again if the item is still here.'],
  ['cancelled', 'Checkout cancelled. No payment was taken.'],
] as const)('uses the fixed %s copy', async (state, copy) => {
  const wrapper = await mountState(state);
  expect(wrapper.find('[role=status]').text()).toBe(copy);
  expect(wrapper.text()).not.toContain('Paid, take it');
});
it.each([
  ['failed', {}, 'Payment did not complete. Try another payment method.'],
  ['expired', {}, 'Your reservation ran out and no payment was taken. Start again if the item is still here.'],
  ['cancelled', {}, 'Checkout cancelled. No payment was taken.'],
  ['paid', { reviewRequired: true }, 'Payment needs checking. Please leave the item here and speak to the stallholder.'],
] as const)('lets the capture script see a %s checkout end without payment', async (state, extra, copy) => {
  const wrapper = await mountState(state, extra);
  expect(buyer.checkoutEnded.exec(wrapper.find('[role=status]').text())?.[0]).toBe(copy);
});
it.each(['awaiting_approval', 'capturing', 'checking', 'paid'] as const)('does not end the capture script on a %s checkout', async state => {
  const wrapper = await mountState(state);
  expect(buyer.checkoutEnded.test(wrapper.text())).toBe(false);
});
it('tells a cancelled buyer the agreed price is shown below, and shows it there', async () => {
  const wrapper = await mountState('cancelled', {}, agreedPrice);
  expect(wrapper.find('[role=status]').text()).toBe('Checkout cancelled. Your agreed price is still shown below.');
  const notice = wrapper.find('.notice');
  expect(notice.text()).toContain('Agreed price £24.');
  expect(wrapper.find('[role=status]').element.compareDocumentPosition(notice.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('names the agreed price on the cancel control only when the buyer has one', async () => {
  const cancelLabel = (wrapper: Awaited<ReturnType<typeof mountState>>) => wrapper.findAll('button').map(button => button.text()).filter(text => text.startsWith('Cancel'));
  expect(cancelLabel(await mountState('awaiting_approval', {}, agreedPrice))).toEqual(['Cancel and keep my agreed price']);
  expect(cancelLabel(await mountState('awaiting_approval'))).toEqual(['Cancel checkout']);
});
