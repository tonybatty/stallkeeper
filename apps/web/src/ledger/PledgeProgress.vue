<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';

const props = defineProps<{ params: AgWidgetParams }>();
const totals = ref({ pledged: 0, donated: 0, sales: 0, sessions: 0 });
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
async function load(params: AgWidgetParams) {
  const fields = (params.dataMapping as unknown as { value?: AgWidgetField[] }).value ?? [];
  const [session, pledged, donated, sales] = fields;
  if (!session || !pledged || !donated || !sales) { params.widgetApi.setDisplayState('incompleteDataMapping'); return; }
  const response = await params.widgetApi.getData({ fields }, { queryId: 'pledge' });
  if (response.replaced) return;
  const rows = response.results.rows.filter(row => Number(row[pledged.key]) > 0);
  const add = (field: AgWidgetField) => rows.reduce((sum, row) => sum + Math.round(Number(row[field.key]) * 100), 0) / 100;
  totals.value = { pledged: add(pledged), donated: add(donated), sales: add(sales), sessions: rows.length };
  params.widgetApi.setDisplayState(rows.length ? 'displayed' : 'noData');
}
const share = computed(() => totals.value.pledged ? Math.min(100, totals.value.donated / totals.value.pledged * 100) : 0);
onMounted(() => { void load(props.params); });
defineExpose({ refresh: (params: AgWidgetParams) => { void load(params); return true; } });
</script>

<template>
  <div class="ledger-pledge">
    <p class="figure"><strong>{{ money.format(totals.donated) }}</strong> of {{ money.format(totals.pledged) }} pledged</p>
    <div class="track" role="progressbar" aria-label="Donated against pledged" :aria-valuenow="Math.round(share)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${share}%` }"></span></div>
    <p class="muted">Worked out from {{ money.format(totals.sales) }} of recorded sales across {{ totals.sessions }} {{ totals.sessions === 1 ? 'session' : 'sessions' }} with a pledge. A donation here is what PayPal's Donate button reported, and nothing on this page proves the money moved.</p>
  </div>
</template>

<style>
/* Plain, not scoped: Studio mounts widgets without the scope attribute, so a scoped rule never matches. */
.ledger-pledge { display: flex; flex-direction: column; gap: 12px; height: 100%; padding: 8px; overflow: auto; color: var(--ink); }
.ledger-pledge .figure { font-family: var(--font-body); font-size: var(--text-body); }
.ledger-pledge .figure strong { font-size: var(--text-title); }
.ledger-pledge .track { height: 8px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); overflow: hidden; }
.ledger-pledge .track span { display: block; height: 100%; background: var(--accent); }
</style>
