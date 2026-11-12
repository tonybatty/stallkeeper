<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const stallName = ref('');
const message = ref('');
const busy = ref(false);
const closingTime = ref('');
const closingMessage = ref('');
interface Charity { name: string; percent: number; seeded: boolean }
const charity = ref<Charity | null>(null);
const charityName = ref('');
const charityPercent = ref<number | string>('');
const charityMessage = ref('');
const sessionFixed = ref(false);
const donateButton = ref(false);
const demoStall = ref(false);
const sessionStatus = ref('closed');
const reviewMessage = ref('');
const reviewNotes: Record<string, string> = {
  nothing: 'Nothing to review: every item is sold, held by a buyer, or does not allow price drops.',
  unavailable: 'The review could not run, so no prices changed.',
  over_budget: 'Today\'s AI budget is used up, so the review did not run and no prices changed.',
};
async function loadSession() {
  const response = await fetch('/api/owner/items');
  if (!response.ok) throw new Error('Items could not load');
  sessionStatus.value = ((await response.json()) as { sessionStatus: string }).sessionStatus;
}
async function runPriceReview() {
  if (busy.value) return;
  busy.value = true; reviewMessage.value = '';
  try {
    const response = await fetch('/api/owner/demo/price-review', { method: 'POST' });
    if (response.status === 409) { reviewMessage.value = ((await response.json()) as { error: string }).error; return; }
    if (!response.ok) throw new Error(`Price review failed: ${response.status}`);
    const result = await response.json() as { outcome: string; reduced: unknown[]; kept: number; held: number };
    reviewMessage.value = reviewNotes[result.outcome] ?? `Price review finished: ${result.reduced.length} reduced, ${result.kept} left as they were, ${result.held} held for a buyer.`;
  } catch (error) { console.error('Price review failed', error); reviewMessage.value = 'The review could not be confirmed. Check the live feed before trying again.'; }
  finally { busy.value = false; }
}
async function resetStall() {
  if (busy.value) return;
  busy.value = true; reviewMessage.value = '';
  try {
    const response = await fetch('/api/owner/demo/reset', { method: 'POST' });
    if (response.status === 409 || response.status === 429) { reviewMessage.value = ((await response.json()) as { error: string }).error; return; }
    if (!response.ok) throw new Error(`Reset failed: ${response.status}`);
    reviewMessage.value = 'Fresh items are ready. Past payment records are kept.';
    // The reset has finished by now, so a failed refresh must not read as a failed reset.
    await load().catch((error: unknown) => { console.error('Settings could not reload', error); });
  } catch (error) { console.error('Reset failed', error); reviewMessage.value = 'The reset could not be confirmed. Refresh before trying again.'; }
  finally { busy.value = false; }
}

async function saveClosingTime() {
  if (busy.value) return;
  busy.value = true; closingMessage.value = '';
  try {
    const response = await fetch('/api/owner/stall/closing-time', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ closingTime: closingTime.value || null }) });
    if (!response.ok) throw new Error(`Closing time failed: ${response.status}`);
    closingMessage.value = closingTime.value ? 'Closing time saved.' : 'Closing time cleared. No price review will run by itself.';
  } catch (error) { console.error('Closing time failed', error); closingMessage.value = 'The closing time could not be saved. Refresh and try again.'; }
  finally { busy.value = false; }
}
function showCharity(pledge: { charity: Charity | null; sessionFixed?: boolean; donateButton?: boolean }) {
  const value = pledge.charity;
  charity.value = value; charityName.value = value?.name ?? ''; charityPercent.value = value?.percent ?? '';
  sessionFixed.value = !!pledge.sessionFixed; donateButton.value = !!pledge.donateButton;
}
// The percentage must be a whole number from 1 to 100, which the API also checks.
async function saveCharity(clear = false) {
  if (busy.value) return;
  busy.value = true; charityMessage.value = '';
  try {
    const response = await fetch('/api/owner/stall/charity', clear ? { method: 'DELETE' }
      : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: charityName.value.trim(), percent: Number(charityPercent.value) }) });
    if (!response.ok) throw new Error(`Charity change failed: ${response.status}`);
    showCharity(await response.json());
    charityMessage.value = clear ? 'Charity pledge removed.' : 'Charity pledge saved.';
  } catch (error) { console.error('Charity change failed', error); charityMessage.value = 'The pledge could not be saved. Check the name and a whole percentage from 1 to 100.'; }
  finally { busy.value = false; }
}
async function logOut() {
  try {
    const response = await fetch('/api/owner/logout', { method: 'POST' });
    if (!response.ok) throw new Error(`Logout failed: ${response.status}`);
    await router.push('/owner/login');
  } catch (error) {
    console.error('Owner logout failed', error);
    message.value = 'You are still logged in. Please try again.';
  }
}

async function load() {
  const response = await fetch('/api/owner/stall');
  if (response.status === 401) { await router.replace('/owner/login'); return; }
  if (!response.ok) throw new Error(`Stall request failed: ${response.status}`);
  const stall = await response.json() as { name: string; closingTime?: string | null; demo?: boolean };
  stallName.value = stall.name; closingTime.value = stall.closingTime ?? ''; demoStall.value = !!stall.demo;

  if (demoStall.value) await loadSession();
  const pledge = await fetch('/api/owner/stall/charity');
  if (!pledge.ok) throw new Error('Charity could not load');
  showCharity(await pledge.json());
}

onMounted(async () => {
  try { await load(); } catch (error) {
    console.error('Settings failed to load', error);
    message.value = 'Your settings could not load. Refresh the page to try again.';
  }
});
</script>

<template>
  <main class="page">
    <template v-if="stallName">
      <h1>Stall settings</h1>
      <section class="card" aria-labelledby="drops-heading">
        <h2 id="drops-heading">Price drops</h2>
        <form @submit.prevent="saveClosingTime">
          <label>Closing time, UK time<input v-model="closingTime" type="time" aria-describedby="drops-hint"><span id="drops-hint" class="muted">In the last two hours, Claude may lower unsold prices, never to your lowest. Leave empty for no drops.</span></label>
          <button class="btn sec" :disabled="busy">Save closing time</button>
        </form>
        <p v-if="closingMessage" role="status">{{ closingMessage }}</p>
      </section>
      <section v-if="charity" class="card" aria-labelledby="charity-heading">
        <h2 id="charity-heading">Charity pledge</h2>
        <p>Pledge a percentage of each session's recorded sales to a charity. Buyers see one line on item pages, and the closing report works out the amount<template v-if="donateButton"> and offers a PayPal Donate button</template>.</p>
        <form @submit.prevent="saveCharity()">
          <label>Charity name<input v-model="charityName" required maxlength="80"></label>
          <label>Percentage of takings (whole number, 1 to 100)<input v-model="charityPercent" type="number" required min="1" max="100" step="1" inputmode="numeric"></label>
          <button class="btn sec" :disabled="busy">Save pledge</button>
          <button class="btn sec" type="button" :disabled="busy" @click="saveCharity(true)">Remove pledge</button>
        </form>
        <p v-if="sessionFixed" data-test="pledge-fixed">This session has a recorded sale, so it keeps its pledge. Changes here apply from the next session.</p>
        <p v-if="charityMessage" role="status">{{ charityMessage }}</p>
      </section>
      <details v-if="demoStall" class="tools disclosure" data-test="demo-controls">
        <summary>Tools</summary>
        <p>Runs a price review now, as if an hour of trading were left, so you need not wait for closing time. Two reviews per trading session. A reset gives you two more.</p>
        <div class="tool-actions">
          <button class="btn" type="button" :disabled="busy || sessionStatus !== 'open'" data-test="run-review" @click="runPriceReview">Run price review now</button>
          <p v-if="reviewMessage" role="status">{{ reviewMessage }} <RouterLink to="/owner/feed">See the live feed</RouterLink></p>
          <button class="btn sec" type="button" :disabled="busy" data-test="reset-stall" @click="resetStall">Reset stall</button>
        </div>
      </details>
      <button class="btn sec" type="button" data-test="logout" @click="logOut">Log out</button>
    </template>
    <p v-if="message" role="alert">{{ message }}</p>
  </main>
</template>

<style scoped>
.tool-actions { display: flex; flex-direction: column; gap: 12px; }
/* The fold's text and buttons sit in a details element, whose content a flex gap does not reach in every browser, so the text keeps its own space. */
.tools > p { margin-bottom: 12px; }
</style>
