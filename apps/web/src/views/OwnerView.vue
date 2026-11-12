<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { money, type OwnerItem } from '../items.js';
import { useRouter } from 'vue-router';

const router = useRouter();
// The stock list itself is on the Items page. Sold and taken free are the session's counts from the server, by the live feed's rule,
// because an item's status keeps a sale from any earlier session.
const forSaleCount = computed(() => items.value.filter(item => item.status !== 'sold' && item.status !== 'removed').length);
const soldCount = ref(0);
const takenCount = ref(0);
const stallName = ref('');
const message = ref('');
const items = ref<OwnerItem[]>([]);
const sessionStatus = ref('closed');
const takenPence = ref(0);
const busy = ref(false);
// Until the items answer, the page would show a closed stall with no takings, so it shows nothing of the stall instead.
const loaded = ref(false);
async function loadItems() {
  const response = await fetch('/api/owner/items');
  if (!response.ok) throw new Error('Items could not load');
  const data = await response.json(); items.value = data.items; sessionStatus.value = data.sessionStatus; takenPence.value = data.takenPence ?? 0;
  soldCount.value = data.itemsSold ?? 0; takenCount.value = data.itemsTaken ?? 0; loaded.value = true;
}
async function change(url: string) {
  if (busy.value) return;
  busy.value = true; message.value = '';
  let saved = false;
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error(`Change failed: ${response.status}`);
    saved = true;
    if (url.endsWith('/close')) { await router.push('/owner/closing'); return; }
    await loadItems();
  } catch (error) {
    console.error('Stock change failed', error);
    // A failed refresh after a saved change must not read as a failed change.
    message.value = saved ? 'Your change was saved, but this page could not update. Refresh the page to see it.' : 'The change could not be saved. Refresh and try again.';
  }
  finally { busy.value = false; }
}

onMounted(async () => {
  try {
    const response = await fetch('/api/owner/stall');
    if (response.status === 401) await router.replace('/owner/login');
    else if (!response.ok) throw new Error(`Stall request failed: ${response.status}`);
    else {
      const stall = await response.json() as { name: string };
      stallName.value = stall.name;
      await loadItems();
    }
  } catch (error) {
    console.error('Owner page failed to load', error);
    message.value = 'Your stall could not load. Refresh the page to try again.';
  }
});
</script>

<template>
  <main class="page owner-home">
    <div class="topbar"><h1>Overview</h1><RouterLink v-if="stallName" class="settings" to="/owner/settings" data-test="settings-link">Settings</RouterLink><span v-if="loaded" class="status" :class="{ open: sessionStatus === 'open' }" data-test="stall-status"><span class="sr-only">Stall </span>{{ sessionStatus === 'open' ? 'Open' : sessionStatus === 'closing' ? 'Closing' : 'Closed' }}</span></div>
    <template v-if="loaded">
      <div class="tiles" :class="{ four: takenCount }" data-test="tiles">
        <div class="tile hero"><b>{{ money(takenPence) }}</b><span>Recorded sales, this session</span></div>
        <div class="tile"><b>{{ soldCount }}</b><span>Sold</span></div>
        <div v-if="takenCount" class="tile"><b>{{ takenCount }}</b><span>Taken free</span></div>
        <div class="tile"><b>{{ forSaleCount }}</b><span>For sale</span></div>
      </div>
      <!-- A closed stall's next step is opening it, so Open stall is the one filled button and comes first. -->
      <button v-if="sessionStatus === 'closed'" class="btn" :disabled="busy" data-test="open-stall" @click="change('/api/owner/stall/open')">Open stall</button>
      <RouterLink class="btn" :class="{ sec: sessionStatus === 'closed' }" to="/owner/items/new">Add item</RouterLink>
      <p v-if="!items.length" class="empty">No items yet.</p>
      <button v-if="sessionStatus === 'open'" type="button" class="btn sec" :disabled="busy" data-test="close-stall" @click="change('/api/owner/stall/close')">Close stall</button>
      <RouterLink v-else class="btn sec" to="/owner/closing" data-test="closing-link">Closing report</RouterLink>
    </template>
    <p v-else-if="!message" class="empty">Loading your stall…</p>
    <p v-if="message" role="alert">{{ message }}</p>
  </main>
</template>

<style scoped>
.owner-home { gap: 12px; }
.empty { margin: 0; color: var(--muted); }
.status { padding: 6px 11px; border-radius: 999px; background: var(--art-bg); color: var(--muted); font-size: var(--text-small); font-weight: 700; }
.status.open { background: var(--ok-bg); color: var(--ok); }
.settings { display: inline-flex; align-items: center; min-height: 44px; padding-inline: 12px; border-radius: var(--radius-sm); background: var(--sec-bg); font-weight: 600; text-decoration: none; }
.tiles { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; }
.tiles.four { grid-template-columns: 1fr 1fr 1fr; }
.tiles.four .hero { grid-column: 1 / -1; }
.tile { display: flex; flex-direction: column; gap: 2px; padding: 12px; border-radius: var(--radius); background: var(--panel); }
.tile b { font-family: var(--font-display); font-size: var(--text-title); line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tiles:not(.four) .tile b { font-size: var(--text-heading); }
.tile.hero { container-type: inline-size; }
.tiles:not(.four) .hero b { font-size: min(var(--text-heading), 19cqi); }
.tile span { font-size: var(--text-small); color: var(--muted); }
.tile.hero { background: var(--ink); color: var(--card); }
.tile.hero span { color: var(--card); }
</style>
