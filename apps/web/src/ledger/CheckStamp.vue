<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';
import { paypalCheck } from './agents.js';

const props = defineProps<{ params: AgWidgetParams }>();
const counts = ref<Record<string, number>>({});
const running = ref(false);
const message = ref('');
const context = computed(() => props.params.context as { transactionNote: () => string; reload: () => Promise<void> });
async function load(params: AgWidgetParams) {
  const fields = (params.dataMapping as unknown as { value?: AgWidgetField[] }).value ?? [];
  const [status, count] = fields;
  if (!status || !count) { params.widgetApi.setDisplayState('incompleteDataMapping'); return; }
  const response = await params.widgetApi.getData({ fields }, { queryId: 'status' });
  if (response.replaced) return;
  counts.value = Object.fromEntries(response.results.rows.map(row => [row[status.key], Number(row[count.key])]));
  params.widgetApi.setDisplayState('displayed');
}
const n = (status: string) => counts.value[status] ?? 0;
// Neutral on purpose: it says where the check stands and never why. Unread orders do not hold back an agreement,
// because the counts beside it say how many were read.
const stamp = computed(() => n('Needs review') || n('PayPal differs') ? { text: 'Needs a look', tone: 'flag' }
  : n('Waiting for PayPal to confirm') || n('Capture pending') ? { text: 'Waiting on PayPal', tone: 'wait' }
    : n('PayPal agrees') ? { text: 'Agrees with PayPal', tone: 'ok' }
      : { text: 'Not checked', tone: 'wait' });
// Grouped by status alone, which a saved layout keeps. A row waiting for PayPal to confirm or for review shows on its own line.
const read = computed(() => n('PayPal agrees') + n('PayPal differs'));
async function run() {
  if (running.value) return;
  running.value = true; message.value = '';
  try {
    const result = await paypalCheck();
    const said = result.note;
    message.value = said;
    if (result.ran) await context.value.reload().catch(() => { message.value = `${said} This page could not update, so refresh to see it.`; });
  } finally { running.value = false; }
}
onMounted(() => { void load(props.params); });
defineExpose({ refresh: (params: AgWidgetParams) => { void load(params); return true; } });
</script>

<template>
  <div class="ledger-check">
    <p class="stamp" :class="stamp.tone">{{ stamp.text }}</p>
    <div class="side">
      <ul>
        <li>{{ read }} of {{ read + n('Confirmed by PayPal') }} read, {{ n('PayPal agrees') }} agree with PayPal</li>
        <li>{{ n('Confirmed by PayPal') }} not read yet</li>
        <li>{{ n('Waiting for PayPal to confirm') }} waiting for PayPal to confirm</li>
        <li>{{ n('Capture pending') }} capture pending</li>
        <li>{{ n('Needs review') + n('PayPal differs') }} to look at</li>
      </ul>
      <p v-if="stamp.tone !== 'ok'" class="muted">{{ context.transactionNote() }}</p>
      <button class="btn sec" type="button" :disabled="running" @click="run">{{ running ? 'Checking' : 'Check with PayPal' }}</button>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
  </div>
</template>

<style>
/* Plain, not scoped: Studio mounts widgets without the scope attribute, so a scoped rule never matches. */
.ledger-check { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; height: 100%; padding: 4px 8px 8px; overflow: auto; color: var(--ink); }
.ledger-check .stamp { flex: 0 1 auto; margin: 12px; padding: 10px 16px; border: 1px solid currentcolor; border-radius: 8px; font-family: var(--font-body); font-size: var(--text-heading); font-weight: 600; }
.ledger-check .ok { color: var(--ok); }
.ledger-check .wait { color: var(--muted); }
.ledger-check .flag { color: var(--flag); }
.ledger-check .side { flex: 1 1 14rem; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.ledger-check ul { margin: 0; padding: 0; list-style: none; font-size: var(--text-small); }
.ledger-check .btn { min-height: 44px; font-size: var(--text-body); }
</style>
