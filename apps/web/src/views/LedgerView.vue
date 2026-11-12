<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AgStudio } from 'ag-studio-vue3';
import { AgStudioAiModule, AgStudioLicenseManager, singleColumnLayout, type AgDataSourcesDefinition, type AgFilterState, type AgReportHistory, type AgReportState, type AgStudioApi, type AgStudioApiReadyEvent, type AgStudioMode, type AgStudioStateUpdatedEvent } from 'ag-studio';
import { clerkLimitNote, clerkPanelNote, ledgerAi } from '../ledger/agents.js';
import { claudeAdapter } from '../ledger/claudeAdapter.js';
import { arrange, canvasHeight, phoneBreakpoint, phoneCounts, phoneQuery } from '../ledger/phone.js';
import { initialReport, itemStoryFilter, itemStoryReport, keepEdits, pageTitles, tabPages } from '../ledger/report.js';
import { tableChanges, toStudioData, type LedgerData } from '../ledger/sources.js';
import type { PriceJourneyRow } from '../ledger/priceJourney.fixtures.js';
import { ledgerTheme } from '../ledger/theme.js';
import { ledgerWidgets } from '../ledger/widgets.js';
import { setItemStoryOpener } from '../ledger/itemCell.js';

interface Config { licenceKey: string | null; aiEnabled: boolean }
const router = useRouter();
const route = useRoute();
// The model is billed and capped in US dollars, and the stall trades in pounds, so the header converts at a fixed rate:
// 1 US dollar to £0.75, the x-rates.com mid-market rate on 1 November 2026 (0.7464). It is an estimate either way, so a
// fixed rate is close enough; revisit it if sterling moves more than a few per cent.
const gbpPerUsd = 0.75;
const pounds = (usd: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd * gbpPerUsd);
const data = shallowRef<LedgerData>();
const studioData = shallowRef<AgDataSourcesDefinition>();
const startState = shallowRef<AgReportState | AgReportHistory>();
const ai = shallowRef<ReturnType<typeof ledgerAi>>();
const api = shallowRef<AgStudioApi>();
const clerkPanel = shallowRef<Element>();
const failed = ref(false);
const mode = ref<AgStudioMode>('view');
const asking = ref(false);
const page = ref('takings');
const studioKey = ref(0);
const storyItem = computed(() => data.value?.items.find(item => item.id === String(route.query.item ?? '')));
const inStory = computed(() => !!storyItem.value);
// The v2 key leaves behind layouts saved when the filters were widgets in the report, which would open with a gap where they sat.
const layoutKeyFor = (demo: boolean | undefined) => `stallkeeper-ledger-layout-v2-${demo ? 'demo' : 'main'}`;
const layoutKey = computed(() => layoutKeyFor(data.value?.stall.demo));
// A phone reads the report as one page: the figures first and every row of a list shown.
const phone = ref(typeof window !== 'undefined' && !!window.matchMedia?.(phoneQuery).matches);
// Bumped when what sets the phone layout may have changed outside Vue's sight: the report state, which Studio holds and which
// changes only through this view's own calls or during an edit session.
const layoutVersion = ref(0);
const reportState = (state: AgReportState | AgReportHistory | undefined): AgReportState | undefined => state && 'current' in state ? state.current : state;
const pageWidgets = computed(() => {
  void layoutVersion.value;
  const state = api.value?.getState() ?? reportState(startState.value);
  return state?.pages.find(entry => entry.id === page.value)?.widgetLayout ?? {};
});
const breakpoints = computed(() => phone.value && data.value
  ? [phoneBreakpoint(page.value, Object.keys(pageWidgets.value), phoneCounts(data.value, storyItem.value?.id))]
  : [{ maxWidth: 500, layout: singleColumnLayout }]);
const flow = computed(() => phone.value && mode.value === 'view');
const canvasStyle = computed(() => {
  if (!flow.value || !data.value) return undefined;
  const ids = Object.keys(pageWidgets.value);
  const layouts = ids.map(id => pageWidgets.value[id]!);
  return { height: `${canvasHeight(arrange(page.value, ids, layouts, 24, phoneCounts(data.value, storyItem.value?.id)).rows)}px` };
});
const sessionChoice = ref('');
const dateFrom = ref('');
const dateTo = ref('');
const sessionLabels = computed(() => {
  const used = new Set([...(data.value?.ledger ?? []), ...(data.value?.offers ?? [])].map(row => row.sessionId));
  return data.value?.sessions.filter(session => used.has(session.id)).map(session => session.label) ?? [];
});
const datesSet = computed(() => !!(dateFrom.value || dateTo.value));
const tabs = computed(() => page.value === 'paypal' ? Object.keys(pageTitles) : tabPages);
// On a wide screen the clerk is the panel beside the report, and Edit swaps it for Studio's editing panels. A phone has no room
// for the panel, so there the clerk opens from the menu.
const clerkBeside = computed(() => !phone.value && !!ai.value);
// With no money movements and no offers every summary tile would say "No data to display", so the summary is one sentence instead.
// An item story still opens, because its price journey starts when the item is listed.
const noMoney = (fresh: LedgerData | undefined) => !!fresh && !fresh.ledger.length && !fresh.offers.length;
const nothingYet = computed(() => noMoney(data.value) && !inStory.value);
const viewing = computed(() => mode.value === 'view' || (clerkBeside.value && asking.value));
const menu = ref<HTMLDetailsElement>();
// The filters are in the header, so Studio's own filters panel stays out of view mode.
const panels = computed(() => ({ view: { left: [], right: [] }, edit: asking.value ? { left: [], right: ['ai' as const] } : { left: ['data' as const], right: ['edit' as const, 'filters' as const] } }));
// Studio adds "(max)" to the name of a maximum, which the price chart's legend does not want.
const localeText = { panelTitleAi: 'Ask the clerk', aiMessageInputPlaceholder: 'Ask about your stall records', aiStepDelegatedTo: '', aggregationMaxFieldName: '${name}' };
const pageLayout = { minWidth: 320, widgetBorderEnabled: true };
const context = computed(() => ({ transactionNote: () => data.value?.paypalCheck.transactionList.note ?? '', reload, ...(!inStory.value && { openItemStory }) }));
const showLedgerNotes = computed(() => !!(data.value?.aiSpend || (!ai.value && studioData.value) || (mode.value === 'edit' && asking.value && !nothingYet.value)));

async function read<T>(url: string) {
  const response = await fetch(url);
  if (response.status === 401) { await router.replace('/owner/login'); return; }
  if (!response.ok) throw new Error(`Ledger read failed: ${response.status}`);
  return await response.json() as T;
}
async function reload() {
  const [ledger, journeys] = await Promise.all([read<LedgerData>('/api/owner/ledger/data'), read<PriceJourneyRow[]>('/api/owner/ledger/journeys')]);
  if (!ledger || !journeys) return;
  const wasEmpty = nothingYet.value;
  data.value = { ...ledger, journeys };
  if (wasEmpty && !nothingYet.value) remount();
  else await catchUp();
}
let held: LedgerData | undefined;
async function catchUp() {
  const engine = api.value?.getDataEngine();
  const fresh = data.value;
  if (!engine || !held || !fresh || held === fresh) return;
  const changes = tableChanges(held, fresh);
  held = fresh;
  if (changes.length) await engine.applyTransaction?.(changes);
}
function remount() {
  if (!data.value) return;
  studioData.value = toStudioData(data.value);
  held = data.value;
  api.value = undefined;
  clerkPanel.value = undefined;
  studioKey.value += 1;
  layoutVersion.value += 1;
}
function refresh() { reload().catch((error: unknown) => { console.error('Ledger refresh failed', error); }); }
// The live feed's stream says something changed, never what, so each update refetches and sends the difference to Studio.
let stream: EventSource | undefined;
let pending: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const stale = ref(false);
function follow() {
  stream = new EventSource('/api/owner/feed/stream');
  stream.addEventListener('update', () => {
    clearTimeout(pending);
    pending = setTimeout(refresh, 500);
  });
  // The server sends an update on every connection, so a reconnect also repairs what was missed.
  stream.onopen = () => { stale.value = false; };
  stream.onerror = () => {
    stale.value = true;
    // Browsers retry dropped connections themselves but give up for good on a non-200 reply. The refetch sends an ended session to the login.
    if (stream?.readyState !== EventSource.CLOSED) return;
    refresh();
    clearTimeout(retry);
    retry = setTimeout(() => { if (!disposed) { stream?.close(); follow(); } }, 5_000);
  };
}
function savedLayout(fresh: LedgerData) {
  try {
    const saved = localStorage.getItem(layoutKeyFor(fresh.stall.demo));
    return saved ? JSON.parse(saved) as AgReportState : undefined;
  } catch { return undefined; }
}
// A wide screen with the clerk is always in Studio's edit mode, so leaving the page is not a sign the owner edited anything. Only a
// recorded change to the report is saved, so a layout the owner never touched follows the default when it changes.
let edited = false;
// Writes through this view's own setState calls are the page and filter choices, which are never kept.
function noteUpdate(event: AgStudioStateUpdatedEvent) { if (page.value !== 'story' && event.durable && event.change && event.change.source.type !== 'api') edited = true; }
function saveLayout() {
  // A phone's layout is its own and never the one a desktop should open with.
  if (page.value === 'story' || phone.value || !api.value || !edited) return;
  try { localStorage.setItem(layoutKey.value, JSON.stringify(api.value.getState())); edited = false; } catch { /* A private window has no storage. The layout then lasts until the page closes. */ }
}
function resetLayout() {
  if (inStory.value) {
    if (api.value) api.value.setState({ ...itemStoryReport(), panels: api.value.getState().panels });
    layoutVersion.value += 1;
    return;
  }
  try { localStorage.removeItem(layoutKey.value); } catch { /* Nothing to clear. */ }
  // Studio animates any panel whose state changes, and that throws for a panel Edit has taken off the page, so the live panels
  // object goes back unchanged. Remove once ag-studio skips the animation for a detached panel (seen in 3.1.0, Panel.toggleExpanded).
  if (data.value && api.value) api.value.setState({ ...initialReport(), panels: api.value.getState().panels });
  edited = false;
  page.value = 'takings';
  sessionChoice.value = ''; dateFrom.value = ''; dateTo.value = '';
  layoutVersion.value += 1;
}
function showPage(id: string) {
  // On a phone the clerk is Studio's edit mode, whose layout squeezes the report into desktop columns, so a new page leaves it.
  if (phone.value && mode.value === 'edit') { asking.value = false; mode.value = 'view'; }
  page.value = id;
  const state = api.value?.getState();
  if (state) api.value?.setState({ ...state, selectedPageId: id });
  layoutVersion.value += 1;
}
// The header filters go to Studio as page filters. Their filterWidgetId marks them as a moment's choice, which a saved layout drops.
const headerFilter = (id: string) => id.startsWith('header-');
function foldedFilters(pageId: string): AgFilterState[] {
  const filters: AgFilterState[] = [];
  if (sessionChoice.value) filters.push({ field: { id: 'sessions.label' }, filterWidgetId: 'header-session', model: { operator: 'isIn', value: [sessionChoice.value] } });
  const from = dateFrom.value ? `${dateFrom.value}T00:00:00` : '';
  const to = dateTo.value ? `${dateTo.value}T23:59:59` : '';
  const dates = from && to ? { operator: 'between' as const, value: [from, to] }
    : from ? { operator: 'greaterThanOrEqual' as const, value: from } : to ? { operator: 'lessThanOrEqual' as const, value: to } : undefined;
  if (pageId === 'takings' && dates) filters.push({ field: { id: 'ledger.at' }, filterWidgetId: 'header-dates', model: dates });
  return filters;
}
function applyFilters() {
  const state = api.value?.getState();
  if (!state) return;
  api.value?.setState({ ...state, pages: state.pages.map(entry => ({ ...entry, filter: { ...entry.filter, page: [...(entry.filter?.page ?? []).filter(filter => !headerFilter(filter.filterWidgetId ?? '')), ...foldedFilters(entry.id)] } })) });
  layoutVersion.value += 1;
}
// Studio shows its chat panel only in edit mode, so asking opens that mode with the chat alone beside the report.
function toggle(wantsChat: boolean) {
  const leaving = mode.value === 'edit' && asking.value === wantsChat;
  if (mode.value === 'edit') saveLayout();
  asking.value = wantsChat;
  mode.value = leaving ? 'view' : 'edit';
  layoutVersion.value += 1;
}
// Edit swaps the clerk for the editing panels and back, so a wide screen is always in Studio's edit mode while the clerk is there.
function toggleEdit() {
  menu.value?.removeAttribute('open');
  if (!clerkBeside.value) { toggle(false); return; }
  saveLayout();
  asking.value = !asking.value;
  layoutVersion.value += 1;
}
function askFromMenu() { menu.value?.removeAttribute('open'); toggle(true); }
function openPage(id: string) { menu.value?.removeAttribute('open'); showPage(id); }
function reset() { menu.value?.removeAttribute('open'); resetLayout(); }
async function findClerkPanel() {
  await nextTick();
  clerkPanel.value = document.querySelector('.ledger .ag-studio-ai-assistant-panel') ?? undefined;
}
watch([asking, mode], findClerkPanel);
async function ready(event: AgStudioApiReadyEvent) {
  api.value = event.api as unknown as AgStudioApi;
  layoutVersion.value += 1;
  await findClerkPanel();
  catchUp().catch((error: unknown) => { console.error('Ledger refresh failed', error); });
}

interface SummarySnapshot {
  state: AgReportState | AgReportHistory;
  page: string;
  mode: AgStudioMode;
  asking: boolean;
  session: string;
  dateFrom: string;
  dateTo: string;
}
let summary: SummarySnapshot | undefined;
let storyWasPushed = false;
function snapshot(fallback: AgReportState | AgReportHistory): SummarySnapshot {
  const history = (api.value as (AgStudioApi & { getHistory?: () => AgReportHistory }) | undefined)?.getHistory?.();
  return {
    state: history ?? api.value?.getState() ?? fallback,
    page: page.value, mode: mode.value, asking: asking.value,
    session: sessionChoice.value, dateFrom: dateFrom.value, dateTo: dateTo.value,
  };
}
function openItemStory(itemId: string) {
  if (!data.value?.items.some(item => item.id === itemId) || inStory.value || !startState.value) return;
  summary = snapshot(startState.value);
  storyWasPushed = true;
  void router.push({ query: { ...route.query, item: itemId } });
}
function syncStory() {
  const itemId = typeof route.query.item === 'string' ? route.query.item : '';
  if (!data.value || !startState.value) return;
  if (itemId && data.value.items.some(item => item.id === itemId)) {
    summary ??= snapshot(startState.value);
    saveLayout();
    startState.value = itemStoryReport();
    page.value = 'story';
    mode.value = clerkBeside.value ? 'edit' : 'view';
    asking.value = clerkBeside.value;
    remount();
    return;
  }
  if (!itemId && summary && page.value === 'story') {
    startState.value = summary.state;
    page.value = summary.page;
    mode.value = summary.mode;
    asking.value = summary.asking;
    sessionChoice.value = summary.session;
    dateFrom.value = summary.dateFrom;
    dateTo.value = summary.dateTo;
    summary = undefined;
    storyWasPushed = false;
    remount();
  }
}
function closeStory() {
  if (storyWasPushed) { router.back(); return; }
  const query = { ...route.query };
  delete query.item;
  void router.replace({ query });
}
watch(() => route.query.item, syncStory);
watch(inStory, story => { setItemStoryOpener(story ? undefined : openItemStory); }, { immediate: true });

onMounted(async () => {
  try {
    const [config, ledger, journeys] = await Promise.all([read<Config>('/api/owner/ledger/config'), read<LedgerData>('/api/owner/ledger/data'), read<PriceJourneyRow[]>('/api/owner/ledger/journeys')]);
    if (disposed || !config || !ledger || !journeys) return;
    const fresh = { ...ledger, journeys };
    // Set before Studio mounts. With no key Studio shows its own trial watermark, which stays.
    if (config.licenceKey) AgStudioLicenseManager.setLicenseKey(config.licenceKey);
    if (config.aiEnabled) ai.value = ledgerAi(claudeAdapter(), () => data.value!, refresh);
    // Studio shows its chat panel only in edit mode, so a wide screen opens in that mode with the chat alone beside the report.
    if (ai.value && !phone.value) { mode.value = 'edit'; asking.value = true; }
    data.value = fresh;
    const built = initialReport();
    const saved = savedLayout(fresh);
    startState.value = saved ? keepEdits(built, saved) : built;
    studioData.value = toStudioData(fresh);
    held = fresh;
    syncStory();
    follow();
  } catch (error) { console.error('Ledger failed to load', error); failed.value = true; }
});
// Only edits are kept, so a filter from last time never narrows the report.
onUnmounted(() => { setItemStoryOpener(undefined); disposed = true; clearTimeout(pending); clearTimeout(retry); stream?.close(); if (mode.value === 'edit') saveLayout(); });
</script>

<template>
  <main class="ledger" :class="{ flow, viewing }">
    <header class="ledger-head">
      <div class="row ledger-bar">
        <button v-if="inStory" type="button" class="ledger-back" @click="closeStory">Back to ledger</button>
        <h1>{{ inStory ? 'Item story' : 'Stall ledger' }}</h1>
        <p v-if="stale" class="ledger-stale" role="status">Updates paused</p>
        <p v-if="storyItem" class="story-name"><strong>{{ storyItem.name }}</strong><span>{{ storyItem.code }}</span></p>
        <div v-if="showLedgerNotes && (!clerkBeside || !clerkPanel)" class="ledger-notes muted">
          <p v-if="data?.aiSpend" data-test="ai-spend">AI spend today: about {{ pounds(data.aiSpend.spentUsd) }} of the {{ pounds(data.aiSpend.capUsd) }} daily cap. An estimate across the whole service, not only this stall.</p>
          <p v-if="!ai && studioData" class="ledger-limit">{{ clerkLimitNote }}</p>
          <p v-if="mode === 'edit' && asking && !nothingYet">{{ clerkPanelNote }}</p>
        </div>
        <div v-if="!inStory && !nothingYet" class="ledger-tabs" role="tablist" aria-label="Report pages">
          <button v-for="id in tabs" :key="id" type="button" role="tab" :aria-selected="page === id" @click="showPage(id)">{{ pageTitles[id] }}</button>
        </div>
        <div v-if="!nothingYet" class="row ledger-end">
          <select v-if="studioData && !inStory" v-model="sessionChoice" class="ledger-session" aria-label="Session" @change="applyFilters">
            <option value="">All sessions</option>
            <option v-for="label in sessionLabels" :key="label" :value="label">{{ label }}</option>
          </select>
          <details v-if="studioData" ref="menu" class="ledger-menu">
            <summary aria-label="More">&#8943;<span v-if="datesSet" class="ledger-dot" role="img" aria-label="Dates are filtered"></span></summary>
            <div class="ledger-menu-body">
              <template v-if="page === 'takings' && !inStory">
                <label>Dates from <input v-model="dateFrom" type="date" @change="applyFilters"></label>
                <label>to <input v-model="dateTo" type="date" @change="applyFilters"></label>
              </template>
              <button v-if="!inStory" type="button" @click="openPage('paypal')">PayPal check</button>
              <button v-if="ai && !clerkBeside" type="button" :aria-pressed="mode === 'edit' && asking" @click="askFromMenu">{{ mode === 'edit' && asking ? 'Close the clerk' : 'Ask the clerk' }}</button>
              <!-- A phone's layout is never saved, and Edit's three panels would cover the whole report there. -->
              <button v-if="!phone" type="button" :aria-pressed="mode === 'edit' && !asking" @click="toggleEdit">Edit</button>
              <button type="button" @click="reset">Reset layout</button>
              <nav class="ledger-links" aria-label="Owner pages"><RouterLink to="/owner/closing">Closing report</RouterLink></nav>
            </div>
          </details>
        </div>
      </div>
    </header>
    <p v-if="failed" class="notice" role="alert">The ledger could not load. Refresh to try again. Your stall and its payments are unaffected.</p>
    <p v-else-if="nothingYet" class="ledger-empty" role="status" data-test="ledger-empty">{{ data?.items.length ? 'No sales yet. Takings, offers and the PayPal check appear after the first sale.' : 'Nothing recorded yet. Sales, tips and offers show here once buyers pay or make an offer.' }}</p>
    <div v-else-if="studioData && startState" class="ledger-canvas" :class="{ story: inStory, paypal: page === 'paypal' && !inStory, 'one-session': !!sessionChoice && !inStory }" :style="canvasStyle">
      <AgStudio :key="studioKey" :modules="[AgStudioAiModule]" :data="studioData" :initial-state="startState" :drill-through="storyItem ? itemStoryFilter(storyItem.id) : undefined" :theme="ledgerTheme" :widgets="ledgerWidgets" :mode="mode" :ai="ai" :context="context"
        :layout="pageLayout" :responsive-layout-breakpoints="breakpoints" :panels="panels" :locale-text="localeText" style="height: 100%; width: 100%" @api-ready="ready" @state-updated="noteUpdate" />
    </div>
    <p v-else class="muted ledger-wait" role="status">Opening the ledger</p>
    <Teleport v-if="showLedgerNotes && clerkBeside && clerkPanel" :to="clerkPanel">
      <!-- Folded, so the conversation keeps the panel's height. The notes stay one tap away. -->
      <details class="ledger-clerk-notes disclosure muted">
        <summary>About</summary>
        <p v-if="data?.aiSpend" data-test="ai-spend">AI spend today: about {{ pounds(data.aiSpend.spentUsd) }} of the {{ pounds(data.aiSpend.capUsd) }} daily cap. An estimate across the whole service, not only this stall.</p>
        <p v-if="mode === 'edit' && asking && !nothingYet">{{ clerkPanelNote }}</p>
      </details>
    </Teleport>
  </main>
</template>

<style scoped>
/* Less the compact title bar, its owner tabs and its 1px rule, which App.vue keeps above this page. */
.ledger { display: flex; flex-direction: column; height: calc(100dvh - var(--titlebar-height-compact) - var(--owner-tabs-height) - 1px); background: var(--bg); }
.ledger-head { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 8px; border-bottom: 1px solid var(--rule); }
.ledger-head h1 { font-size: var(--text-heading); }
.ledger-back { min-width: 44px; min-height: 44px; padding: 6px 12px; border: var(--bw) solid var(--muted); border-radius: var(--chip-radius); background: var(--card); color: var(--ink); font-weight: 700; cursor: pointer; }
.story-name { display: flex; align-items: baseline; gap: 8px; margin: 0; }
.story-name span { color: var(--muted); font-size: var(--text-small); }
.ledger-bar { gap: 12px; }
.ledger-stale { margin: 0; color: var(--flag); font-size: var(--text-small); font-weight: 600; }
.ledger-end { margin-left: auto; gap: 8px; }
.ledger-session { width: auto; min-height: 44px; padding: 4px 10px; }
.ledger-menu { position: relative; }
.ledger-menu summary { display: flex; align-items: center; justify-content: center; position: relative; width: 44px; min-height: 44px; border: var(--bw) solid var(--muted); border-radius: var(--chip-radius); background: var(--card); font-size: var(--text-heading); font-weight: 700; cursor: pointer; list-style: none; }
.ledger-menu summary::-webkit-details-marker { display: none; }
.ledger-dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--ink); }
.ledger-menu-body { position: absolute; top: calc(100% + 6px); right: 0; z-index: 20; display: flex; flex-direction: column; gap: 6px; min-width: 14rem; padding: 10px; border: var(--bw) solid var(--line); border-radius: var(--chip-radius); background: var(--card); }
.ledger-menu-body label { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-small); }
.ledger-menu-body input { min-height: 44px; }
.ledger-menu-body button { min-height: 44px; padding: 6px 12px; border: var(--bw) solid var(--muted); border-radius: var(--chip-radius); background: var(--card); color: var(--ink); font-weight: 600; text-align: left; cursor: pointer; }
.ledger-menu-body button[aria-pressed='true'] { background: var(--chip); border-color: var(--ink); }
.ledger-links { display: flex; justify-content: space-between; gap: 12px; padding-top: 4px; font-size: var(--text-small); }
.ledger-links a { display: inline-flex; align-items: center; min-height: 44px; }
.ledger-canvas { flex: 1; min-height: 0; }
/* Studio shows a widget's toolbar only while the pointer is over it, or the widget has focus or is selected, and a phone has no
   hover. A grid's toolbar holds its CSV export, so it stays up. Studio sets no placement until it first shows the toolbar, so the
   corner is set here too. No theme parameter or widget setting controls this, which is checked in AG Studio 3.1.0. */
.ledger.flow .ledger-canvas :deep(.ag-studio-layout-widget:has(.ag-root-wrapper) .ag-studio-widget-toolbar) { display: flex; opacity: 1; transform: none; top: 14px; right: 18px; }
/* Studio sizes its toolbar buttons to the icon plus 8 px each side, 32 px wide, and has no width parameter (AG Studio 3.1.0).
   The CSV export is a tap target on a phone, so it gets the 44 px minimum, growing with the browser's text size like its height. */
.ledger-canvas :deep(.ag-studio-widget-toolbar-button) { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: max(2.75rem, 44px); min-height: max(2.75rem, 44px); }
.ledger-wait { padding: 16px; }
/* A phone's grid cell for Item also carries the row's amount, which the columns after Item would otherwise hide off to the right. */
.ledger-canvas :deep(.ledger-item-cell) { position: relative; display: flex; flex-direction: column; justify-content: center; height: 100%; line-height: 1.25; }
.ledger-canvas :deep(.ledger-item-name) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* At 1440 px with the clerk open, the Takings and PayPal check grids squeeze eight or six columns into the canvas, so
   'Waiting for PayPal to confirm' would end in an ellipsis. Its cell wraps to a second line inside the 44 px row instead,
   which keeps the label whole without taking width from Amount. The item story grid has room and is left as it was. */
.ledger-canvas:not(.story) :deep(.ag-cell[col-id='ledger.status']) { display: flex; align-items: center; white-space: normal; line-height: 1.2; }
/* Studio 3.1.0 rounds autosized columns down: £36.00 needs 59.047px but receives 59px, and 'Refund' 57.4px gets 57px, producing
   an ellipsis. The grid measures a column from clones of its cells and header placed in a form, so only those clones get a pixel
   more, every column comes out a pixel wider and the ellipsis still marks a value that is really cut.
   Remove when autosize rounds up: https://www.ag-grid.com/studio/vue/ */
.ledger-canvas :deep(form > .ag-row > .ag-cell), .ledger-canvas :deep(form > .ag-header-row > .ag-header-cell) { margin-inline-end: 1px; }
/* The status clone is capped, or autosize gives the column the label's full single-line width, the cell above never wraps and the
   label runs past the table's edge at 1280 px. */
.ledger-canvas:not(.story) :deep(form > .ag-row > .ag-cell[col-id='ledger.status']) { max-width: 11rem; }
.ledger-canvas :deep(.ledger-item-amount) { color: var(--muted); font-size: var(--text-small); font-weight: 600; font-variant-numeric: tabular-nums; }
.ledger-canvas :deep(.ledger-item-amount[data-kind='refund']) { color: var(--ink); }
.ledger-canvas :deep(.ledger-item-story) { display: flex; flex-direction: column; justify-content: center; width: 100%; max-width: 100%; min-height: 44px; padding: 0; border: 0; background: none; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.ledger-canvas :deep(.ledger-item-story .ledger-item-name) { text-decoration: underline; text-underline-offset: 3px; }
.ledger-notes { flex: 1 1 18rem; min-width: 0; font-size: var(--text-small); line-height: 1.35; }
.ledger-notes p, .ledger-clerk-notes p { margin: 0; }
.ledger-clerk-notes { order: -1; padding-inline: 12px; border-top: 0; font-size: var(--text-small); line-height: 1.35; }
.ledger-clerk-notes p + p { margin-top: 4px; }
.ledger-empty { padding: 24px 16px; }
.ledger-tabs { display: flex; gap: 4px; overflow-x: auto; }
.ledger-tabs button { min-width: 44px; min-height: 44px; padding: 6px 12px; border: var(--bw) solid var(--muted); border-radius: var(--chip-radius); background: var(--card); color: var(--ink); font-weight: 600; white-space: nowrap; cursor: pointer; }
.ledger-tabs button[aria-selected='true'] { background: var(--art-bg); border-color: var(--ink); }
@media (max-width: 500px) {
  /* The page scrolls, not the report. The canvas is given the height of its widgets. */
  .ledger.flow { height: auto; min-height: calc(100dvh - var(--titlebar-height-compact) - var(--owner-tabs-height) - 1px); }
  .ledger.flow .ledger-canvas { flex: none; }
  .ledger-head { gap: 4px; padding: 8px 12px 6px; }
  .ledger-head .row { gap: 6px; }
  .ledger-bar { flex-wrap: wrap; }
  .ledger-tabs { order: 3; flex: 1 1 100%; }
  .ledger-notes { order: 4; flex-basis: 100%; }
  /* The grid scrolls sideways on a phone and Studio draws no sign of it, so the title row says more columns follow. The hint sits
     beside the title, so it is kept to the pages whose tables have short titles: PayPal check and the item story have long ones. */
  .ledger.flow .ledger-canvas:not(.story):not(.paypal) :deep(.ag-studio-layout-widget:has(.ag-root-wrapper))::after { content: 'Swipe for more columns \203A'; position: absolute; top: 20px; right: 76px; max-width: calc(100% - 12rem); text-align: right; line-height: 1.2; z-index: 5; color: var(--muted); font-size: var(--text-small); pointer-events: none; }
  .ledger-canvas :deep(.ag-cell[col-id='ledger.kind']) { padding-inline: 2px; font-size: var(--text-small); }
  .ledger-canvas.one-session :deep(.ledger-when-date) { display: none; }
  /* Studio sizes a column to its content in whole pixels (AG Studio 3.1.0), so a When value 110.4 px wide gets 110 px and drew
     as '10 Nov, 03:…'. Without the ellipsis the fraction of a pixel falls in the cell's 7 px padding and the value reads in full.
     The Kind header has the same cause: 'Kind' at 15 px is 33.2 px wide in a 33 px box and drew as 'Ki…'. Trimming its padding
     does not help, because the column is sized from the header and shrinks by the same amount.
     Remove when Studio's autosize rounds a column's width up: https://www.ag-grid.com/studio/vue/ */
  .ledger-canvas :deep(.ag-cell[col-id='ledger.at']), .ledger-canvas :deep(.ag-header-cell[col-id='ledger.kind'] .ag-header-cell-text) { text-overflow: clip; }
  .ledger-canvas :deep(.ag-studio-value-widget-content) { font-size: var(--text-heading) !important; }
  /* Collapsing the clerk with its own header leaves Studio in edit mode, squeezing the report into desktop columns, and Studio 3.1.0
     reports the collapse only as panel state that would reopen the clerk collapsed. On a phone the header does not toggle, and the
     menu's Close the clerk is the way out. Remove if Studio lets the panel close back to view mode. */
  .ledger-canvas :deep(.ag-studio-ai-panel .ag-studio-panel-header) { pointer-events: none; }
  .ledger-canvas :deep(.ag-studio-ai-panel .ag-studio-panel-chevron) { display: none; }
  .ledger-tabs button { min-height: 44px; padding: 4px 8px; font-size: var(--text-small); }
}
@media (min-width: 501px) {
  /* The clerk and Edit's panels sit on the canvas as cards, level with the widgets' top edge. Studio 3.1.0 has radius and border
     params for these panels but no margin one, and studioWrapperSpacing would also pad the phone canvas, whose height phone.ts sets.
     Only the clerk stands off the page edge. Edit's three panels leave the report so little width at 1280 px that a side margin
     on each cuts the KPI figures short. */
  .ledger-canvas :deep(.ag-studio-root-panel-container-right), .ledger-canvas :deep(.ag-studio-root-panel-container-left) { margin-block: 24px 12px; }
  .ledger.viewing .ledger-canvas :deep(.ag-studio-root-panel-container-right) { margin-right: 12px; }
  .ledger.viewing .ledger-canvas :deep(.ag-studio-widget-toolbar) { display: none !important; }
  /* AG Studio 3.1.0 needs edit mode to show the AI panel, but that also selects the last refreshed widget. Remove when the AI panel can stay open in view mode: https://www.ag-grid.com/studio/vue/ai/ */
  .ledger.viewing .ledger-canvas :deep(.ag-studio-layout-widget-overlay) { display: none !important; }
}
/* A delegated worker is internal plumbing, so an empty localised label should not leave a collapsed row. Remove when AG Studio can suppress delegation steps: https://www.ag-grid.com/studio/vue/ai/ */
.ledger-canvas :deep(.ag-studio-ai-step-row:has(.ag-studio-ai-step-text:empty)) { display: none; }
</style>
