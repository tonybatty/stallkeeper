<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import BuyerChat from '../components/BuyerChat.vue';
import ItemIllustration from '../components/ItemIllustration.vue';
import CheckoutPayment from '../components/CheckoutPayment.vue';
import FreeTake from '../components/FreeTake.vue';
import BuyerOffer from '../components/BuyerOffer.vue';
import type { Checkout, OfferCard, Take } from '../items.js';
import ItemPhoto from '../components/ItemPhoto.vue';
import ItemNotes from '../components/ItemNotes.vue';
import SandboxBuyer from '../components/SandboxBuyer.vue';
import CodeEntry from '../components/CodeEntry.vue';
import { agreedNotice, holdsItem, money, offerNotice, restoreTranscript, type ChatMessage, type PublicItem, type RetailReference } from '../items.js';
import { scrollBehavior } from '../scroll.js';
import { clockTime } from '../time.js';
import { appTitleHome } from '../app-title.js';
const route = useRoute();
const data = ref<{ demoStall?: boolean; item: PublicItem; reservedUntil?: string | null; reducedFromPence?: number | null; retailReference?: RetailReference | null; stallName: string; charity?: { line: string; seeded: boolean } | null; availability: string; chatAvailable: boolean; checkout: Checkout | null; take?: Take | null; card: OfferCard | null; agreedPrice: OfferCard | null; messages?: { role: 'user' | 'assistant'; content: string }[] }>();
// A tip holds nothing, so it is never the checkout that holds the item.
const liveCheckout = computed(() => {
  const checkout = data.value?.checkout;
  return checkout && checkout.kind !== 'tip' && holdsItem(checkout) ? checkout : null;
});
const displayedPrice = computed(() => liveCheckout.value?.totalPence ?? data.value?.agreedPrice?.totalPence ?? data.value?.item.askingPence ?? 0);
// A pay-what-you-want item names no figure until the buyer has chosen one: the buyer decides the amount.
const priceChip = computed(() => {
  const current = data.value;
  if (!current) return null;
  if (isFree.value) return 'Free';
  if (current.item.mode === 'pwyw' && !liveCheckout.value && !current.agreedPrice) return 'Pay what you want';
  return money(displayedPrice.value);
});
const isFree = computed(() => data.value?.item.mode === 'free');
// The old price is struck through beside the chip, and only while the chip shows the asking price.
const reducedFrom = computed(() => data.value?.reducedFromPence && !liveCheckout.value && !data.value.agreedPrice ? data.value.reducedFromPence : null);
// The buyer login shows wherever the pay card does, while a payment can still start: the PayPal popup asks for it.
const sandboxShown = computed(() => {
  const current = data.value;
  if (!current?.demoStall || (isFree.value ? !tipShown.value : !(current.checkout || current.availability === 'available'))) return false;
  const checkout = current.checkout;
  return !checkout || (['creating', 'awaiting_approval'].includes(checkout.state) && !checkout.reviewRequired);
});
// The tip card shows only to the buyer who took the item, so the free page opens on Take it alone.
const tipShown = computed(() => isFree.value && !!data.value && (!!data.value.checkout || !!data.value.take));
// Pay what you want and free items go straight to the pay or take step, with no chat or tag form.
const simple = computed(() => data.value?.item.mode === 'pwyw' || isFree.value);
function taken(take: Take) {
  const current = data.value;
  if (!current) return;
  current.take = take; current.availability = 'taken';
}
// The reload can unmount FreeTake, when the item is no longer free, so the reason it was refused is kept here.
const takeRefusal = ref('');
function takeRefused(reason: string) {
  takeRefusal.value = reason;
  void reload(false);
}
const freeTake = ref<InstanceType<typeof FreeTake>>();
// Paying can leave this page and lose what was typed, so a typed message reaches the stallholder before a tip order exists.
const sendDraft = async () => await freeTake.value?.sendMessage() === false ? 'Your message was not sent, so the tip did not start.' : '';
const priceLabel = computed(() => liveCheckout.value ? 'Checkout total' : 'Agreed price');
const message = ref('');
// Only a code the server does not know gets the advice to retype it. A failed load had the right code.
const notFound = ref(false);
const transcript = ref<ChatMessage[]>([]);
const checkoutCard = ref<InstanceType<typeof CheckoutPayment>>();
// A haggle item opens on the stallholder, with Ask or make an offer as the primary button and Buy now beneath it. Paying stays one tap away, and nothing
// about the checkout changes: CheckoutPayment is mounted behind this screen so a return from PayPal still resumes,
// and that return leaves the landing because a buyer who just approved a payment must see how it ended.
const buyNow = ref(false);
// Once a price is agreed or held, the checkout card names the item and states the one total, so the item card steps aside and the pay screen fits a phone.
const paying = computed(() => !isFree.value && !fixedPay.value && !ended.value && (!!liveCheckout.value || !!data.value?.agreedPrice || buyNow.value));
const landing = computed(() => {
  const current = data.value;
  return current?.item.mode === 'haggle' && current.availability === 'available' && !current.checkout && !current.agreedPrice && !buyNow.value && (current.chatAvailable || transcript.value.length > 0);
});
// A fixed-price item has nothing to ask about, so its page is the item and the pay button, with no chat step.
const fixedPay = computed(() => {
  const current = data.value;
  return current?.item.mode === 'fixed' && current.availability === 'available' && !current.checkout && !current.agreedPrice;
});
async function startBuying() {
  buyNow.value = true;
  await nextTick();
  const card = checkoutCard.value?.$el as HTMLElement | undefined;
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
}
const chatOpen = ref(false);
const chatEnded = ref(false);
// A conversation the buyer cannot add to right now, such as one that used its turns or sits behind their own checkout, is still theirs to read.
const chatClosed = computed(() => chatEnded.value || (transcript.value.length > 0 && !data.value?.chatAvailable));
const chatFailed = ref(false);
const chatShown = computed(() => chatOpen.value && !ended.value && !paidScreen.value && (data.value?.chatAvailable || chatClosed.value));
const loading = ref(false);
const accepting = ref(false);
const holding = ref(false);
// A confirmed sale replaces the whole page with the green Paid, take it screen. A tip never does, and a payment held for review is not a sale.
const paidScreen = computed(() => {
  const checkout = data.value?.checkout;
  return !!checkout && checkout.kind !== 'tip' && checkout.state === 'paid' && !checkout.reviewRequired;
});
const offerCard = computed(() => data.value?.availability === 'available' && !holding.value ? data.value.card : null);
const offerError = ref('');
// A seeded item belongs to the demo stall, so leaving it should land on the demo and not on the empty main stall.
const homePath = computed(() => data.value?.item.seeded ? '/demo' : '/');
async function acceptCard() {
  if (!data.value?.card || accepting.value) return;
  const current = data.value;
  accepting.value = true; offerError.value = '';
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(data.value.item.code)}/cards/${encodeURIComponent(data.value.card.id)}/accept`, { method: 'POST' });
    if (data.value !== current) return;
    if (!response.ok) { offerError.value = 'This price is no longer available. Refresh the item to check its price and availability.'; await reload(); return; }
    data.value.agreedPrice = (await response.json()).agreedPrice; data.value.card = null; data.value.checkout = liveCheckout.value; chatOpen.value = false; revision.value++;
  } catch (error) { console.error('Price could not be agreed', error); offerError.value = 'The price could not be agreed. Try again.'; }
  finally { accepting.value = false; }
}
const revision = ref(0);
// An item nobody can pay for or take here: sold, reserved by someone else, closed or removed. The page stays short, with one way out.
const ended = computed(() => !!data.value && !(data.value.checkout || data.value.take || data.value.availability === 'available'));
const states: Record<string, string> = {
  sold: 'This item has sold. Please leave it for its buyer.',
  closed: 'This stall is closed. Please leave the item here.',
  removed: 'This item is no longer for sale. Please leave it here.',
  reserved: 'Someone is paying for this now. Check back in a few minutes.',
  taken: 'Someone else has already taken this. Please leave it for them.',
};
// The demo stall resets itself, so a closed demo item points to the page that restocks it. The main stall's closed copy stays as it is.
const demoClosed = 'This stall is closed. Fresh stock is one tap away.';
// A reservation has a known end, so a buyer who finds the item held is told when it frees up if the other buyer does not pay.
const stateCopy = (current: { availability: string; demoStall?: boolean; reservedUntil?: string | null }) => {
  if (current.availability === 'closed' && current.demoStall) return demoClosed;
  if (current.availability === 'reserved' && current.reservedUntil) return `Someone is paying for this now. Free again by ${clockTime(current.reservedUntil)} if they don't pay.`;
  return states[current.availability];
};
const loadingNotice = 'Loading item…';
const chatUnavailable = "Chat is unavailable. The stallholder's notes and asking price are still shown above.";
const announcement = computed(() => {
  const current = data.value;
  if (!current) return loading.value ? loadingNotice : '';
  return [
    offerCard.value && offerNotice(offerCard.value),
    current.agreedPrice && !liveCheckout.value && agreedNotice(current.agreedPrice.totalPence),
    !current.checkout && !current.take && stateCopy(current),
    chatFailed.value && !current.chatAvailable && chatUnavailable,
  ].filter(Boolean).join(' ');
});
const reloadError = ref('');
async function reload(remount = true) {
  const code = String(route.params.code);
  reloadError.value = '';
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(code)}`);
    // A late answer for a tag the buyer has left must not replace the page they are on.
    if (code !== String(route.params.code)) return;
    if (!response.ok) throw new Error(`Item request failed: ${response.status}`);
    const fresh = await response.json();
    if (!fresh.chatAvailable && !transcript.value.length) chatOpen.value = false;
    data.value = fresh;
    appTitleHome.value = fresh.item?.seeded ? '/demo' : '/';
    if (remount) revision.value++;
  } catch (error) { console.error('Item could not refresh', error); reloadError.value = 'This item could not refresh. Check your connection and try again.'; }
}
// A failed send can still have issued a card, and only the prices change: a page refresh would reopen chat after a model failure.
async function refreshPrices() {
  const current = data.value!;
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(current.item.code)}`);
    if (!response.ok) return;
    const { card, agreedPrice } = await response.json();
    if (data.value === current) Object.assign(current, { card, agreedPrice });
  } catch (error) { console.error('Prices could not refresh', error); }
}
function closeChat(hasTranscript: boolean, sendFailed = false) {
  if (hasTranscript) chatEnded.value = true;
  else { data.value!.chatAvailable = false; chatFailed.value = true; chatOpen.value = false; }
  if (sendFailed) void refreshPrices();
}
watch(() => route.params.code, async (code, _old, cleanup) => {
  const controller = new AbortController();
  cleanup(() => controller.abort());
  chatOpen.value = false; chatEnded.value = false; chatFailed.value = false; offerError.value = ''; reloadError.value = ''; accepting.value = false; takeRefusal.value = '';
  data.value = undefined; message.value = ''; notFound.value = false; loading.value = true; transcript.value = []; buyNow.value = false;
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(String(code))}`, { signal: controller.signal });
    if (response.status === 404) { notFound.value = true; message.value = 'That tag is not on this stall.'; }
    else if (!response.ok) throw new Error(`Item request failed: ${response.status}`);
    else {
      const loaded = await response.json();
      transcript.value = restoreTranscript(loaded.messages);
      data.value = loaded;
      appTitleHome.value = loaded.item?.seeded ? '/demo' : '/';
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('Item could not load', error);
    message.value = 'This item could not load. Refresh the page to try again.';
  } finally { if (!controller.signal.aborted) loading.value = false; }
}, { immediate: true });
</script>
<template>
  <main class="page" :class="{ chatting: chatShown, fill: paidScreen || ended, simple }">
    <p v-if="loading">{{ loadingNotice }}</p>
    <template v-if="data">
      <article v-if="!chatShown && !paidScreen && !paying" class="card item-card" :class="{ compact: landing || fixedPay || simple, ended, sold: data.availability === 'sold' }">
        <ItemIllustration v-if="data.item.illustration && !data.item.photoUrl" :kind="data.item.illustration" />
        <ItemPhoto v-else class="buyer-photo" :src="data.item.photoUrl" :name="data.item.name" />
        <div class="row"><h1>{{ data.item.name }}</h1><span v-if="data.availability === 'sold'" class="status-pill">Sold</span><span v-else-if="priceChip" class="price-group"><s v-if="reducedFrom" class="was" data-test="reduced-from"><span class="sr-only">Reduced from </span>{{ money(reducedFrom) }}</s><span class="price-chip">{{ priceChip }}</span></span></div>
        <ItemNotes v-if="!ended" :item="data.item" :retail-reference="data.retailReference" />
        <p v-if="!ended" class="meta"><template v-if="data.item.mode === 'pwyw' && !liveCheckout && !data.agreedPrice">Tag <b>{{ data.item.code }}</b></template><template v-else>{{ liveCheckout || data.agreedPrice ? priceLabel : data.item.mode === 'haggle' ? 'Offers welcome' : isFree ? 'Free, a tip is optional' : 'Fixed price' }} · Tag <b>{{ data.item.code }}</b></template></p>
        <p v-if="data.charity" class="muted" data-test="charity-line">{{ data.charity.line }}</p>
      </article>
      <FreeTake v-if="isFree && (data.take || data.availability === 'available')" ref="freeTake" :code="data.item.code" :item-name="data.item.name" :take="data.take ?? null" @taken="taken" @refused="takeRefused" />
      <p v-if="takeRefusal && !isFree && !data.checkout" v-show="!chatShown" class="notice" role="alert">{{ takeRefusal }}</p>
      <CheckoutPayment v-if="isFree ? tipShown : (data.checkout || data.availability === 'available')" ref="checkoutCard" v-show="!chatShown && !landing" :compact="fixedPay" :key="`${data.item.code}:${isFree}:${revision}`" :code="data.item.code" :item-name="data.item.name" :asking-pence="data.item.askingPence" :pay-what-you-want="data.item.mode === 'pwyw' || isFree" :tip="isFree" :demo-stall="!!data.demoStall" :minimum-pence="data.item.minimumPence" :initial="data.checkout" :agreed-price="data.agreedPrice" :before-order="isFree ? sendDraft : undefined" @refresh="reload" @holding="holding = $event" @checkout="data.checkout = $event" @returned="buyNow = true" />
      <RouterLink v-if="isFree && data.take && data.demoStall" v-show="!chatShown && !landing" class="btn sec owner-shortcut" to="/demo#try-owner-heading">Next: see this take as the owner</RouterLink>
      <!-- Under the pay card, not inside it, so the card holds only the item, the price and PayPal's button. -->
      <SandboxBuyer v-if="sandboxShown" v-show="!chatShown && !landing" folded :compact="fixedPay" />
      <template v-if="ended">
        <p v-if="data.agreedPrice" v-show="!chatShown" class="notice">{{ agreedNotice(data.agreedPrice.totalPence) }}</p>
        <p v-show="!chatShown" class="notice">{{ stateCopy(data) }}</p>
        <RouterLink v-if="data.availability === 'closed' && data.demoStall" v-show="!chatShown" class="btn bottom" to="/demo">Get fresh stock</RouterLink>
        <RouterLink v-else class="btn sec bottom" :to="homePath">See what else is on the stall</RouterLink>
      </template>
      <template v-if="paidScreen" />
      <template v-else-if="data.item.mode === 'haggle' && !ended">
        <div class="stack" v-if="!chatOpen && (chatClosed || landing || (data.chatAvailable && !holding))">
          <!-- At payment PayPal's button is the one filled button, so the way back to the chat is a text link. -->
          <button :class="paying ? 'text-button' : 'btn'" v-if="chatClosed || (data.chatAvailable && !holding)" @click="chatOpen = true">{{ transcript.length ? 'View your chat' : 'Ask or make an offer' }}</button>
          <button v-if="landing" class="btn buy-now sec" @click="startBuying">Buy now for {{ money(data.item.askingPence ?? 0) }}</button>
        </div>
        <div v-if="data.chatAvailable || chatClosed" v-show="chatOpen" class="chat-screen">
          <div class="chat-head">
            <button class="chat-back" @click="chatOpen = false">Back to the item</button>
            <p class="chat-item">{{ data.item.name }} · Tag {{ data.item.code }} · Asking {{ money(data.item.askingPence ?? 0) }}</p>
          </div>
          <BuyerChat v-model:messages="transcript" :key="data.item.code" :code="data.item.code" :closed="chatClosed" :open="chatOpen" @prices="Object.assign(data, $event)" @closed="closeChat">
            <BuyerOffer v-if="offerCard && chatShown" :card="offerCard" :busy="accepting" @accept="acceptCard" />
          </BuyerChat>
        </div>
        <p v-if="chatFailed && !data.chatAvailable">{{ chatUnavailable }}</p>
      </template>
      <BuyerOffer v-if="offerCard && !chatShown" :card="offerCard" :busy="accepting" @accept="acceptCard" />
      <p v-if="offerError" role="alert">{{ offerError }}</p>
      <p v-if="reloadError" role="alert">{{ reloadError }}</p>
    </template>
    <template v-if="message"><h1>{{ message }}</h1><template v-if="notFound"><p>Check the four-character code printed under the QR. Codes mix letters and numbers, like K7Q2.</p><CodeEntry /></template><RouterLink class="btn sec" :to="homePath">Browse the stall</RouterLink></template>
    <p class="sr-only" role="status" aria-atomic="true">{{ announcement }}</p>
  </main>
</template>
<style scoped>
.page .item-card img.buyer-photo { width: 100%; height: auto; max-height: none; aspect-ratio: 4 / 3; object-fit: cover; background: none; border-radius: var(--radius-sm); }
.price-group { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.was { color: var(--muted); font-family: var(--font-display); font-size: var(--text-body); font-weight: 700; }
</style>
