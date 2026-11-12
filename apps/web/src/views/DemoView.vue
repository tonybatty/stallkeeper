<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ItemIllustration from '../components/ItemIllustration.vue';
import SandboxBuyer from '../components/SandboxBuyer.vue';
import { money } from '../items.js';
import { scrollBehavior } from '../scroll.js';
interface Demo {
  name: string; charity: { line: string; seeded: boolean } | null; filmUrl: string | null; repoUrl: string | null; buyer: { email: string; password: string } | null;
  owner: { loginUrl: string; password: string }; reset: { schedule: string; idleMinutes: number }; open?: boolean;
  items: Array<{ code: string; name: string; mode: string; askingPence: number | null; seeded: boolean; illustration: string | null; availability: string; newFrom: boolean; url: string; qrPng: string }>;
}
const data = ref<Demo>();
const message = ref('');
const ownerMessage = ref('');
const resetMessage = ref('');
// The reset button sits in two places, and the answer shows beside the one that was pressed.
const resetFrom = ref<'notice' | 'card'>('card');
// Prefer a saved reference so the first item shows a "New from" price. Fresh tag codes come from the current stock after each reset.
const start = computed(() => {
  const open = data.value?.items.filter(item => item.mode === 'haggle' && item.availability === 'available') ?? [];
  return open.find(item => item.newFrom) ?? open.find(item => item.illustration === 'lamp') ?? open[0];
});
const stock = computed(() => data.value?.items.filter(item => item.mode === 'haggle' || item.mode === 'fixed') ?? []);
const front = computed(() => stock.value.slice(0, 4));
const busy = ref(false);
// The QR codes are for scanning with another phone. On a phone they would push the item list past five screens, so they sit behind a control there.
const phone = ref(false);
const narrow = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 599px)') : null;
const watchWidth = () => { phone.value = !!narrow?.matches; };
const router = useRouter();
const route = useRoute();
async function load() {
  const response = await fetch('/api/demo');
  if (!response.ok) throw new Error(`Demo failed: ${response.status}`);
  data.value = await response.json() as Demo;

}
onUnmounted(() => narrow?.removeEventListener?.('change', watchWidth));
onMounted(async () => {
  watchWidth(); narrow?.addEventListener?.('change', watchWidth);
  try {
    await load();
    // The roles render only after the first fetch, so the browser's own jump to a #hash (the paid page and the owner page link to #try-owner-heading) finds nothing. A reset reloads too, and must not jump back here.
    if (route.hash) { await nextTick(); document.getElementById(route.hash.slice(1))?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); }
  }
  catch (error) { console.error('Demo could not load', error); message.value = 'This page could not load. Refresh to try again.'; }
});
async function login() {
  const response = await fetch('/api/owner/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: data.value!.owner.password }) });
  if (response.ok) return '';
  return response.status === 429 ? 'Too many tries. Wait a few minutes and try again.' : 'Login is not working right now. Please try again.';
}
async function act(reset: boolean, from: 'notice' | 'card' = 'card') {
  busy.value = true; resetFrom.value = from; ownerMessage.value = ''; resetMessage.value = '';
  const target = reset ? resetMessage : ownerMessage;
  try {
    const failure = await login();
    if (failure) { target.value = failure; return; }
    if (!reset) { await router.push('/owner/feed'); return; }
    const response = await fetch('/api/owner/demo/reset', { method: 'POST' });
    if (response.status === 409) { resetMessage.value = 'A payment is in progress. Try the reset again when it has finished.'; return; }
    if (response.status === 429) { resetMessage.value = 'This stall has been reset many times this hour. Try again later.'; return; }
    if (!response.ok) throw new Error(`Reset failed: ${response.status}`);
    await load();
    resetMessage.value = 'Fresh items are ready. Past payment records are kept.';
  } catch (error) { console.error('Demo action failed', error); target.value = 'The request could not finish. Refresh to check the stall before trying again.'; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="page demo-page">
    <h1>Try Stallkeeper</h1>
    <p>Browse as a buyer, or open the stall as the owner. Scan a tag, ask Stallkeeper, haggle and pay in PayPal. <template v-if="data?.filmUrl"><a :href="data.filmUrl">Watch the film</a></template></p>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <p v-if="data?.charity" data-test="charity-line">{{ data.charity.line }}</p>
    <p v-if="!data && !message" role="status">Loading…</p>
    <template v-if="data">
      <div v-if="!start" class="notice" role="status">
        <p>The stall needs a reset, because no item that takes offers is available. It also resets itself {{ data.reset.idleMinutes }} minutes after it closes or runs out.</p>
        <button class="btn" :disabled="busy" @click="act(true, 'notice')">{{ busy && resetFrom === 'notice' ? 'Please wait…' : 'Reset stall' }}</button>
      </div>
      <p v-if="resetMessage && resetFrom === 'notice'" role="status">{{ resetMessage }}</p>
      <div id="try-owner-heading" class="roles" role="group" aria-label="Choose a role">
        <RouterLink v-if="start" class="btn" :to="`/i/${start.code}`" :title="`Starts with ${start.name}`">Be a buyer</RouterLink>
        <button class="btn sec" :disabled="busy" @click="act(false)">Be the owner</button>
        <p v-if="ownerMessage" role="alert">{{ ownerMessage }}</p>
      </div>
      <details v-if="data.buyer" class="disclosure"><summary>PayPal login for buyers</summary><SandboxBuyer compact /></details>
      <details v-else class="disclosure"><summary>PayPal login for buyers</summary><p class="muted">PayPal login details for buyers are not configured yet. You can still browse the items and the owner pages.</p></details>
      <details class="disclosure"><summary>Owner password</summary>
        <p>Owner password: <code>{{ data.owner.password }}</code></p>
        <RouterLink :to="data.owner.loginUrl">Enter the password yourself</RouterLink>
      </details>
      <details class="disclosure"><summary>What to try, in three steps</summary>
        <ol>
          <li>Be a buyer. Open the item and ask Stallkeeper a question.</li>
          <li>Offer less than the asking price, or try to talk it down to £1. Stallkeeper can only offer a price the server allows. Tap Accept on its offer.</li>
          <li>Pay with the PayPal login and wait for “Paid, take it”. Then be the owner to see the sale.</li>
        </ol>
        <p class="muted">If chat is unavailable, keep the asking price.<template v-if="data.repoUrl"> Every step is in the <a :href="`${data.repoUrl}#demo-walkthrough`">README</a>.</template></p>
      </details>
      <div class="section-head"><h2>On the stall</h2></div>
      <div class="front-grid">
        <RouterLink v-for="item in front" :key="item.code" class="card front-item" :to="`/i/${item.code}`">
          <ItemIllustration v-if="item.illustration" :kind="item.illustration" />
          <b>{{ item.name }}</b>
          <span class="muted">{{ money(item.askingPence ?? 0) }} · {{ item.mode === 'haggle' ? 'Offers' : 'Fixed price' }}{{ item.availability === 'available' ? '' : ` · ${item.availability}` }}</span>
        </RouterLink>
      </div>
      <details class="disclosure all-items"><summary>All {{ stock.length }} items and QR codes</summary>
        <section class="demo-stock" aria-label="Items">
          <article v-for="item in stock" :key="item.code" class="card">
            <ItemIllustration v-if="item.illustration" :kind="item.illustration" />
            <h2>{{ item.name }}</h2>
            <div class="demo-badges"><span class="price-chip">{{ money(item.askingPence ?? 0) }}</span><span v-if="item.mode === 'haggle'" class="pill ai-label">Stallkeeper</span></div>
            <p>{{ item.mode === 'haggle' ? 'Asking price, offers welcome' : 'Fixed price' }}</p>
            <p class="muted">{{ item.availability }}</p>
            <div class="demo-actions">
              <details v-if="phone" class="qr-toggle disclosure"><summary>Show QR code</summary><img class="demo-qr" :src="item.qrPng" :alt="`QR code for ${item.name}, tag ${item.code}`"></details>
              <img v-else class="demo-qr" :src="item.qrPng" :alt="`QR code for ${item.name}, tag ${item.code}`">
              <a class="btn sec" :href="item.url">Open tag {{ item.code }}</a>
            </div>
          </article>
        </section>
      </details>
      <!-- A judge needs Reset only once the stall is closed or sold out, so the link stays out of the way while the stall is open. -->
      <p v-if="!data.open" class="muted reset-line">Resets about {{ data.reset.idleMinutes }} minutes after closing and at {{ data.reset.schedule }}. <button class="link" :disabled="busy" @click="act(true)">{{ busy && resetFrom === 'card' ? 'Please wait…' : 'Reset stall' }}</button></p>
      <p v-if="resetMessage && resetFrom === 'card'" role="status">{{ resetMessage }}</p>
    </template>
  </main>
</template>
<style scoped>
.demo-page { gap: 8px; }
.roles { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.roles p { grid-column: 1 / -1; margin: 0; }
.section-head h2 { margin-block: 8px 4px; }
.front-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.front-item { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 0 8px; align-items: center; padding: 6px; text-decoration: none; color: inherit; }
.front-item :deep(.item-illustration) { grid-row: 1 / span 2; height: 48px; max-height: 48px; }
.front-item b { font-size: var(--text-body); align-self: end; }
.front-item .muted { font-size: var(--text-small); align-self: start; }
.reset-line { font-size: var(--text-small); }
.link { background: none; border: 0; padding: 0; min-height: 44px; color: inherit; text-decoration: underline; cursor: pointer; font: inherit; }
.demo-stock { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ai-label { align-self: flex-start; }
.demo-qr { width: 100%; max-width: 180px; align-self: center; }
.demo-stock .btn { margin-top: auto; }
/* On a desktop the wrappers vanish, so the card lays out as before. */
.demo-badges, .demo-actions { display: contents; }
ol { margin: 0; padding-left: 24px; } li + li { margin-top: 8px; }
@media (min-width: 800px) { .demo-stock { grid-template-columns: repeat(3, minmax(0, 1fr)); } .front-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 599px) {
  .front-grid { grid-template-columns: 1fr; }
  .demo-stock { grid-template-columns: 1fr; gap: 12px; }
  .demo-stock article { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 4px 12px; align-items: start; padding: 12px; }
  .demo-stock article > .item-illustration { grid-column: 1; grid-row: 1 / span 4; }
  .demo-stock article > :not(.item-illustration) { grid-column: 2; }
  .demo-stock article > .demo-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
  .demo-stock article h2 { font-size: var(--text-body); }
  .demo-stock article .price-chip { font-size: var(--text-body); }
  .demo-badges { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .demo-stock .demo-actions .btn { flex: 1 1 9rem; width: auto; min-height: 44px; margin-top: 0; }
  .qr-toggle[open] { flex-basis: 100%; }
  .qr-toggle[open] .demo-qr { display: block; margin: 8px auto; }
}
</style>
