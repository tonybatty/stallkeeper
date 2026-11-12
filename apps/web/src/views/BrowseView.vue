<script setup lang="ts">
import { onMounted, ref } from 'vue';
import CodeEntry from '../components/CodeEntry.vue';
import { money, type PublicItem } from '../items.js';
const stall = ref<{ name: string; items: (PublicItem & { availability: string })[] }>();
const message = ref('');
onMounted(async () => {
  try {
    const response = await fetch('/api/stall');
    if (!response.ok) throw new Error(`Stall request failed: ${response.status}`);
    stall.value = await response.json();

  } catch (error) { console.error('Stall could not load', error); message.value = 'The stall could not load. You can still try a tag code.'; }
});
</script>
<template>
  <main class="page">
    <!-- An empty stall has nothing to rummage through, so its own heading leads instead. -->
    <h1 v-if="stall?.items.length || message">A little rummage. A good find.</h1>
    <section v-if="stall && !stall.items.length" class="card" aria-labelledby="empty-heading">
      <h1 id="empty-heading">Nothing on this stall yet</h1>
      <p>Stallkeeper looks after the stall: scan an item's tag, ask Stallkeeper, and pay in PayPal.</p>
      <RouterLink class="btn" to="/demo">Try Stallkeeper</RouterLink>
    </section>
    <p>Scan a tag, or type its code. No Stallkeeper app or account needed.</p><CodeEntry />
    <RouterLink v-if="!stall || stall.items.length" to="/demo">Try Stallkeeper</RouterLink>
    <p v-if="message" role="alert">{{ message }}</p>
    <div class="stock-grid"><RouterLink v-for="item in stall?.items" :key="item.code" class="card" :to="`/i/${item.code}`">
      <span v-if="item.mode !== 'pwyw'" class="price-chip">{{ item.mode === 'free' ? 'Free' : money(item.askingPence ?? 0) }}</span><h2>{{ item.name }}</h2>
      <p>{{ item.mode === 'fixed' ? 'Fixed price' : item.mode === 'pwyw' ? 'Pay what you want' : item.mode === 'free' ? 'Free, tip optional' : 'Asking, offers welcome' }}</p><p>{{ item.code }} · {{ item.availability }}</p>
    </RouterLink></div>
    <RouterLink to="/owner">Owner login</RouterLink>
  </main>
</template>
