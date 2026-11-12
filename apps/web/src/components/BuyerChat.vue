<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { aboutLine, greetingLine, openingLine, type ChatMessage, type OfferCard } from '../items.js';
import { scrollBehavior } from '../scroll.js';
const props = defineProps<{ code: string; closed: boolean; open: boolean }>();
const emit = defineEmits<{ closed: [hasTranscript: boolean, sendFailed?: boolean]; prices: [value: { card: OfferCard | null; agreedPrice: OfferCard | null }] }>();
const messages = defineModel<ChatMessage[]>('messages', { required: true });
const log = ref<HTMLElement>();
const cardSlot = ref<HTMLElement>();
const composer = ref<HTMLElement>();
const draft = ref('');
const offerDraft = ref('');
const offerOpen = ref(false);
const busy = ref(false);
const limited = ref(false);
const chatStatus = computed(() => busy.value ? 'Stallkeeper is typing…' : props.closed ? "Chat has ended. The stallholder's notes and asking price are still on the item page." : '');
// Fixed questions for a buyer who has not sent anything yet. They go through the normal chat route like typed text.
const prompts = ['Does it work?', 'Any damage?'];
const showPrompts = computed(() => !props.closed && !messages.value.length);
const offerInput = ref<HTMLInputElement>();
const controller = new AbortController();
onBeforeUnmount(() => controller.abort());
const edge = 12;
// Brings the newest message into view, and its Accept button when a card came with it, without moving focus.
// With a card the button wins over the top of the message, because the buyer cannot act on a card they cannot reach.
function scrollToLatest() {
  const bubble = log.value?.lastElementChild;
  const latest = bubble?.getBoundingClientRect();
  // An AI bubble's visible speaker label sits above it as a separate element, and has to clear the title bar with it.
  const label = bubble?.previousElementSibling;
  const button = cardSlot.value?.querySelector('button')?.getBoundingClientRect();
  const target = button ?? latest;
  if (!target) return;
  // The pinned composer covers the bottom of the window, so the visible area ends where it starts.
  const composerTop = composer.value?.getBoundingClientRect().top ?? 0;
  const floor = composerTop > 0 ? composerTop : window.innerHeight;
  // The fixed title bar covers the top of the window in the same way.
  const ceiling = (document.querySelector('.app-titlebar')?.getBoundingClientRect().bottom ?? 0) + edge;
  const top = (label?.matches('.speaker') ? label.getBoundingClientRect().top : latest?.top) ?? target.top;
  const reveal = target.bottom + edge - floor;
  if (top >= ceiling && target.bottom <= floor - edge) return;
  window.scrollBy({ top: button ? reveal : Math.min(reveal, top - ceiling), behavior: scrollBehavior() });
}
// The chat is hidden, not unmounted, while the buyer looks at the item, so it scrolls again each time it is shown.
watch(() => props.open, async open => {
  if (!open || !messages.value.length) return;
  await nextTick();
  scrollToLatest();
});
function parsePence(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [pounds, pennies = ''] = value.split('.');
  const amount = Number(pounds) * 100 + Number(pennies.padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 99999999 ? amount : null;
}
// The composer is pinned to the bottom of the screen, so opening the offer box needs focus but no scrolling.
async function toggleOffer() {
  offerOpen.value = !offerOpen.value;
  if (!offerOpen.value) return;
  await nextTick();
  offerInput.value?.focus({ preventScroll: true });
}
async function send(offer = false, fixed?: string) {
  const amount = offer ? parsePence(offerDraft.value) : null;
  if (props.closed || busy.value || (offer ? amount === null : !(fixed ?? draft.value).trim())) return;
  busy.value = true;
  limited.value = false;
  const message = (fixed ?? draft.value).trim();
  try {
    const response = await fetch(`/api/i/${encodeURIComponent(props.code)}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(offer ? { offerPence: amount } : { message }), signal: controller.signal,
    });
    const result = await response.json();
    if (controller.signal.aborted) return;
    if (response.status === 429) { limited.value = true; return; }
    if (!response.ok) { emit('closed', messages.value.length > 0, true); return; }
    // The model is the parent's until it re-renders, so the new length comes from the list just sent, not messages.value.
    const sent = [...messages.value, { role: 'You' as const, content: offer ? result.message : message }, { role: 'Stallkeeper' as const, content: result.reply }];
    messages.value = sent;
    emit('prices', { card: result.card ?? null, agreedPrice: result.agreedPrice ?? null });
    if (fixed === undefined) { draft.value = ''; offerDraft.value = ''; offerOpen.value = false; }
    if (!result.chatAvailable) emit('closed', sent.length > 0);
    await nextTick();
    scrollToLatest();
  } catch (cause) {
    if (controller.signal.aborted) return;
    console.error('Chat request failed', cause); emit('closed', messages.value.length > 0, true);
  } finally { busy.value = false; }
}
</script>
<template>
  <section class="buyer-chat" aria-label="Ask Stallkeeper">
    <p v-if="!messages.length" class="chat-message bubble ai intro">{{ greetingLine }}</p>
    <details class="opening disclosure"><summary>About Stallkeeper</summary><p>{{ messages.length ? openingLine : aboutLine }}</p></details>
    <div ref="log" class="thread" role="log" aria-live="polite">
      <template v-for="(entry, index) in messages" :key="index">
        <!-- Hidden from assistive tech: the sr-only prefix in the bubble already announces the speaker. -->
        <p v-if="entry.role !== 'You'" class="speaker" aria-hidden="true">Stallkeeper AI</p>
        <p class="chat-message bubble" :class="entry.role === 'You' ? 'from-buyer' : 'ai'"><b class="sr-only">{{ entry.role }}: </b>{{ entry.content }}</p>
      </template>
    </div>
    <div ref="cardSlot"><slot /></div>
    <p class="sr-only" role="status">{{ chatStatus }}</p>
    <div ref="composer" class="composer">
      <p v-if="chatStatus" class="chat-status">{{ chatStatus }}</p>
      <p v-if="limited" role="status">Stallkeeper is busy. Please try again in a minute. You can still buy at the asking price.</p>
      <template v-if="!closed">
        <div class="chat-prompts">
          <button type="button" class="chip solid" :disabled="busy" :aria-expanded="offerOpen" aria-controls="offer-form" @click="toggleOffer">Make an offer</button>
          <template v-if="showPrompts"><button v-for="prompt in prompts" :key="prompt" type="button" class="chip" :disabled="busy" @click="send(false, prompt)">{{ prompt }}</button></template>
        </div>
        <form v-if="offerOpen" id="offer-form" class="composer-row" @submit.prevent="send(true)">
          <label class="sr-only" for="buyer-offer">Your offer in pounds</label>
          <input id="buyer-offer" ref="offerInput" v-model="offerDraft" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required :disabled="busy" placeholder="Your offer, for example 22.00">
          <button class="send" aria-label="Send offer" :disabled="busy || parsePence(offerDraft) === null">↑</button>
        </form>
        <form class="chat-form composer-row" @submit.prevent="send()">
          <label class="sr-only" for="chat-question">Ask a question</label>
          <input id="chat-question" v-model="draft" maxlength="500" required :disabled="busy" placeholder="Ask a question or make an offer" autocomplete="off">
          <button class="send" aria-label="Send" :disabled="busy || !draft.trim()">↑</button>
        </form>
      </template>
    </div>
  </section>
</template>
