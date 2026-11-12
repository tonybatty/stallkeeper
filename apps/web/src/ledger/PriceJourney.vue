<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';
import { priceJourneyFieldIds, type PriceJourneyRow, type PriceJourneyStage } from './priceJourney.fixtures.js';

const props = defineProps<{ params: AgWidgetParams }>();
const journeys = ref<{ itemId: string; item: string; code: string; events: PriceJourneyRow[] }[]>([]);
const selected = ref<string | null>(null);
const newEventIds = ref(new Set<string>());
const phone = ref(false);
let activeParams = props.params;
let loaded = false;
let phoneQuery: MediaQueryList | undefined;

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fields = (params: AgWidgetParams) => (params.dataMapping as unknown as { cols?: AgWidgetField[] }).cols ?? [];
const byId = (params: AgWidgetParams, id: string) => fields(params).find(field => field.fieldId === id);
const keyFor = (params: AgWidgetParams, id: typeof priceJourneyFieldIds[number]) => byId(params, id)?.key;

function readValue(row: Record<string, unknown>, params: AgWidgetParams, id: typeof priceJourneyFieldIds[number]) {
  const key = keyFor(params, id);
  return key ? row[key] : undefined;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Studio hands a dateTimeFormat field over as a Date; String(Date) starts with the weekday, which breaks the text sort.
function isoTime(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: Record<string, unknown>, params: AgWidgetParams): PriceJourneyRow {
  return {
    id: String(readValue(row, params, 'journeys.id')),
    itemId: String(readValue(row, params, 'journeys.itemId')),
    item: String(readValue(row, params, 'journeys.item')),
    code: String(readValue(row, params, 'journeys.code')),
    sessionId: String(readValue(row, params, 'journeys.sessionId')),
    at: isoTime(readValue(row, params, 'journeys.at')),
    stage: String(readValue(row, params, 'journeys.stage')) as PriceJourneyStage,
    amount: optionalNumber(readValue(row, params, 'journeys.amount')),
    previousAmount: optionalNumber(readValue(row, params, 'journeys.previousAmount')),
    outcome: readValue(row, params, 'journeys.outcome') == null ? null : String(readValue(row, params, 'journeys.outcome')),
    note: readValue(row, params, 'journeys.note') == null ? null : String(readValue(row, params, 'journeys.note')),
    source: String(readValue(row, params, 'journeys.source')),
  };
}

function groupRows(rows: PriceJourneyRow[]) {
  const grouped = new Map<string, { itemId: string; item: string; code: string; events: PriceJourneyRow[] }>();
  const ordered = [...rows].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  for (const event of ordered) {
    const journey = grouped.get(event.itemId) ?? { itemId: event.itemId, item: event.item, code: event.code, events: [] };
    journey.events.push(event);
    grouped.set(event.itemId, journey);
  }
  return [...grouped.values()];
}

async function load(params: AgWidgetParams) {
  activeParams = params;
  const mapped = fields(params);
  if (priceJourneyFieldIds.some(id => !byId(params, id))) {
    params.widgetApi.setDisplayState('incompleteDataMapping');
    return;
  }
  params.widgetApi.setDisplayState('loading', { prominent: !loaded });
  const at = byId(params, 'journeys.at')!;
  const id = byId(params, 'journeys.id')!;
  const response = await params.widgetApi.getData({ fields: mapped, sort: [{ field: at, direction: 'asc' }, { field: id, direction: 'asc' }] }, { queryId: 'price-journeys' });
  if (response.replaced) return;
  const rows = response.results.rows.map(row => mapRow(row, params));
  const oldIds = new Set(journeys.value.flatMap(journey => journey.events.map(event => event.id)));
  newEventIds.value = loaded ? new Set(rows.filter(row => !oldIds.has(row.id)).map(row => row.id)) : new Set();
  journeys.value = groupRows(rows);
  const selection = params.widgetApi.getCrossFilterSelections()?.[0];
  selected.value = selection?.type === 'value' ? String(selection.values?.[0] ?? '') || null : null;
  loaded = true;
  params.widgetApi.setDisplayState(rows.length ? 'displayed' : 'noData');
}

function pick(itemId: string) {
  const field = byId(activeParams, 'journeys.itemId');
  if (!field) return;
  selected.value = selected.value === itemId ? null : itemId;
  activeParams.widgetApi.toggleCrossFilter({ type: 'value', field, value: itemId, group: 0 });
}

const stageClass = (stage: PriceJourneyStage) => ({
  'price-tag': stage === 'Listed' || stage === 'Price dropped',
  'speech-card': stage === 'Offer' || stage === 'Offer shown',
  receipt: stage === 'Agreed' || stage === 'Paid' || stage === 'Refunded',
  'reversed-receipt': stage === 'Refunded',
});
const mark = (stage: PriceJourneyStage) => stage === 'Refunded' ? '↶' : stage === 'Agreed' || stage === 'Paid' ? '✓' : '';
const orientation = computed(() => phone.value ? 'vertical' : 'horizontal');
const updatePhone = (event?: MediaQueryListEvent) => { phone.value = event?.matches ?? phoneQuery?.matches ?? false; };

onMounted(() => {
  phoneQuery = window.matchMedia('(max-width: 500px)');
  updatePhone();
  phoneQuery.addEventListener?.('change', updatePhone);
  void load(props.params);
});
onBeforeUnmount(() => phoneQuery?.removeEventListener?.('change', updatePhone));
defineExpose({ refresh: (params: AgWidgetParams) => { void load(params); return true; } });
</script>

<template>
  <div class="price-journeys" :aria-orientation="orientation">
    <ol>
      <li v-for="journey in journeys" :key="journey.itemId" class="price-journey" :class="{ selected: selected === journey.itemId }">
        <button
          type="button"
          class="journey-heading"
          :aria-label="`Select price journey for ${journey.item}, tag ${journey.code}`"
          :aria-pressed="selected === journey.itemId"
          @click="pick(journey.itemId)"
        >
          <strong>{{ journey.item }}</strong><span>{{ journey.code }}</span>
        </button>
        <ol class="journey-events">
          <li
            v-for="event in journey.events"
            :key="event.id"
            class="journey-stage"
            :class="[stageClass(event.stage), { 'ink-flash': newEventIds.has(event.id) }]"
          >
            <span v-if="mark(event.stage)" class="stage-mark" aria-hidden="true">{{ mark(event.stage) }}</span>
            <strong class="stage-name">{{ event.stage }}</strong>
            <template v-if="event.stage === 'Price dropped'">
              <span class="price-change"><s v-if="event.previousAmount !== null">{{ money.format(event.previousAmount) }}</s><strong v-if="event.amount !== null">{{ money.format(event.amount) }}</strong></span>
              <span v-if="event.note" class="stage-note">{{ event.note }}</span>
            </template>
            <strong v-else-if="event.amount !== null" class="stage-amount">{{ money.format(event.amount) }}</strong>
            <span v-if="event.outcome" class="stage-note">{{ event.outcome }}</span>
            <time :datetime="event.at">{{ when.format(new Date(event.at)) }}</time>
          </li>
        </ol>
      </li>
    </ol>
  </div>
</template>

<style>
/* Plain, not scoped: Studio mounts widgets without the scope attribute, so a scoped rule never matches. */
.price-journeys { height: 100%; min-height: 0; padding: 4px; overflow: auto; color: var(--ink); }
.price-journeys > ol { display: flex; flex-direction: column; gap: 12px; margin: 0; padding: 0; list-style: none; }
.price-journey { display: block; width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--rule); border-radius: 12px; background: var(--bg); color: inherit; }
.price-journey.selected { border-color: var(--ink); box-shadow: inset 0 0 0 2px var(--ink); }
.journey-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; width: 100%; margin: 0 0 10px; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-family: var(--font-display); text-align: left; cursor: pointer; }
.journey-heading > span { color: var(--muted); font-family: var(--font-body); font-size: var(--text-small); }
.journey-events { display: flex; align-items: stretch; gap: 20px; margin: 0; padding: 2px 2px 12px; overflow: auto hidden; list-style: none; scrollbar-width: thin; }
.journey-stage { position: relative; display: flex; flex: 0 0 9.5rem; flex-direction: column; align-items: flex-start; gap: 3px; min-height: 8.25rem; padding: 12px; border: 1px solid var(--rule); background: var(--card); overflow-wrap: anywhere; }
.journey-stage:not(:last-child)::after { content: ''; position: absolute; top: 50%; left: calc(100% + 1px); width: 20px; border-top: 1px solid var(--rule); }
.journey-stage .stage-name { font-family: var(--font-body); font-weight: 600; font-size: var(--text-small); }
.journey-stage .stage-amount, .price-change strong { font-family: var(--font-body); font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.25; }
.journey-stage time { margin-top: auto; color: var(--muted); font-size: var(--text-small); }
.journey-stage .stage-note { font-size: var(--text-small); line-height: 1.25; }
.price-tag { padding-right: 20px; border-radius: 4px 18px 18px 4px; background: var(--chip); }
.price-tag::before { content: ''; position: absolute; top: 12px; right: 10px; width: 6px; height: 6px; border: 1.5px solid var(--ink); border-radius: 50%; background: var(--bg); }
.price-change { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.price-change s { color: var(--muted); font-size: var(--text-small); }
.speech-card { border-radius: 8px; }
.receipt { border-block-style: dashed; border-radius: 0; }
.stage-mark { display: grid; place-items: center; width: 24px; height: 24px; border: 1.5px solid currentcolor; border-radius: 50%; color: var(--ok); font-weight: 800; line-height: 1; }
.reversed-receipt { border-color: var(--stop); border-top-style: dashed; border-bottom-style: solid; background: var(--stop-bg); }
.reversed-receipt .stage-mark { color: var(--stop); transform: rotate(180deg); }
.ink-flash { animation: price-journey-ink-flash 700ms ease-out 1; }
@keyframes price-journey-ink-flash { 0%, 30% { box-shadow: inset 0 0 0 4px var(--ink); } 100% { box-shadow: inset 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .ink-flash { animation: none; } }
@media (max-width: 500px) {
  .price-journeys { height: auto; overflow: visible; }
  .journey-events { flex-direction: column; gap: 18px; overflow: visible; }
  .journey-stage { flex-basis: auto; width: 100%; min-height: 7rem; }
  .journey-stage:not(:last-child)::after { top: calc(100% + 1px); left: 28px; width: 0; height: 18px; border-top: 0; border-left: 1px solid var(--rule); }
}
</style>
