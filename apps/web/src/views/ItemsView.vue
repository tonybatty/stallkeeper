<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { OwnerItem } from '../items.js';
import OwnerStockRow from '../components/OwnerStockRow.vue';

const router = useRouter();
const items = ref<OwnerItem[]>([]);
const loaded = ref(false);
const message = ref('');
// Saving or taking an item off sale lands here with a line saying it worked. It is read once, so a refresh does not repeat it.
const pageHistory = router.options.history;
const notice = ref<string>(typeof pageHistory.state?.notice === 'string' ? pageHistory.state.notice : '');
if (notice.value) pageHistory.replace(router.currentRoute.value.fullPath, { ...pageHistory.state, notice: null });
// Sold and removed items fold away so the stock still for sale comes first. The API already orders each group.
const liveItems = computed(() => items.value.filter(item => item.status !== 'sold' && item.status !== 'removed'));
const earlierItems = computed(() => items.value.filter(item => item.status === 'sold' || item.status === 'removed'));

onMounted(async () => {
  try {
    const stall = await fetch('/api/owner/stall');
    if (stall.status === 401) { await router.replace('/owner/login'); return; }
    if (!stall.ok) throw new Error(`Stall request failed: ${stall.status}`);

    const response = await fetch('/api/owner/items');
    if (!response.ok) throw new Error(`Items request failed: ${response.status}`);
    items.value = ((await response.json()) as { items: OwnerItem[] }).items;
    loaded.value = true;
  } catch (error) {
    console.error('Items page failed to load', error);
    message.value = 'Your items could not load. Refresh the page to try again.';
  }
});
</script>

<template>
  <main class="page owner-items">
    <h1>Items</h1>
    <p v-if="notice" class="saved-notice" role="status">{{ notice }}</p>
    <template v-if="loaded">
      <RouterLink class="btn" to="/owner/items/new">Add item</RouterLink>
      <RouterLink class="btn sec" to="/owner/tags">Print tags</RouterLink>
      <p v-if="!items.length" class="empty">No items yet.</p>
      <div v-if="liveItems.length" class="stock" data-test="stock-list"><OwnerStockRow v-for="item in liveItems" :key="item.id" :item="item" /></div>
      <details v-if="earlierItems.length" class="earlier disclosure" data-test="earlier-stock">
        <summary>Earlier stock ({{ earlierItems.length }})</summary>
        <div class="stock"><OwnerStockRow v-for="item in earlierItems" :key="item.id" :item="item" /></div>
      </details>
    </template>
    <p v-if="message" role="alert">{{ message }}</p>
  </main>
</template>

<style scoped>
.owner-items { gap: 12px; }
.saved-notice { padding: 10px 12px; border-left: 4px solid var(--ok); background: var(--ok-bg); font-weight: 600; }
.empty { margin: 0; color: var(--muted); }
.stock { display: flex; flex-direction: column; border-radius: var(--radius); background: var(--panel); overflow: hidden; }
.earlier .stock { margin-top: 4px; }
</style>
