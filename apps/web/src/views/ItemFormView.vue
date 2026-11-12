<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { compressPhoto } from '../photos.js';
import { scrollBehavior } from '../scroll.js';
import ItemPhoto from '../components/ItemPhoto.vue';
import RetailLookup from '../components/RetailLookup.vue';
import { money, parsePence, type OwnerItem, type OwnerRetailReference } from '../items.js';
const route = useRoute(); const router = useRouter();
const editing = typeof route.params.id === 'string';
const form = reactive({ name: '', notes: '', mode: 'fixed', asking: '', floor: '', minimum: '' });
const primaryModes = [{ value: 'haggle', label: 'Take offers' }, { value: 'fixed', label: 'Fixed price' }];
// Pay what you want and free sit behind a fold, so the usual choice is two buttons.
const moreModes = [{ value: 'pwyw', label: 'Pay what you want' }, { value: 'free', label: 'Free' }];
// The form does not set late-day price drops. The server keeps a saved item's choice while its saved mode stays, and otherwise uses the mode's default: on for haggle, off for fixed. This mirrors that rule, so switching mode and back restores the saved choice, and the choice is never sent.
const savedDrops = ref<{ mode: string; priceDrops: boolean } | null>(null);
const priceDrops = computed(() => (form.mode === 'haggle' || form.mode === 'fixed') && (savedDrops.value?.mode === form.mode ? savedDrops.value.priceDrops : form.mode === 'haggle'));
const needsFloor = computed(() => form.mode === 'haggle' || (form.mode === 'fixed' && priceDrops.value));
// For pay what you want and free the figure is the owner's own expected amount or tip: optional, and buyers never see it.
const ownFigure = computed(() => form.mode === 'pwyw' || form.mode === 'free');
const savedId = ref<string | undefined>(editing ? String(route.params.id) : undefined);
const activity = ref('');
// Undefined leaves the saved reference alone, null removes it, and an ID makes the server fetch that product's price when saving.
const retailProductId = ref<string | null | undefined>(undefined);
const retailDoubtful = ref<boolean | undefined>(undefined);
const savedReference = ref<OwnerRetailReference | null>(null);
const itemStatus = ref('');
const confirmingRemoval = ref(false); const removalReason = ref('');
const removalField = useTemplateRef<HTMLInputElement>('removalField');
// The confirmation opens after the pinned save bar, below the fold on a phone, so the tap would seem to do nothing without this.
async function confirmRemoval() {
  confirmingRemoval.value = true;
  await nextTick();
  removalField.value?.closest('.card')?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  removalField.value?.focus({ preventScroll: true });
}
function suggest(prices: { askingPence: number; floorPence: number }) {
  form.asking = (prices.askingPence / 100).toFixed(2);
  if (form.mode === 'haggle') form.floor = (prices.floorPence / 100).toFixed(2);
}
const photo = ref<Blob>(); const photoUrl = ref<string | null>(null); const photoMessage = ref(''); const preparing = ref(false);
const retailOpen = ref(false);
function retailToggle(event: Event) { retailOpen.value = (event.currentTarget as HTMLDetailsElement).open; }
let previewUrl: string | undefined;
onUnmounted(() => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
async function choosePhoto(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || preparing.value || busy.value) return;
  preparing.value = true; photoMessage.value = '';
  try {
    const compressed = await compressPhoto(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    photo.value = compressed; previewUrl = URL.createObjectURL(compressed); photoUrl.value = previewUrl;
    retailOpen.value = true;
  } catch (error) {
    console.error('Photo preparation failed', error);
    photoMessage.value = 'This photo could not be added. Choose a JPEG, PNG or WebP under 20 MB. You can still save the item.';
  } finally { preparing.value = false; input.value = ''; }
}
const message = ref(''); const busy = ref(false); const ready = ref(false);
const notesField = useTemplateRef<HTMLTextAreaElement>('notesField');
onMounted(async () => {
  try {
    const response = await fetch(editing ? '/api/owner/items' : '/api/owner/stall');
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (!response.ok) throw new Error(`Owner request failed: ${response.status}`);
    if (editing) {
      const data = (await response.json()) as { stallName: string; items: OwnerItem[] };

      const item = data.items.find(item => item.id === route.params.id);
      if (!item) { message.value = 'Item not found.'; return; }
      const views = item.views ?? 0;
      activity.value = `${views === 1 ? '1 person has' : `${views} people have`} viewed this`;
      photoUrl.value = item.photoUrl; savedReference.value = item.retailReference; savedDrops.value = { mode: item.mode, priceDrops: item.priceDrops };
      itemStatus.value = item.status;
      Object.assign(form, { name: item.name, notes: item.notes, mode: item.mode, asking: item.askingPence ? (item.askingPence / 100).toFixed(2) : '', floor: item.floorPence ? (item.floorPence / 100).toFixed(2) : '', minimum: item.minimumPence ? (item.minimumPence / 100).toFixed(2) : '' });
    }
    ready.value = true;
    // The feed's Add to notes link lands here with the notes field ready to type in.
    if (editing && route.query.focus === 'notes') { await nextTick(); notesField.value?.focus(); }
  } catch (error) { console.error('Item form could not load', error); message.value = 'The item form could not load. Refresh to try again.'; }
});
// The server computes the ladder, so the preview shows exactly what buyers can be offered. Late answers for older prices are dropped.
const ladder = ref<number[]>([]);
const ladderPrices = computed(() => form.mode === 'haggle' ? { askingPence: parsePence(form.asking), floorPence: parsePence(form.floor) } : null);
let ladderRequest = 0;
watch(ladderPrices, async prices => {
  const request = ++ladderRequest;
  if (!prices?.askingPence || !prices.floorPence || prices.askingPence < prices.floorPence) { ladder.value = []; return; }
  try {
    const response = await fetch('/api/owner/ladder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(prices) });
    const body = response.ok ? await response.json() as { counterOffersPence?: number[] } : {};
    if (request === ladderRequest) ladder.value = Array.isArray(body.counterOffersPence) ? body.counterOffersPence : [];
  } catch (error) {
    console.error('Ladder preview failed', error);
    if (request === ladderRequest) ladder.value = [];
  }
}, { deep: true });
async function uploadPhoto() {
  if (!photo.value) return true;
  try {
    const upload = await fetch(`/api/owner/items/${savedId.value}/photo`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: photo.value, signal: AbortSignal.timeout(20_000) });
    if (upload.status === 403) {
      photoMessage.value = 'Photos are turned off for this stall. Your item details are saved.';
      photo.value = undefined; photoUrl.value = null;
      return false;
    }
    if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
    photo.value = undefined; photoMessage.value = '';
    return true;
  } catch (error) {
    console.error('Photo upload failed', error);
    photoMessage.value = 'Your item details are saved, but the photo was not added. Save again to retry, or return to your items.';
    return false;
  }
}
async function save() {
  if (busy.value || preparing.value) return;
  // Like the minimum, the owner's own figure is optional: left empty it is sent as null, which clears a saved one.
  const askingTyped = !ownFigure.value || !!form.asking.trim();
  const askingPence = askingTyped ? parsePence(form.asking) : null;
  const floorPence = needsFloor.value ? parsePence(form.floor) : null;
  // The minimum is optional: left empty it is sent as null, which clears a saved one.
  const minimumTyped = form.mode === 'pwyw' && !!form.minimum.trim();
  const minimumPence = minimumTyped ? parsePence(form.minimum) : null;
  if (ownFigure.value && askingTyped && !askingPence) { message.value = `Enter an expected ${form.mode === 'free' ? 'tip' : 'amount'} above zero, or leave it empty.`; return; }
  if (!ownFigure.value && (!askingPence || (needsFloor.value && (!floorPence || floorPence > askingPence)))) {
    message.value = 'Enter a price greater than zero and a floor no higher than the asking price.'; return;
  }
  if (minimumTyped && !minimumPence) { message.value = 'Enter a minimum above zero, or leave it empty.'; return; }
  busy.value = true; message.value = '';
  try {
    const response = await fetch(savedId.value ? `/api/owner/items/${savedId.value}` : '/api/owner/items', { method: savedId.value ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.name, notes: form.notes, mode: form.mode, askingPence, floorPence, minimumPence, retailProductId: retailProductId.value, retailDoubtful: retailDoubtful.value }) });
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (response.status === 400 || response.status === 429) { message.value = `Your item was not saved. ${((await response.json()) as { error: string }).error}`; return; }
    if (!response.ok) throw new Error(`Save failed: ${response.status}`);
    const saved = (await response.json()) as OwnerItem;
    savedId.value = saved.id; savedDrops.value = { mode: saved.mode, priceDrops: saved.priceDrops };
    if (!saved.retailLookupFailed) { savedReference.value = saved.retailReference; retailProductId.value = undefined; retailDoubtful.value = undefined; }
    const uploaded = await uploadPhoto();
    if (saved.retailLookupFailed) {
      message.value = 'Your item is saved, but the retailer price could not be added. Save again to retry, or remove it and return to your items.';
      return;
    }
    if (!uploaded) return;
    await router.push({ path: '/owner/items', state: { notice: `${form.name.trim()} is saved.` } });
  } catch (error) { console.error('Item save failed', error); message.value = 'Your item was not saved. Check the details and try again.'; }
  finally { busy.value = false; }
}
// Per-item removal lives here, not on the Items list, so a stray tap on the stock list cannot pull an item. The owner's reason shows on the stock list, and a buyer who is paying for it makes the server refuse.
async function takeOffSale() {
  if (busy.value || !removalReason.value.trim()) return;
  busy.value = true; message.value = '';
  try {
    const response = await fetch(`/api/owner/items/${savedId.value}/remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: removalReason.value }) });
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (response.status === 409) { message.value = 'This item cannot be taken off sale right now. A buyer may be paying for it. Try again when the reservation ends.'; confirmingRemoval.value = false; return; }
    if (!response.ok) throw new Error(`Removal failed: ${response.status}`);
    await router.push({ path: '/owner/items', state: { notice: `${form.name.trim()} is off sale.` } });
  } catch (error) { console.error('Take off sale failed', error); message.value = 'The item was not taken off sale. Try again.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="page"><h1>{{ editing ? 'Edit item' : 'Add an item' }}</h1>
    <p v-if="activity" class="muted" data-test="item-activity">{{ activity }}</p>
    <form v-if="ready" class="item-form" @submit.prevent="save">
      <!-- Photo comes first, with its preview and then the matches the photo finds, so choosing a photo changes what is in view.
           The preview shows only once there is a photo, so an empty placeholder does not push the form down. -->
      <!-- The browser's own file control still says "No file chosen" after a photo is in, so a plain button names the next step instead. -->
      <div class="photo-field"><span>Photo, optional</span>
        <label class="btn sec photo-button" :class="{ disabled: busy || preparing }">{{ photoUrl ? 'Change photo' : 'Choose a photo' }}<input type="file" class="sr-only" accept="image/jpeg,image/png,image/webp" :disabled="busy || preparing" @change="choosePhoto"></label>
        <span class="muted">JPEG, PNG or WebP, up to 20 MB.</span></div>
      <p v-if="preparing" role="status">Preparing photo…</p>
      <p v-if="photoMessage" role="alert">{{ photoMessage }}</p>
      <ItemPhoto v-if="photoUrl" :src="photoUrl" :name="form.name || 'Item photo'" />
      <details class="retail-fold disclosure" data-test="retail-details" :open="retailOpen" @toggle="retailToggle"><summary>Check the new price online</summary>
        <RetailLookup :query="form.name" :saved="savedReference" :disabled="busy" :photo="photo" @select="(productId, doubtful) => { retailProductId = productId; retailDoubtful = doubtful; }" @suggest="suggest" /></details>
      <div class="card"><label>Name<input v-model="form.name" required maxlength="80"></label>
        <label>What buyers should know<textarea ref="notesField" v-model="form.notes" required maxlength="2000" rows="2" /><span class="muted">Buyers see this as “The stallholder says”.</span></label></div>
      <fieldset class="mode-choice"><legend>How to sell it</legend>
        <div class="mode-buttons"><button v-for="choice in primaryModes" :key="choice.value" type="button" class="btn sec" :aria-pressed="form.mode === choice.value" @click="form.mode = choice.value">{{ choice.label }}</button></div>
        <details class="disclosure" :open="!primaryModes.some(choice => choice.value === form.mode)"><summary>More ways to sell</summary>
          <div class="mode-buttons"><button v-for="choice in moreModes" :key="choice.value" type="button" class="btn sec" :aria-pressed="form.mode === choice.value" @click="form.mode = choice.value">{{ choice.label }}</button></div></details></fieldset>
      <label>{{ form.mode === 'pwyw' ? 'Expected amount, £, for your records' : form.mode === 'free' ? 'Expected tip, £, for your records' : 'Asking price, £' }}<input v-model="form.asking" :required="!ownFigure" inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"><span v-if="ownFigure" class="muted">Optional. Buyers do not see this.</span></label>
      <p v-if="form.mode === 'free'" class="muted">Buyers take the item free with no PayPal step. They may add a tip of their own choosing, and leave you a short thank-you message.</p>
      <label v-if="form.mode === 'pwyw'">Minimum amount, £, optional<input v-model="form.minimum" inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"><span class="muted">Shown to buyers. They choose their own amount, and it can't be lower than this.</span></label>
      <label v-if="needsFloor">Lowest you'd take, £<input v-model="form.floor" required inputmode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?"><span class="muted">Stallkeeper never sees your floor. Buyers do not see it. It cannot be higher than the asking price.</span></label>
      <p v-if="form.mode === 'haggle' && ladder.length" class="muted ladder-preview">Counter-offers can be {{ ladder.map(money).join(', ') }}.</p>
      <!-- The form runs several screens on a phone, so Save stays pinned within thumb reach, with Take off sale beside it. -->
      <div class="save-bar"><p v-if="message" role="alert">{{ message }}</p><div class="form-actions"><button class="btn" :disabled="busy || preparing">{{ busy ? 'Saving…' : 'Save item' }}</button>
        <button v-if="editing && itemStatus === 'available' && !confirmingRemoval" type="button" class="link danger" :disabled="busy" @click="confirmRemoval">Take off sale</button></div></div>
      <div v-if="editing && itemStatus === 'available' && confirmingRemoval" class="card" role="group" aria-label="Take off sale">
        <p>Buyers will no longer see this item. Your unsaved changes are not kept.</p>
        <label>Reason for removal<input ref="removalField" v-model="removalReason" maxlength="500" @keydown.enter.prevent="takeOffSale"></label>
        <button type="button" class="btn sec" :disabled="busy || !removalReason.trim()" @click="takeOffSale">Take off sale</button>
        <button type="button" class="link" :disabled="busy" @click="confirmingRemoval = false">Keep it for sale</button>
      </div>
    </form><p v-if="message && !ready" role="alert">{{ message }}</p>
  </main>
</template>
<style scoped>
.photo-field { display: flex; flex-direction: column; gap: 8px; }
.photo-button { flex-direction: row; cursor: pointer; }
.photo-button:focus-within { outline: 3px solid var(--ink); outline-offset: 2px; }
.photo-button.disabled { color: var(--muted); cursor: default; }
/* A failed save is reported where Save was tapped, not below a form several screens long. */
.save-bar .form-actions { margin-top: 0; }
.save-bar > p + .form-actions { margin-top: 8px; }
.save-bar { position: sticky; bottom: 0; z-index: 5; margin-inline: -16px; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); border-top: 1px solid var(--rule); background: var(--bg); }
</style>
