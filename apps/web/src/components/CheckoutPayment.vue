<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { PayPalV6Namespace } from '@paypal/paypal-js/sdk-v6';
import { agreedNotice, holdsItem, money, parsePence } from '../items.js';
import type { Checkout, OfferCard } from '../items.js';
// For a pay-what-you-want item the buyer types the amount to pay. The field starts empty and the card names no suggested figure,
// so the amount is the buyer's own choice; only the owner's minimum, if set, is shown.
// A tip is the same checkout on a free item, with no suggested tip either. It is offered only after the take,
// so that cancelling or abandoning the tip can never cost the buyer the item.
const props = defineProps<{ code: string; itemName: string; askingPence: number | null; initial: Checkout | null; agreedPrice?: OfferCard | null; payWhatYouWant?: boolean; minimumPence?: number | null; tip?: boolean; demoStall?: boolean; compact?: boolean; beforeOrder?: () => Promise<string> }>();
const emit = defineEmits<{ checkout: [value: Checkout]; refresh: [remount?: boolean]; holding: [value: boolean]; returned: [] }>();
const checkout = ref(props.initial);
watch(() => props.initial, value => { if (value && value.checkoutId !== checkout.value?.checkoutId) checkout.value = value; });
const container = ref<HTMLDivElement>();
const message = ref('Loading PayPal…');
const refusal = ref('');
const ready = props.tip ? 'A tip is optional, and the item is yours either way. Tips are paid in PayPal.' : 'Take it only when this page says Paid.';
const busy = ref(false);
const clock = ref(Date.now());
let disposed = false;
let polling = false;
const timeLeft = computed(() => {
  const seconds = Math.max(0, Math.ceil((Date.parse(checkout.value?.reservedUntil ?? '') - clock.value) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
});
const payable = computed(() => !checkout.value || (!checkout.value.reviewRequired && ['awaiting_approval', 'creating'].includes(checkout.value.state)));
const finishable = computed(() => checkout.value?.state === 'awaiting_approval' && !!checkout.value.approvedAt &&
  !checkout.value.reviewRequired && Date.parse(checkout.value.reservedUntil) > clock.value);
const saleConfirmed = computed(() => !props.tip && checkout.value?.state === 'paid' && !checkout.value?.reviewRequired);
const holding = computed(() => !!checkout.value && holdsItem(checkout.value));
// The agreed price is shown as the total, labelled Agreed price, until a checkout holds the item or is cancelled.
const showAgreed = computed(() => !!props.agreedPrice && !holding.value && checkout.value?.state !== 'cancelled');
const amountText = ref('');
// Only before a checkout exists. Once the server has reserved an amount it is the stored total that is shown and paid.
const choosingAmount = computed(() => !!props.payWhatYouWant && !checkout.value);
const amountPence = computed(() => parsePence(amountText.value) || null);
const total = computed(() => holding.value ? checkout.value!.totalPence : choosingAmount.value ? amountPence.value : props.agreedPrice?.totalPence ?? checkout.value?.totalPence ?? props.askingPence ?? 0);
watch(holding, value => emit('holding', value), { immediate: true });
watch(amountText, () => { refusal.value = ''; });
const tipStatus = computed(() => {
  const c = checkout.value;
  if (c?.tipRefunded) return 'Your tip was refunded. The item is still yours.';
  if (c?.reviewRequired) return 'Your tip needs checking. The item is still yours.';
  if (c?.state === 'paid') return `Thank you. Your tip of ${money(c.totalPence)} was received.`;
  if (c?.state === 'capturing') return 'Confirming your tip. The item is still yours.';
  if (c?.state === 'checking') return "Checking your tip. Please don't pay again.";
  if (c?.state === 'expired') return 'Your tip ran out of time and nothing was taken. The item is still yours.';
  if (c?.state === 'failed') return 'Your tip did not complete and nothing was taken. The item is still yours.';
  if (c?.state === 'cancelled') return 'Tip cancelled and nothing was taken. The item is still yours.';
  if (finishable.value) return 'PayPal approved your tip. Finish it to send it.';
  return refusal.value || message.value;
});
const status = computed(() => {
  if (props.tip) return tipStatus.value;
  const c = checkout.value;
  if (c?.reviewRequired) return 'Payment needs checking. Please leave the item here and speak to the stallholder.';
  if (c?.state === 'paid') return 'Take the item with this tag.';
  if (c?.state === 'capturing') return 'Confirming your payment. Leave the item here for now.';
  if (c?.state === 'checking') return "Checking payment. Please don't pay again.";
  if (c?.state === 'expired') return 'Your reservation ran out and no payment was taken. Start again if the item is still here.';
  if (c?.state === 'failed') return 'Payment did not complete. Try another payment method.';
  if (c?.state === 'cancelled') return props.agreedPrice ? 'Checkout cancelled. Your agreed price is still shown below.' : 'Checkout cancelled. No payment was taken.';
  if (finishable.value) return 'PayPal approved your payment. Finish payment before taking the item.';
  return refusal.value || message.value;
});
let posts = 0;
async function api(path: string, post = false): Promise<Checkout> {
  if (post) posts++;
  const sent = posts;
  try {
    const response = await fetch(path, { method: post ? 'POST' : 'GET', ...(post ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(path.endsWith('/checkout') ? props.payWhatYouWant ? { amountPence: amountPence.value } : props.agreedPrice ? { agreedPriceId: props.agreedPrice.id } : {} : {}) } : {}), signal: AbortSignal.timeout(45_000) });
    if (!response.ok && response.status !== 409 && response.status !== 422) throw new Error(`Checkout request failed: ${response.status}`);
    const value = await response.json();
    if (!value.checkoutId) { refusal.value = value.error ?? ''; throw new Error('Checkout unavailable'); }
    // A poll sent before a cancel or capture finished can answer after it with the older state, so its answer is dropped.
    if (!disposed && (post || sent === posts)) { checkout.value = value; emit('checkout', value); }
    return value;
  } finally { if (post) posts++; }
}
async function refresh() {
  if (!checkout.value || polling) return;
  polling = true;
  try { await api(`/api/checkouts/${checkout.value.checkoutId}`); }
  catch (error) { console.error('Checkout refresh failed', error); }
  finally { polling = false; }
}
function failure(error: unknown) {
  console.error('Checkout could not complete', error);
  message.value = refusal.value ? ready : props.tip ? 'Your tip could not be confirmed. Refresh to check before trying again.' : 'Payment could not be confirmed. Refresh to check your checkout before trying again.';
  busy.value = false;
  void refresh();
}
// The SDK's onCancel uses sdk-cancel, which asks PayPal first and captures an approved order. The button never captures.
async function cancel(sdk = false) {
  // The popup can close before the order exists. There is nothing to cancel yet, and the buttons must come back.
  if (!checkout.value) { busy.value = false; message.value = ready; return; }
  try { await api(`/api/checkouts/${checkout.value.checkoutId}/${sdk ? 'sdk-cancel' : 'cancel'}`, true); busy.value = false; }
  catch (error) { failure(error); }
}
async function capture() {
  if (!checkout.value || busy.value) return;
  busy.value = true;
  checkout.value = { ...checkout.value, state: 'capturing' };
  try { await api(`/api/checkouts/${checkout.value.checkoutId}/capture`, true); }
  catch (error) { failure(error); }
  finally { busy.value = false; }
}
const timer = setInterval(() => { clock.value = Date.now(); }, 1000);
const poll = setInterval(() => { void refresh(); }, 3000);
onUnmounted(() => { disposed = true; clearInterval(timer); clearInterval(poll); });
onMounted(async () => {
  if (!payable.value) { message.value = ''; return; }
  try {
    const config = await fetch('/api/config').then(response => { if (!response.ok) throw new Error('Config unavailable'); return response.json(); });
    const sdk = await new Promise<PayPalV6Namespace>((resolve, reject) => {
      const existing = (window as unknown as { paypal?: PayPalV6Namespace }).paypal;
      if (existing) { resolve(existing); return; }
      const script = document.createElement('script');
      script.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core'; script.async = true;
      script.onload = () => resolve((window as unknown as { paypal: PayPalV6Namespace }).paypal);
      script.onerror = () => reject(new Error('PayPal could not load'));
      document.head.append(script);
    });
    if (disposed) return;
    const instance = await sdk.createInstance({ clientId: config.clientId, components: ['paypal-payments'], locale: 'en-GB', pageType: 'checkout' });
    const methods = await instance.findEligibleMethods({ currencyCode: 'GBP' });
    if (!methods.isEligible('paypal')) { message.value = 'PayPal is not available in this browser. Please try another browser.'; return; }
    const session = instance.createPayPalOneTimePaymentSession({
      async onApprove({ orderId }) {
        if (!checkout.value || checkout.value.paypalOrderId !== orderId) { failure(new Error('Approval does not match checkout')); return; }
        busy.value = false;
        await capture();
      },
      onCancel: () => cancel(true),
      onError: failure,
    });
    const button = document.createElement('paypal-button');
    button.className = 'paypal-blue'; button.setAttribute('type', 'pay');
    button.addEventListener('click', () => {
      if (busy.value || !payable.value) return;
      if (choosingAmount.value && amountPence.value === null) { refusal.value = `Enter an amount of at least ${props.minimumPence && !props.tip ? money(props.minimumPence) : '1p'}.`; return; }
      busy.value = true;
      refusal.value = '';
      message.value = 'Opening PayPal…';
      const order = Promise.resolve(props.beforeOrder?.()).then(refused => {
        if (refused) { refusal.value = refused; throw new Error('Checkout not started'); }
        return api(`/api/i/${encodeURIComponent(props.code)}/checkout`, true);
      }).then(c => {
        if (c.state !== 'awaiting_approval' || !c.paypalOrderId || c.reviewRequired) throw new Error('Checkout is not payable');
        return { orderId: c.paypalOrderId };
      });
      void session.start({ presentationMode: 'auto' }, order).catch(error => { failure(error); emit('refresh', false); });
    });
    if (!disposed) container.value?.append(button);
    message.value = ready;
    if (session.hasReturned?.()) { emit('returned'); await session.resume?.(); }
  } catch (error) {
    // Before the button exists no order can, so nothing was paid: say PayPal did not load rather than that payment is unconfirmed.
    if (!container.value?.childElementCount) { console.error('PayPal could not load', error); message.value = `PayPal did not load, so nothing was ${props.tip ? 'sent' : 'paid'}. Refresh the page to try again.`; return; }
    failure(error);
  }
});
</script>
<template>
  <!-- The whole screen is the confirmation, and it exists only for a completed capture. -->
  <section class="checkout" :class="saleConfirmed ? 'paid-screen' : ['card', { compact }]" tabindex="-1" :aria-label="compact && !saleConfirmed ? `Pay for ${itemName}` : undefined">
    <template v-if="saleConfirmed">
    <span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24" width="48" height="48"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
    <h2>Paid, take it</h2>
    <p class="paid-item">{{ itemName }} · {{ money(checkout?.totalPence ?? 0) }}</p>
    <!-- Drawn like the printed tag, so the buyer matches the code on screen to the one on the item. -->
    <div class="paid-tag"><span class="paid-tag-label" aria-hidden="true">Tag</span><p class="code" aria-label="Tag code">{{ code }}</p></div>
    </template>
    <template v-else>
    <template v-if="compact" />
    <template v-else-if="tip">
      <h2 v-if="checkout?.state === 'paid' && !checkout.reviewRequired">Thank you for the tip</h2>
      <h2 v-else-if="checkout?.tipRefunded">Tip refunded</h2>
      <h2 v-else-if="checkout?.reviewRequired">Tip needs checking</h2>
      <h2 v-else-if="checkout && ['capturing', 'checking'].includes(checkout.state)">Checking your tip</h2>
      <h2 v-else-if="checkout && ['cancelled', 'expired', 'failed'].includes(checkout.state)">Tip stopped</h2>
      <h2 v-else>Leave a tip (optional)</h2>
    </template>
    <h2 v-else-if="checkout?.reviewRequired">Payment needs checking</h2>
    <h2 v-else-if="checkout && ['capturing', 'checking'].includes(checkout.state)">Checking payment</h2>
    <h2 v-else-if="checkout && ['cancelled', 'expired', 'failed'].includes(checkout.state)">Checkout stopped</h2>
    <h2 v-else-if="!choosingAmount">Review and pay</h2>
    <!-- While the buyer chooses an amount the item card sits directly above, so the heading, name and tag are not repeated. -->
    <p v-if="!compact && !choosingAmount" class="checkout-item"><strong>{{ itemName }}</strong><br>Tag {{ code }}</p>
    <label v-if="choosingAmount" class="amount">{{ tip ? 'Your tip' : 'Your amount' }}, £<input v-model="amountText" :id="`amount-${code}`" name="amount" autocomplete="off" inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" :disabled="busy" :aria-describedby="`amount-help-${code}`"><span :id="`amount-help-${code}`" class="muted">{{ tip ? 'Any amount from 1p, and the item is yours either way.' : minimumPence ? `The minimum is ${money(minimumPence)}.` : 'Pay what you like.' }}</span></label>
    <p v-if="total !== null && !compact" class="total"><span>{{ tip ? 'Tip' : showAgreed ? 'Agreed price' : 'Total' }}</span> <b>{{ money(total) }}</b></p>
    <div v-show="payable && !finishable" ref="container" class="paypal-container" :class="{ busy }" :inert="busy" :aria-busy="busy" />
    <button class="btn pay-action" v-if="finishable" :disabled="busy" @click="capture">Finish payment</button>
    <p v-if="checkout && ['creating', 'awaiting_approval'].includes(checkout.state)" role="timer">{{ tip ? `You have ${timeLeft} to finish this tip.` : `Reserved for you for ${timeLeft}.` }}</p>
    </template>
    <p role="status" aria-atomic="true" :class="{ small: saleConfirmed }"><span v-if="saleConfirmed" class="sr-only">Paid, take it. Take the {{ itemName }} with tag {{ code }}. </span>{{ status }}</p>
    <RouterLink v-if="saleConfirmed && demoStall" class="btn sec paid-next" to="/demo#try-owner-heading">See this sale as the owner</RouterLink>
    <template v-if="!saleConfirmed">
    <!-- The cancelled copy points down at the agreed price, so it sits right under that line. -->
    <p v-if="agreedPrice && !holding && checkout?.state === 'cancelled'" class="notice">{{ agreedNotice(agreedPrice.totalPence) }}</p>
    <p v-if="checkout?.state === 'checking'">{{ tip ? 'This page updates automatically.' : 'Leave the item here until payment is confirmed. This page updates automatically.' }}</p>
    <button v-if="checkout && ['cancelled', 'expired', 'failed'].includes(checkout.state) && !checkout.reviewRequired" class="btn sec" @click="emit('refresh')">{{ tip ? 'Try a tip again' : 'Check availability and try again' }}</button>
    <button v-if="checkout && ['creating', 'awaiting_approval'].includes(checkout.state)" class="btn sec" :disabled="busy" @click="cancel()">{{ tip ? 'Cancel tip' : agreedPrice ? 'Cancel and keep my agreed price' : 'Cancel checkout' }}</button>
    </template>
  </section>
</template>
<style scoped>
.checkout { margin-block: 0; }
.checkout:focus { outline: none; }
.total { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
/* The price is the largest thing on the card, and its label steps back. */
.total span { color: var(--muted); font-size: var(--text-small); font-weight: 600; }
.total b { font-family: var(--font-display); font-size: var(--text-figure); line-height: 1.1; font-variant-numeric: tabular-nums; }
.paypal-container { min-height: 3rem; }
.paypal-container :deep(paypal-button) { width: 100%; }
.busy { opacity: 0.6; pointer-events: none; }
.compact { margin-block: 0; padding: 0; border: 0; background: none; gap: 10px; }
/* The paid group sits centred in the green screen, and the demo's next step, when there is one, sits at the bottom. */
.paid-screen { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 20px 20px; border-radius: 24px; background: var(--ok); color: #fff; text-align: center; }
.paid-screen > .tick { margin-top: auto; }
.paid-screen > [role=status] { margin-bottom: auto; }
.paid-screen:focus { outline: none; }
.paid-screen > * { margin: 0; }
.tick { display: grid; place-items: center; width: 84px; height: 84px; border-radius: 50%; background: #fff; color: var(--ok); }
.tick path { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 22; }
/* The paid moment plays once, about 400ms: the circle lands, the tick draws, and the tag code pops so the buyer matches it to the tag. */
@media (prefers-reduced-motion: no-preference) {
  .tick { animation: paid-land 200ms ease-out both; }
  .tick path { animation: paid-draw 260ms 140ms ease-out both; }
  .paid-tag { animation: paid-pop 400ms 80ms cubic-bezier(0.3, 1.4, 0.6, 1) both; }
}
@keyframes paid-land { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes paid-draw { from { stroke-dashoffset: 22; } to { stroke-dashoffset: 0; } }
@keyframes paid-pop { 0% { transform: scale(0.85); opacity: 0; } 60% { transform: scale(1.06); opacity: 1; } 100% { transform: scale(1); } }
.paid-screen h2 { font-size: var(--text-title); }
.paid-item { font-size: var(--text-heading); font-weight: 600; }
.paid-tag { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-top: 8px; padding: 12px 28px 14px; border-radius: 16px; background: #fff; color: var(--ink); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); }
.paid-tag-label { color: var(--muted); font-size: var(--text-small); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.paid-screen .code { font-family: var(--font-body); font-size: var(--text-code); font-weight: 700; letter-spacing: 0.08em; line-height: 1.1; }
.paid-screen .small { font-size: var(--text-body); font-weight: 600; }
.paid-next { margin-top: 12px; }
.paid-screen .btn.sec.paid-next { background: #fff; color: var(--ink); }
</style>
