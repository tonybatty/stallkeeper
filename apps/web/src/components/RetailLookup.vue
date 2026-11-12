<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { money, shortDate, type OwnerRetailReference, type RetailCandidate } from '../items.js';
const props = defineProps<{ query: string; saved: OwnerRetailReference | null; disabled: boolean; photo?: Blob }>();
const emit = defineEmits<{ select: [productId: string | null | undefined, doubtful?: boolean]; suggest: [prices: { askingPence: number; floorPence: number }] }>();
// The box follows the item name until the owner edits it, so it shows what a search would use. A box left blank goes back to following
// the name when the name changes or a search starts, not on each keystroke, so the owner can empty it to type something else.
const typed = ref<string | null>(null);
const text = computed({ get: () => typed.value ?? props.query, set: value => { typed.value = value; } });
const followNameIfBlank = () => { if (!typed.value?.trim()) typed.value = null; };
watch(() => props.query, followNameIfBlank);
const candidates = ref<RetailCandidate[]>([]);
const state = ref<'idle' | 'busy' | 'done' | 'unavailable'>('idle');
const selected = ref<RetailCandidate | null>(null);
const cleared = ref(false);
const noneMatch = ref(false);
const noReference = computed(() => state.value === 'done' && (noneMatch.value || !candidates.value.some(candidate => candidate.reference)));
const unavailable = 'Price lookup is unavailable. You can still set the price yourself.';
const conditionLabel = { new: 'new', used: 'used' } as const;
const lookupKind = ref<'photo' | 'text'>('text');
let lookupRequest = 0;
async function load(kind: 'photo' | 'text', request: () => Promise<Response>) {
  const current = ++lookupRequest;
  lookupKind.value = kind;
  state.value = 'busy'; candidates.value = []; noneMatch.value = false;
  try {
    const response = await request();
    if (!response.ok) throw new Error(`Lookup failed: ${response.status}`);
    const body = (await response.json()) as { candidates?: RetailCandidate[] };
    if (!Array.isArray(body.candidates)) throw new Error('Lookup returned no candidates');
    if (current !== lookupRequest) return;
    candidates.value = body.candidates;
    state.value = 'done';
  } catch (error) {
    if (current !== lookupRequest) return;
    console.error('Price lookup failed', error); state.value = 'unavailable';
  }
}
async function find() {
  followNameIfBlank();
  const query = text.value.trim();
  if (state.value === 'busy' || query.length < 2) return;
  await load('text', () => fetch('/api/owner/retail/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) }));
}
watch(() => props.photo, photo => { if (photo) void load('photo', () => fetch('/api/owner/retail/image-lookup', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: photo })); });
// One tap per match. Its suggested prices are a separate, single step under the chosen match, so a price the owner typed is never replaced by the same tap.
function use(candidate: RetailCandidate) {
  selected.value = candidate;
  emit('select', candidate.productId, candidate.missingWords.length > 0);
}
// The details saved with the item are the ones the AI stallholder reads, so the owner sees whichever reference will be saved.
const listing = computed(() => selected.value ? selected.value.reference : props.saved && !cleared.value ? props.saved : null);
// A doubtful match keeps its price line, and the server stores none of its details.
const withheld = computed(() => selected.value ? selected.value.missingWords.length > 0 : !!listing.value?.doubtful);
const hasDetails = computed(() => !withheld.value && !!listing.value && (!!listing.value.description || !!listing.value.facts.length));
function clear() { cleared.value = true; emit('select', null); }
function dropSelection() { selected.value = null; emit('select', cleared.value ? null : undefined); }
function rejectAll() { dropSelection(); noneMatch.value = true; }
</script>
<template>
  <section class="card retail" aria-labelledby="retail-title">
    <h2 id="retail-title">Comparable new prices</h2>
    <p class="muted">Retail listings from Channel3, for new items. They are not what your used item is worth. Optional: you can always set the price yourself.</p>
    <p v-if="selected" role="status">Selected: {{ selected.title }}. It is saved with the item. <button type="button" class="link" :disabled="disabled" @click="dropSelection">Remove</button></p>
    <p v-else-if="saved && !cleared" role="status">Saved reference: New from {{ money(saved.pricePence) }} at {{ saved.retailer }}, checked {{ shortDate(saved.checkedAt) }}. <button type="button" class="link" :disabled="disabled" @click="clear">Remove</button></p>
    <button v-if="selected?.suggestion" type="button" class="btn sec" :disabled="disabled" data-test="use-suggestion" @click="emit('suggest', selected.suggestion)">Use the suggested prices: asking {{ money(selected.suggestion.askingPence) }}, lowest {{ money(selected.suggestion.floorPence) }}</button>
    <section v-if="selected || hasDetails || withheld" class="facts" aria-labelledby="facts-title" data-test="listing-facts">
      <h3 id="facts-title">From the retailer's listing for a new one</h3>
      <p v-if="withheld" class="muted">{{ selected ? "Stallkeeper AI does not use this listing's details, because it may be a different kind of item." : "Stallkeeper AI does not use this listing's details. To change that, search again and choose a match." }}</p>
      <p v-else-if="!hasDetails" class="muted">The listing has no details.</p>
      <template v-else>
        <p class="muted">Stallkeeper AI can use these when answering buyers, as the retailer's details for a new one.</p>
        <p v-if="listing?.description">{{ listing.description }}</p>
        <ul v-if="listing?.facts.length">
          <li v-for="fact in listing.facts" :key="fact">{{ fact }}</li>
        </ul>
      </template>
    </section>
    <div class="row">
      <label class="grow">Search for<input v-model="text" maxlength="120" :disabled="disabled" @keydown.enter.prevent="find"></label>
      <button type="button" class="btn sec" :disabled="disabled || state === 'busy'" @click="find">{{ state === 'busy' ? 'Looking…' : 'Find new prices' }}</button>
    </div>
    <p v-if="state === 'busy'" role="status">{{ lookupKind === 'photo' ? 'Looking for new prices from the photo…' : 'Looking for new prices…' }}</p>
    <p v-if="state === 'unavailable'" role="alert">{{ unavailable }}</p>
    <p v-else-if="noReference" role="status">No useful reference found. Set the price yourself.</p>
    <template v-else-if="candidates.length">
      <ul class="candidates">
        <li v-for="candidate in candidates" :key="candidate.productId" class="card">
          <h3>{{ candidate.title }}</h3>
          <ul class="offers">
            <li v-for="offer in candidate.offers" :key="offer.url + offer.pricePence">{{ money(offer.pricePence) }} at {{ offer.retailer }} · {{ offer.condition ? conditionLabel[offer.condition] : 'condition unknown' }} · checked {{ shortDate(candidate.checkedAt) }}</li>
          </ul>
          <template v-if="candidate.reference">
            <p v-if="candidate.missingWords.length" role="status" data-test="weak-match">This listing does not mention {{ candidate.missingWords.join(', ') }}, so it may be a different kind of item. No prices are suggested from it. Check it is like yours before you use it.</p>
            <p v-if="candidate.missingWords.length" class="muted" data-test="details-withheld">If you use it, Stallkeeper AI will not use this listing's details when answering buyers.</p>
            <p v-else-if="candidate.suggestion" class="muted">Suggestion: asking {{ money(candidate.suggestion.askingPence) }}, lowest you'd take {{ money(candidate.suggestion.floorPence) }}. That is half the lowest new price, a starting point you can change.</p>
            <button type="button" class="btn sec" :disabled="disabled" :aria-pressed="selected?.productId === candidate.productId" @click="use(candidate)">Use this match</button>
          </template>
          <p v-else class="muted">No new offer in stock, so this cannot be a reference.</p>
        </li>
      </ul>
      <button type="button" class="btn sec" :disabled="disabled" @click="rejectAll">None of these match</button>
    </template>
  </section>
</template>
<style scoped>
.retail { padding: 12px 0 0; border: 0; background: none; }
.candidates > .card { padding: 12px 0 0; border: 0; border-top: 1px solid var(--rule); border-radius: 0; background: none; }
.retail h2, .retail h3, .retail p, .retail ul { margin: 0; }
.facts h3, .facts ul { margin: 0; }
.facts { display: flex; flex-direction: column; gap: 8px; }
.facts ul { padding-left: 1.25rem; display: flex; flex-direction: column; gap: 4px; }
.grow { flex: 1 1 10rem; }
.candidates, .offers { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.offers { gap: 4px; }
.link { background: none; border: 0; padding: 0; min-height: 44px; color: inherit; text-decoration: underline; font: inherit; cursor: pointer; }
</style>
