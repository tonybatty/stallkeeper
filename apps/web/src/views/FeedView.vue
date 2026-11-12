<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { stamp } from '../time.js';
import { money, type PriceDrop } from '../items.js';
interface Snapshot {
  stallName: string;
  session: { id: string; status: string } | null;
  recordedSalesPence: number; itemsSold: number; itemsTaken: number; unsoldRecords: number; earlierLedger?: boolean; updatedAt: string;
  takes: Array<{ id: string; name: string; code: string; message: string | null; time: string; seeded: boolean }>;
  sales: Array<{ id: string; kind: 'sale' | 'tip'; name: string; code: string; amountPence: number; time: string; webhookVerifiedAt: string | null; refundedPence: number; seeded: boolean;
    price: { source: 'offer' | 'pwyw' | 'listed'; askingPence: number | null; offeredPence: number | null; droppedFromPence: number | null } | null }>;
  flaggedPayments: Array<{ checkoutId: string; name: string; code: string; totalPence: number; reason: string; seeded: boolean }>;
  minorActivity: Array<{ id: string; itemName: string; code: string; offeredPence: number; counterPence?: number | null; reason: string; at: string; becameSalePence?: number | null }>;
  buyerQuestions: Array<{ itemId: string; name: string; code: string; seeded: boolean; questions: Array<{ id: string; text: string; at: string }> }>;
  priceDrops?: PriceDrop[]; priceReview?: { outcome: string; at: string } | null;
}
type Price = NonNullable<Snapshot['sales'][number]['price']>;
// The same recorded facts the stall ledger grid shows, in a sentence. A tip has no price line.
function priceLine(price: Price, amountPence: number) {
  const dropped = price.droppedFromPence === null ? '' : ` after a price drop from ${money(price.droppedFromPence)}`;
  // Only a pay-what-you-want sale can lack a figure: the owner's expected amount is optional.
  if (price.askingPence === null) return `Buyer chose ${money(amountPence)}`;
  if (price.source === 'offer') return `Asking ${money(price.askingPence)} · offered ${money(price.offeredPence ?? amountPence)} · agreed ${money(amountPence)}${dropped}`;
  if (price.source === 'pwyw') return `Expected ${money(price.askingPence)} · buyer chose ${money(amountPence)}`;
  return `Listed price${dropped}`;
}
interface Row { id: string; time: string; title: string; detail: string; amount?: string; pill?: { text: string; tone: 'ok' | 'mute' }; message?: string | null; priceLine?: string; verified?: boolean | null; refund?: string; serverCheck?: string }
const rows = computed<Row[]>(() => {
  const data = snapshot.value;
  if (!data) return [];
  const sales = data.sales.map(sale => ({ id: `sale-${sale.id}`, time: sale.time, title: sale.name, detail: sale.kind === 'tip' ? `Tag ${sale.code} · Tip, money received for a free item` : `Tag ${sale.code}`, amount: money(sale.amountPence),
    pill: { text: sale.refundedPence ? 'Refunded' : 'Paid', tone: sale.refundedPence ? 'mute' : 'ok' }, priceLine: sale.price ? priceLine(sale.price, sale.amountPence) : undefined, verified: !!sale.webhookVerifiedAt,
    refund: sale.refundedPence ? `Refunded ${money(sale.refundedPence)}.${sale.kind !== 'tip' ? ' Collection withdrawn. Item remains sold.' : ''}` : undefined } satisfies Row));
  const takes = data.takes.map(take => ({ id: `take-${take.id}`, time: take.time, title: take.name, detail: `Tag ${take.code}`, pill: { text: 'Taken free', tone: 'mute' }, message: take.message } satisfies Row));
  const refused = (data.minorActivity ?? []).map(entry => ({ id: `offer-${entry.id}`, time: entry.at, title: entry.counterPence != null ? `Offer ${money(entry.offeredPence)}, countered at ${money(entry.counterPence)}` : `Offer refused, ${money(entry.offeredPence)}`,
    detail: `${entry.itemName} · ${entry.code}${entry.reason === 'above_asking' ? ' · Above asking price, review' : ''}${entry.becameSalePence != null ? ` · became a sale at ${money(entry.becameSalePence)}` : ''}`,
    // Only a counter carries an amount the server worked out; a plain refusal set no price, so it gets no line.
    serverCheck: entry.counterPence != null ? 'Server set the counter-offer, inside your limits.' : undefined } satisfies Row));
  return [...sales, ...takes, ...refused].sort((a, b) => b.time.localeCompare(a.time));
});
const questionCount = computed(() => snapshot.value?.buyerQuestions.reduce((sum, group) => sum + group.questions.length, 0) ?? 0);
const router = useRouter();
const snapshot = ref<Snapshot>();
// A sale or take that lands while the feed is open flashes once, and the total counts up to its new figure, so the stallholder's phone
// visibly reacts. Rows already there on the first load do not flash. Under reduced motion the total jumps and the new row keeps a still tint.
const allowsMotion = () => window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches === true;
const seen = new Set<string>();
const fresh = ref(new Set<string>());
let primed = false;
watch(rows, list => {
  if (!snapshot.value) return;
  const arrived = list.map(row => row.id).filter(id => !seen.has(id));
  arrived.forEach(id => seen.add(id));
  const landed = arrived.filter(id => id.startsWith('sale-') || id.startsWith('take-'));
  if (primed && landed.length) fresh.value = new Set(landed);
  primed = true;
});
const shownTotal = ref(0);
let tickFrame = 0;
watch(() => snapshot.value?.recordedSalesPence, (to, from) => {
  if (tickFrame) cancelAnimationFrame(tickFrame);
  if (to === undefined) return;
  if (from === undefined || from === to || !allowsMotion()) { shownTotal.value = to; return; }
  const start = performance.now();
  const step = (time: number) => {
    const progress = Math.min(1, (time - start) / 600);
    shownTotal.value = Math.round(from + (to - from) * (1 - (1 - progress) ** 3));
    if (progress < 1) tickFrame = requestAnimationFrame(step);
  };
  tickFrame = requestAnimationFrame(step);
});
const paused = ref(true);
// Only a first load that failed. A page still loading is not paused, and a later failure keeps the last snapshot on screen.
const loadFailed = ref(false);
const connected = computed(() => !!snapshot.value || loadFailed.value);
const silenceLimitMs = 40_000;
const retryDelayMs = 5_000;
const checking = ref(new Set<string>());
const checkMessage = ref('');
const closing = ref(false);
const closeError = ref('');
async function closeStall() {
  if (closing.value) return;
  closing.value = true; closeError.value = '';
  try {
    const response = await fetch('/api/owner/stall/close', { method: 'POST' });
    if (!response.ok) throw new Error(`Close failed: ${response.status}`);
    await router.push('/owner/closing');
  } catch (error) { console.error('Close failed', error); closeError.value = 'The stall could not close. Refresh and try again.'; }
  finally { closing.value = false; }
}
let stream: EventSource | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let revision = 0;
function stop() { clearTimeout(reconnect); stream?.close(); }
function reconnectIn(delayMs: number) {
  clearTimeout(reconnect);
  reconnect = setTimeout(() => { revision++; paused.value = true; stop(); connect(); }, delayMs);
}
async function refresh() {
  const requestRevision = ++revision;
  try {
    const response = await fetch('/api/owner/feed', { signal: AbortSignal.timeout(15_000) });
    if (disposed) return;
    if (response.status === 401) { stop(); await router.replace('/owner/login'); return; }
    if (!response.ok) throw new Error(`Feed failed: ${response.status}`);
    const data: Snapshot = await response.json();
    if (!disposed && requestRevision === revision) { snapshot.value = data; loadFailed.value = false; paused.value = stream?.readyState !== EventSource.OPEN; }
  } catch (error) {
    console.error('Feed refresh failed', error);
    if (!disposed && requestRevision === revision) paused.value = true;
    // Outside the revision check: a dropped stream bumps the revision without fetching, and a first load must still report its failure.
    if (!disposed && !snapshot.value) loadFailed.value = true;
  }
}
async function recheck(id: string) {
  if (checking.value.has(id)) return;
  checking.value.add(id);
  checkMessage.value = '';
  try {
    const response = await fetch(`/api/owner/checkouts/${id}/recheck`, { method: 'POST', signal: AbortSignal.timeout(45_000) });
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (!response.ok) throw new Error(`Payment check failed: ${response.status}`);
    await refresh();
    checkMessage.value = 'Payment check finished. Any unresolved payments remain listed below.';
  } catch (error) {
    console.error('Payment recheck failed', error);
    checkMessage.value = 'Unable to check payment. Please try again shortly.';
  } finally { checking.value.delete(id); }
}
function connect() {
  stream = new EventSource('/api/owner/feed/stream');
  reconnectIn(silenceLimitMs);
  // Every open includes reconnects; the snapshot repairs updates missed while disconnected.
  stream.onopen = () => { reconnectIn(silenceLimitMs); void refresh(); };
  stream.addEventListener('update', () => { reconnectIn(silenceLimitMs); void refresh(); });
  stream.addEventListener('heartbeat', () => { reconnectIn(silenceLimitMs); if (paused.value) void refresh(); });
  stream.onerror = () => {
    revision++; paused.value = true;
    // Browsers retry dropped connections themselves but give up for good on a non-200 reply.
    if (stream?.readyState === EventSource.CLOSED) { reconnectIn(retryDelayMs); void refresh(); }
  };
}
onMounted(() => { connect(); void refresh(); });
onUnmounted(() => { disposed = true; stop(); if (tickFrame) cancelAnimationFrame(tickFrame); });
</script>
<template>
  <main class="page tight">
    <div class="top"><h1>Live feed</h1><span role="status" class="live" :class="{ paused: connected && paused, waiting: !connected }" :title="snapshot ? `Last updated ${stamp(snapshot.updatedAt)}` : undefined">{{ !connected ? 'Loading…' : paused ? 'Updates paused' : 'Live updates' }}</span></div>
    <template v-if="loadFailed"><p role="alert">The live feed could not load. It will try again by itself.</p><button type="button" class="btn sec" @click="refresh">Try again</button></template>
    <p v-if="closeError" role="alert">{{ closeError }}</p>
    <template v-if="snapshot">
      <section v-if="snapshot.flaggedPayments?.length" aria-label="Payments needing review">
        <h2>Payments needing review</h2>
        <p>Unresolved payments across all trading sessions.</p>
        <article v-for="payment in snapshot.flaggedPayments" :key="payment.checkoutId" class="card">
          <div class="row"><h3>{{ payment.name }} · {{ payment.code }}</h3><strong>{{ money(payment.totalPence) }}</strong></div>
          <p>{{ payment.reason }}</p>
          <button class="btn sec" :disabled="checking.has(payment.checkoutId)" @click="recheck(payment.checkoutId)">{{ checking.has(payment.checkoutId) ? 'Checking payment…' : 'Check payment again' }}</button>
        </article>
      </section>
      <p v-if="checkMessage" role="status">{{ checkMessage }}</p>
      <div class="takings">
        <span>Recorded sales, this trading session</span><b>{{ money(shownTotal) }}</b>
        <span>{{ snapshot.itemsSold }} sold · {{ snapshot.itemsTaken }} taken free · {{ snapshot.unsoldRecords }} for sale</span>
      </div>
      <p v-if="!snapshot.session">No trading session yet. Open your stall to start.</p>
      <p v-else-if="!rows.length" class="card">Nothing sold or taken yet. Confirmed sales, tips and free takes will appear here.<template v-if="snapshot.earlierLedger"><br /><RouterLink to="/owner/ledger" data-test="earlier-ledger">Earlier sessions are in the stall ledger.</RouterLink></template></p>
      <ol v-else class="feed-list" aria-label="This session">
        <li v-for="row in rows" :key="row.id" :class="{ fresh: fresh.has(row.id) }">
          <div class="what">
            <b>{{ row.title }}</b>
            <span class="meta"><time :datetime="row.time">{{ stamp(row.time) }}</time> · {{ row.detail }}</span>
            <span v-if="row.priceLine" class="meta" data-test="price-line">{{ row.priceLine }}</span>
            <span v-if="row.verified !== undefined" class="meta" :class="{ verified: row.verified }">{{ row.verified ? 'Confirmed by PayPal' : 'Waiting for PayPal to confirm' }}</span>
            <span v-if="row.refund" class="meta">{{ row.refund }}</span>
            <span v-if="row.serverCheck" class="meta" data-test="server-check">{{ row.serverCheck }}</span>
            <!-- A buyer wrote this, so it is shown as text and nothing else. -->
            <span v-if="row.message" class="meta thanks">Message from the buyer: {{ row.message }}</span>
          </div>
          <div class="side"><strong v-if="row.amount">{{ row.amount }}</strong><span v-if="row.pill" class="pill-status" :class="row.pill.tone">{{ row.pill.text }}</span></div>
        </li>
      </ol>
      <section v-if="snapshot.priceDrops?.length" aria-label="Price drops">
        <h2>Price drops</h2>
        <article v-for="drop in snapshot.priceDrops" :key="drop.id" class="card">
          <time :datetime="drop.at">{{ stamp(drop.at) }}</time>
          <div class="row"><h3>{{ drop.name }} · {{ drop.code }}</h3><strong>{{ money(drop.oldPence) }} to {{ money(drop.newPence) }}</strong></div>
          <p>{{ drop.reason }}</p>
          <!-- Every drop comes from the price review: the AI proposes a price and the server applies it only after checking it against the item's limits. -->
          <p class="meta" data-test="server-check">AI suggested it. Server checked it against your limits.</p>
        </article>
      </section>
      <p v-if="snapshot.priceReview && ['unavailable', 'over_budget'].includes(snapshot.priceReview.outcome)" class="card" data-test="review-skipped"><time :datetime="snapshot.priceReview.at">{{ stamp(snapshot.priceReview.at) }}</time> The price review did not run{{ snapshot.priceReview.outcome === 'over_budget' ? ', because today\'s AI budget is used up' : ', because the AI was unavailable' }}. No prices changed.</p>
      <details v-if="questionCount" class="questions disclosure" aria-label="Questions buyers asked">
        <summary>{{ questionCount }} {{ questionCount === 1 ? 'question' : 'questions' }} buyers asked</summary>
        <article v-for="group in snapshot.buyerQuestions" :key="group.itemId">
          <h3>{{ group.name }} · {{ group.code }}</h3>
          <p v-for="question in group.questions" :key="question.id"><time :datetime="question.at">{{ stamp(question.at) }}</time> {{ question.text }}</p>
          <!-- The feed leaves out removed items, so every group here has an item that can still be edited. -->
          <RouterLink :to="{ path: `/owner/items/${group.itemId}`, query: { focus: 'notes' } }">Add to notes</RouterLink>
        </article>
      </details>
    </template>
    <nav class="tabs" aria-label="Closing"><RouterLink to="/owner/closing">Closing report</RouterLink>
      <button v-if="snapshot?.session?.status === 'open'" type="button" :disabled="closing" @click="closeStall">Close stall</button></nav>
  </main>
</template>
<style scoped>
.tight { gap: 12px; padding-top: 8px; padding-bottom: 8px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.live { font-size: var(--text-small); font-weight: 600; color: var(--ok); }
.paused { color: var(--flag); }
.waiting { color: var(--muted); }
.takings { display: flex; flex-direction: column; gap: 2px; padding: 16px; border-radius: var(--radius); background: var(--ink); color: var(--card); }
.takings b { font-family: var(--font-display); font-size: var(--text-figure); line-height: 1.1; font-variant-numeric: tabular-nums; }
.takings span { font-size: var(--text-small); color: #cfccc3; }
.feed-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border-radius: var(--radius); background: var(--panel); overflow: hidden; }
.feed-list li { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px; min-height: 56px; }
.feed-list li + li { border-top: 1px solid var(--rule); }
.what { display: flex; flex-direction: column; min-width: 0; }
.meta { font-size: var(--text-small); color: var(--muted); }
.side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; font-variant-numeric: tabular-nums; }
.fresh { background: var(--flag-bg); }
@media (prefers-reduced-motion: no-preference) { .fresh { animation: landed 1.6s ease-out both; } }
@keyframes landed { from { background: var(--chip); } to { background: transparent; } }
.pill-status { padding: 2px 10px; border-radius: 999px; font-size: var(--text-small); font-weight: 700; }
.pill-status.ok { background: var(--ok-bg); color: var(--ok); }
.pill-status.mute { background: var(--art-bg); color: var(--muted); }
.verified { color: var(--ok); font-weight: 700; }
.thanks { overflow-wrap: anywhere; }
.questions article { display: flex; flex-direction: column; gap: 4px; padding-block: 8px; font-size: var(--text-small); }
.questions p { margin: 0; }
.tabs { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; margin-top: auto; padding-top: 8px; border-top: 1px solid var(--rule); }
.tabs button { min-height: 44px; padding: 0 12px; border: 0; border-radius: var(--chip-radius); background: var(--sec-bg); color: var(--ink); font-weight: 600; cursor: pointer; }
.tabs button:disabled { color: var(--muted); cursor: default; }
time { color: var(--muted); }
</style>
