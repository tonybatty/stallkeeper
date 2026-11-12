<script setup lang="ts">
import { money, type OfferCard } from '../items.js';
defineProps<{ card: OfferCard; busy: boolean }>();
defineEmits<{ accept: [] }>();
</script>
<template>
  <article class="card offer-card" :aria-label="`${card.kind === 'counter' ? 'Counter-offer' : 'Offer'} for ${card.itemName}, tag ${card.code}`">
    <div class="offer-head"><span class="offer-label">Stallkeeper's offer: <span class="offer-total price-chip">{{ money(card.totalPence) }}</span></span><span class="price-checked">✓ Checked against the stallholder's limits</span></div>
    <button class="btn" :disabled="busy" @click="$emit('accept')">{{ busy ? 'Accepting…' : `Accept ${money(card.totalPence)}` }}</button>
    <p class="offer-fine">Lasts 30 minutes. It doesn't hold the item.</p>
  </article>
</template>
<style scoped>
.offer-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 16px; }
.offer-card p { margin: 0; }
.offer-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.offer-label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-weight: 700; white-space: nowrap; overflow-wrap: normal; }
.offer-total { font-size: var(--text-heading); font-weight: 700; }
.price-checked { color: var(--ok); font-size: var(--text-small); font-weight: 600; text-align: right; }
.offer-fine { color: var(--muted); font-size: var(--text-small); }
</style>
