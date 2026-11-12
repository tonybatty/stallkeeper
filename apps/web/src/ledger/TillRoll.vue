<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';

const props = defineProps<{ params: AgWidgetParams }>();
const openItemStory = () => (props.params.context as { openItemStory?: (itemId: string) => void } | undefined)?.openItemStory;
interface Row { key: string; at: string; kind: string; item: string; code: string; amount: number; itemId: string | null }
const rows = ref<Row[]>([]);
const selected = ref<string | null>(null);
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const time = (value: string) => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fields = (params: AgWidgetParams) => (params.dataMapping as unknown as { cols?: AgWidgetField[] }).cols ?? [];
const byId = (params: AgWidgetParams, id: string) => fields(params).find(field => field.fieldId === id);

async function load(params: AgWidgetParams) {
  const columns = fields(params);
  const when = byId(params, 'ledger.at');
  if (!columns.length || !when) { params.widgetApi.setDisplayState('incompleteDataMapping'); return; }
  params.widgetApi.setDisplayState('loading', { prominent: false });
  const response = await params.widgetApi.getData({ fields: columns, sort: [{ field: when, direction: 'desc' }] }, { queryId: 'rows' });
  if (response.replaced) return;
  const key = (id: string) => byId(params, id)?.key ?? id;
  rows.value = response.results.rows.map((row, index) => ({ key: `${row[key('ledger.at')]}-${index}`, at: row[key('ledger.at')], kind: row[key('ledger.kind')], item: row[key('ledger.item')], code: row[key('ledger.code')], amount: row[key('ledger.amount')], itemId: row[key('ledger.itemId')] }));
  params.widgetApi.setDisplayState(rows.value.length ? 'displayed' : 'noData');
  const selection = params.widgetApi.getCrossFilterSelections()?.[0];
  selected.value = selection?.type === 'value' ? String(selection.values?.[0] ?? '') || null : null;
}
function pick(row: Row) {
  if (row.itemId && openItemStory()) { openItemStory()?.(row.itemId); return; }
  const field = byId(props.params, 'ledger.itemId');
  if (!field || !row.itemId) return;
  props.params.widgetApi.toggleCrossFilter({ type: 'value', field, value: row.itemId, group: 0 });
}
const total = computed(() => rows.value.filter(row => row.kind !== 'Donation' && row.kind !== 'Payment to check').reduce((sum, row) => sum + Math.round(row.amount * 100), 0) / 100);
onMounted(() => { void load(props.params); });
defineExpose({ refresh: (params: AgWidgetParams) => { void load(params); return true; } });
</script>

<template>
  <div class="ledger-till">
    <ol>
      <li v-for="row in rows" :key="row.key">
        <button type="button" class="till-entry" :aria-label="row.itemId && openItemStory() ? `Open item story: ${row.item}` : undefined" :aria-pressed="openItemStory() ? undefined : !!row.itemId && selected === row.itemId" :disabled="!row.itemId" @click="pick(row)">
          <span class="line"><span :class="{ 'till-story-name': row.itemId && openItemStory() }">{{ row.item }}</span><strong>{{ money.format(row.amount) }}</strong></span>
          <span class="meta">{{ row.kind }}<template v-if="row.code"> · {{ row.code }}</template> · {{ time(row.at) }}</span>
        </button>
      </li>
    </ol>
    <p class="total"><span>Recorded sales</span><strong>{{ money.format(total) }}</strong></p>
  </div>
</template>

<style>
/* Plain, not scoped: Studio mounts widgets without the scope attribute, so a scoped rule never matches. */
/* A single tear edge keeps the receipt recognisable without boxing every row. */
.ledger-till { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 4px 12px 0; background: var(--bg); border-bottom: 1px dashed var(--line); font-family: var(--font-body); color: var(--ink); }
.ledger-till ol { flex: 1; min-height: 0; margin: 0; padding: 0; list-style: none; overflow-y: auto; }
.ledger-till li { border-bottom: 1px solid var(--rule); }
.ledger-till .till-entry { display: block; width: 100%; min-height: 51px; padding: 8px 2px 2px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.ledger-till .till-entry[aria-pressed='true'] { background: var(--art-bg); }
.ledger-till .till-entry:disabled { cursor: default; }
.ledger-till .till-story-name { font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
/* Room under the name so its link underline clears the meta line below. */
.ledger-till .line { display: flex; justify-content: space-between; gap: 12px; line-height: 1.35; }
.ledger-till strong { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ledger-till .meta { display: block; margin-top: 2px; color: var(--muted); font-family: var(--font-body); font-size: var(--text-small); }
/* On a phone the widget is as tall as its rows and the page scrolls. */
@media (max-width: 500px) { .ledger-till ol { overflow-y: visible; } }
.ledger-till .total { display: flex; flex: 0 0 44px; align-items: center; justify-content: space-between; min-height: 44px; margin: 0; padding: 0 2px; border-top: 1px solid var(--rule); background: var(--bg); font-size: var(--text-body); font-weight: 700; }
</style>
