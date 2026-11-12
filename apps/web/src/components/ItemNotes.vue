<script setup lang="ts">
import { money, shortDate, type PublicItem, type RetailReference } from '../items.js';
defineProps<{ item: Pick<PublicItem, 'notes'>; retailReference?: RetailReference | null }>();
</script>
<template>
  <p class="says notes"><b>The stallholder says:</b> {{ item.notes }}</p>
  <p v-if="retailReference" class="retail-reference meta">New from {{ money(retailReference.pricePence) }} at <a :href="retailReference.url" target="_blank" rel="noopener noreferrer">{{ retailReference.retailer }}</a>, checked {{ shortDate(retailReference.checkedAt) }}. Not a valuation of this item.</p>
</template>
