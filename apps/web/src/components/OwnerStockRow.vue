<script setup lang="ts">
import { computed } from 'vue';
import { money, type OwnerItem } from '../items.js';
import ItemIllustration from './ItemIllustration.vue';

const props = defineProps<{ item: OwnerItem }>();
const modeLabels: Record<string, string> = { fixed: 'Fixed', haggle: 'Offers', pwyw: 'Pay what you want', free: 'Free' };
const free = computed(() => props.item.mode === 'free');
const detail = computed(() => {
  const { item } = props;
  if (item.status === 'sold') return free.value ? 'Free · taken' : `Sold${item.soldPence ? ` · ${money(item.soldPence)}` : ''}`;
  if (item.status === 'removed') return item.removedReason ? `Off sale · ${item.removedReason}` : 'Off sale';
  return `${modeLabels[item.mode] ?? item.mode}${free.value || item.askingPence === null ? '' : ` · ${money(item.askingPence)}`}`;
});
const pill = computed(() => {
  const { status } = props.item;
  if (status === 'sold') return free.value ? { text: 'Taken', tone: 'mute' } : { text: 'Sold', tone: 'ok' };
  if (status === 'removed') return { text: 'Off sale', tone: 'mute' };
  if (status === 'reserved') return { text: 'Held', tone: 'hold' };
  return null;
});
</script>

<template>
  <RouterLink class="stock-row" :to="`/owner/items/${item.id}`" :data-test="`stock-${item.code}`">
    <span class="thumb" aria-hidden="true">
      <img v-if="item.photoUrl" :src="item.photoUrl" alt="">
      <ItemIllustration v-else :kind="item.illustration ?? ''" />
    </span>
    <span class="text"><b>{{ item.name }}</b><span class="muted">{{ detail }}</span></span>
    <span v-if="pill" class="state" :class="pill.tone">{{ pill.text }}</span>
    <span v-else class="chevron" aria-hidden="true">›</span>
  </RouterLink>
</template>

<style scoped>
.stock-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; min-height: 64px; text-decoration: none; border-top: 1px solid var(--rule); }
.stock-row:first-child { border-top: 0; }
.thumb { flex: none; width: 48px; height: 48px; overflow: hidden; border-radius: 10px; background: var(--card); }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb :deep(svg) { width: 100%; height: 100%; max-height: none; border-radius: 0; }
.text { display: flex; flex: 1; flex-direction: column; min-width: 0; line-height: 1.3; }
.state { flex: none; padding: 4px 10px; border-radius: 999px; font-size: var(--text-small); font-weight: 700; }
.state.ok { background: var(--ok-bg); color: var(--ok); }
.state.mute { background: var(--art-bg); color: var(--muted); }
.state.hold { background: var(--flag-bg); color: var(--flag); }
.chevron { flex: none; color: var(--muted); font-size: var(--text-heading); }
</style>
