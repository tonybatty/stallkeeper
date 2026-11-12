<script setup lang="ts">
import { onMounted, ref } from 'vue';
// The login comes from the public demo response, so it never travels in the item or checkout payload.
defineProps<{ compact?: boolean; folded?: boolean }>();
const buyer = ref<{ email: string; password: string } | null>(null);
const copied = ref('');
const copyFailed = ref(false);
onMounted(async () => {
  try {
    const response = await fetch('/api/demo');
    if (response.ok) buyer.value = (await response.json()).buyer ?? null;
  } catch (error) { console.error('Sandbox buyer could not load', error); }
});
async function copy(label: string, value: string) {
  copyFailed.value = false;
  try { await navigator.clipboard.writeText(value); copied.value = label; }
  catch (error) { console.error('Copy failed', error); copied.value = ''; copyFailed.value = true; }
}
</script>
<template>
  <component :is="folded ? 'details' : 'div'" v-if="buyer" :class="{ login: folded, disclosure: folded }">
  <summary v-if="folded">PayPal login for buyers</summary>
  <section class="sandbox-buyer" :class="{ compact }" aria-labelledby="sandbox-buyer-heading">
    <component :is="compact ? 'h4' : 'h3'" id="sandbox-buyer-heading">PayPal login for buyers</component>
    <p class="muted">Use this account to pay in PayPal.</p>
    <dl>
      <div><dt>Email</dt><dd>{{ buyer.email }}</dd><button type="button" class="btn sec" @click="copy('Email', buyer.email)">Copy email</button></div>
      <div><dt>Password</dt><dd>{{ buyer.password }}</dd><button type="button" class="btn sec" @click="copy('Password', buyer.password)">Copy password</button></div>
    </dl>
    <p role="status" aria-atomic="true" class="muted">{{ copied ? `${copied} copied.` : copyFailed ? 'Copying is not available here. Select the text instead.' : '' }}</p>
  </section>
  </component>
</template>
<style scoped>
.sandbox-buyer { margin-block: 12px; }
dl { margin: 0; display: grid; gap: 8px; }
dl > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 12px; align-items: center; }
dt { font-weight: 700; grid-column: 1 / -1; }
dd { margin: 0; overflow-wrap: anywhere; }
.compact h4 { margin: 0 0 4px; font-size: var(--text-body); }
.compact p, .compact dd { font-size: var(--text-body); }
.btn { width: auto; min-width: 9.5rem; min-height: 44px; margin: 0; }
</style>
