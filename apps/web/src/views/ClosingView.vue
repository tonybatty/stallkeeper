<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { money, type PriceDrop } from '../items.js';
import { stamp } from '../time.js';
import CharityDonate from '../components/CharityDonate.vue';
type Observation = 'unknown' | 'present' | 'absent' | 'removed';
interface Donation { transactionId: string; amountPence: number; currency: string; recordedAt: string }
interface Charity { name: string; percent: number; seeded: boolean; basisPence: number; pledgePence: number; donations: Donation[] }
interface Item { id: string; name: string; code: string; seeded: boolean; observation: Observation; reason: string | null; refunded: boolean; paid?: boolean; taken?: boolean; tipPence?: number; message?: string | null }
interface Closing {
  sessionId: string; sessionStatus: string; restocked?: boolean; status: string; paymentAsOf: string; earlierClosedAt: string | null;
  recordedSalesPence: number; refundedPence: number; paidCheckouts: number; itemsSold: number; itemsTaken?: number; tipsPence?: number; tipCount?: number; items: Item[];
  groups: Array<{ key: string; label: string; items: Item[] }>; removed: Item[]; charity?: Charity | null; priceDrops?: PriceDrop[];
}
interface OrderCheck { orderId: string; codes: string; inSession: boolean; outcome: string; unresolved: boolean; note: string }
interface PayPalCheck {
  checkedAt: string; localSalesPence: number; paypalSalesPence: number | null; totalsAgree: boolean | null; totalsNote: string | null; orders: OrderCheck[];
  transactions: { status: 'ran' | 'unavailable'; note: string; listed?: number; missing?: number | null };
}
const router = useRouter();
const closing = ref<Closing | null>();
const tileCount = computed(() => 2 + [closing.value?.refundedPence, closing.value?.itemsTaken, closing.value?.tipCount].filter(Boolean).length);
const stallOpen = ref(false);
const summary = ref<string | null>(null);
const summaryPending = ref(false);
// The model writes markdown-style lists. Lines starting "- " or "* " become list items; everything else stays plain text, so no model markup is ever rendered as HTML.
const summaryBlocks = computed(() => {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const raw of (summary.value ?? '').split(/\n+/)) {
    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    const line = item ? item[1]! : raw;
    const last = blocks[blocks.length - 1];
    if (last && last.list === !!item) last.lines.push(line); else blocks.push({ list: !!item, lines: [line] });
  }
  return blocks;
});
const paypalCheck = ref<PayPalCheck | null>(null);
const checkError = ref('');
const error = ref('');
const busy = ref(false);
const acknowledged = ref(false);
// A donation is shown in its own currency, because the Donate pop-up lets the donor pick one.
const donated = (donation: Donation) => donation.currency === 'GBP' ? money(donation.amountPence) : `${(donation.amountPence / 100).toFixed(2)} ${donation.currency}`;
const inAgreement = (entry: OrderCheck) => entry.outcome === 'agrees' || (entry.outcome === 'no_capture' && !entry.unresolved);
// The check also reads earlier sessions' orders that still need attention. They are listed below when they differ, but they are not part of this session's count.
const sessionOrders = computed(() => paypalCheck.value?.orders.filter(entry => entry.inSession && !(entry.outcome === 'no_capture' && !entry.unresolved)) ?? []);
const agreeing = computed(() => sessionOrders.value.filter(inAgreement).length);
const differing = computed(() => paypalCheck.value?.orders.filter(entry => !inAgreement(entry)) ?? []);
// Differences the owner has to look at lead the report; the other groups keep the server's order.
const firstGroups = ['unpaidAbsent', 'unresolved'];
const groups = computed(() => {
  const held = (closing.value?.groups ?? []).filter(group => group.items.length);
  return [...held.filter(group => firstGroups.includes(group.key)).sort((a, b) => firstGroups.indexOf(a.key) - firstGroups.indexOf(b.key)),
    ...held.filter(group => !firstGroups.includes(group.key))];
});
const checkAgrees = computed(() => !!paypalCheck.value && paypalCheck.value.totalsAgree === true && !differing.value.length);
const sessionNote = computed(() => closing.value?.sessionStatus !== 'closing' ? 'Trading session closed.'
  : closing.value.status === 'provisional' ? 'Buyers already paying can finish within their original deadline.' : '');
// The unsold items the owner can flag as not at the stall. Nothing here is a required step.
const unsold = computed(() => closing.value?.groups.find(group => group.key === 'unsoldPresent')?.items ?? []);
// A flag moves the item into a group at the top of the report, far from where the owner tapped. So the row stays where it was, saying it is
// flagged with an Undo beside it, for the items flagged on this visit.
const flaggedHere = ref(new Set<string>());
const exceptionRows = computed(() => {
  const unsoldIds = new Set(unsold.value.map(item => item.id));
  return (closing.value?.items ?? []).filter(item => unsoldIds.has(item.id) || (flaggedHere.value.has(item.id) && item.observation === 'absent'));
});
let timer: ReturnType<typeof setInterval>;
let soon: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
async function request(body?: object) {
  if (busy.value) return;
  busy.value = true;
  try {
    const response = await fetch(body ? '/api/owner/closing/shelf-check' : '/api/owner/closing', {
      ...(body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (disposed) return;
    if (response.status === 401) { await router.replace('/owner/login'); return; }
    if (response.status === 409) { error.value = (await response.json()).error; return; }
    if (!response.ok) throw new Error(`Closing request failed: ${response.status}`);
    const data = await response.json();
    if (!disposed) {
      closing.value = data.closing; stallOpen.value = data.stallOpen === true; summary.value = data.summary ?? null; paypalCheck.value = data.paypalCheck ?? null; error.value = '';
      // The server writes the summary after the stall closes, so look again shortly while it is still being written.
      summaryPending.value = data.summaryPending === true;
      clearTimeout(soon);
      if (summaryPending.value) soon = setTimeout(() => { void request(); }, 3_000);
      if (body) acknowledged.value = false;
    }
  } catch (cause) {
    console.error('Closing request failed', cause);
    if (!disposed) error.value = body ? 'That change could not be saved. Try again.' : 'Updates paused. Refresh to check the latest report.';
  } finally { busy.value = false; }
}
// The PayPal check runs on request, never on the 30 second refresh.
async function post(path: string) {
  const response = await fetch(path, { method: 'POST', signal: AbortSignal.timeout(40_000) });
  if (response.status === 401) { await router.replace('/owner/login'); return null; }
  return response;
}
async function checkWithPayPal() {
  if (busy.value) return;
  busy.value = true; checkError.value = '';
  try {
    const response = await post('/api/owner/closing/paypal-check');
    if (!response) return;
    const data = await response.json();
    if (disposed) return;
    if (response.ok) paypalCheck.value = data.paypalCheck;
    else checkError.value = typeof data.error === 'string' ? data.error : 'The PayPal check could not run just now. The report above is unaffected.';
  } catch (cause) {
    console.error('PayPal check failed', cause);
    if (!disposed) checkError.value = 'The PayPal check could not run just now. The report above is unaffected.';
  } finally { busy.value = false; }
}
async function flag(item: Item, observation: Observation) {
  await request({ sessionId: closing.value!.sessionId, itemId: item.id, observation });
  const here = new Set(flaggedHere.value);
  if (observation === 'absent') here.add(item.id); else here.delete(item.id);
  flaggedHere.value = here;
}
onMounted(() => { void request(); timer = setInterval(() => { void request(); }, 30_000); });
onUnmounted(() => { disposed = true; clearInterval(timer); clearTimeout(soon); });
</script>

<template>
  <main class="page">
    <h1>Closing report</h1>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="closing === null && stallOpen" class="stall-open">Your stall is open, and no earlier session has anything to report. Closing it gives you the report straight away. Earlier sessions are in the <RouterLink to="/owner/ledger">Stall ledger</RouterLink>.</p>
    <p v-else-if="closing === null">Close your stall to get its closing report.</p>
    <template v-if="closing">
      <!-- One status line, so the summary and figures start near the top of a phone screen. -->
      <p role="status" class="status-line"><strong>{{ closing.status === 'provisional' ? 'Provisional report' : 'Final report' }}</strong> · Payments checked {{ stamp(closing.paymentAsOf) }}<template v-if="sessionNote">. {{ sessionNote }}</template></p>
      <p v-if="closing.earlierClosedAt" class="earlier-session">This report is for an earlier trading session, which closed on {{ stamp(closing.earlierClosedAt) }}. Your stall is open again, so the live feed shows the current session.</p>
      <p v-if="closing.restocked" class="restocked">A reset closed this session and restocked the shelf. The sales below are what was recorded before the reset.</p>
      <p v-if="closing.status === 'provisional'">A payment is unresolved. This report will update as evidence arrives.</p>
          <section class="card">
            <template v-if="summary">
              <template v-for="(block, index) in summaryBlocks" :key="index">
                <ul v-if="block.list"><li v-for="(line, lineIndex) in block.lines" :key="lineIndex">{{ line }}</li></ul>
                <p v-else v-for="(line, lineIndex) in block.lines" :key="lineIndex">{{ line }}</p>
              </template>
              <p class="note">Written by an AI model from the closing report below. The report is the record.</p>
            </template>
            <p v-else-if="summaryPending" role="status">An AI model is writing a summary of the closing report. It sees only that report.</p>
            <p v-else role="status">No summary this time. The closing report below has the figures.</p>
          </section>
          <dl class="metrics" :class="{ thirds: tileCount % 2 === 1 }">
            <div class="card total"><dt>Recorded sales</dt><dd>{{ money(closing.recordedSalesPence) }}</dd><dd class="meaning">Paid in PayPal, less refunds.</dd></div>
            <div v-if="closing.refundedPence" class="card"><dt>Refunded</dt><dd>{{ money(closing.refundedPence) }}</dd></div>
            <div class="card"><dt>Paid checkouts</dt><dd>{{ closing.paidCheckouts }}</dd></div>
            <div class="card"><dt>Items sold</dt><dd>{{ closing.itemsSold }}</dd></div>
            <div v-if="closing.itemsTaken" class="card"><dt>Taken free</dt><dd>{{ closing.itemsTaken }}</dd><dd class="meaning">No payment. £0 recorded.</dd></div>
            <div v-if="closing.tipCount" class="card"><dt>Tips received</dt><dd>{{ money(closing.tipsPence ?? 0) }}</dd><dd class="meaning">Counted in recorded sales.</dd></div>
            </dl>
          <!-- Unsold items are the long, quiet list, so they sit folded with their count and the differences stay in view. -->
          <component :is="group.key === 'unsoldPresent' ? 'details' : 'section'" v-for="group in groups" :key="group.key" :class="{ card: group.key !== 'unsoldPresent', 'unsold-group disclosure': group.key === 'unsoldPresent' }">
            <summary v-if="group.key === 'unsoldPresent'">{{ group.label }} ({{ group.items.length }})</summary>
            <h3 v-else>{{ group.label }}</h3>
            <ul><li v-for="item in group.items" :key="item.id">{{ item.name }} · {{ item.code }}<template v-if="item.refunded"> · Refunded</template><template v-if="item.tipPence"> · Tip {{ money(item.tipPence) }}</template>
              <button v-if="item.observation === 'absent' && (group.key === 'unpaidAbsent' || group.key === 'freeAbsent')" class="link-button" :disabled="busy" :aria-label="`Back at the stall: ${item.code}`" @click="flag(item, 'unknown')">Back at the stall</button>
              <!-- A buyer wrote this, so it is shown as text and nothing else. -->
              <span v-if="item.message" class="thanks"><br>Message from the buyer: {{ item.message }}</span></li></ul>
          </component>
          <!-- Optional: the report already counts every unsold item as still at the stall, so this only records an exception. -->
          <details v-if="exceptionRows.length && !closing.restocked" class="exception disclosure">
            <summary>Something missing?</summary>
            <p class="meta">Everything unsold counts as still at the stall. Flag an item that is not.</p>
            <div v-for="item in exceptionRows" :key="item.id" class="exception-row">
              <template v-if="item.observation === 'absent'">
                <span class="name" role="status"><b>{{ item.name }} flagged</b></span>
                <button class="text-button" :disabled="busy" :aria-label="`Undo flag: ${item.code}`" @click="flag(item, 'unknown')">Undo</button>
              </template>
              <template v-else>
                <span class="name"><b>{{ item.name }} · {{ item.code }}</b></span>
                <button class="btn sec" :disabled="busy" :aria-label="`Not at the stall: ${item.code}`" @click="flag(item, 'absent')">Not at the stall</button>
              </template>
            </div>
          </details>
          <section v-if="closing.removed.length" class="card"><h3>Recorded as removed</h3><ul><li v-for="item in closing.removed" :key="item.id">{{ item.name }} · {{ item.code }}: {{ item.reason }}</li></ul></section>
          <section v-if="closing.priceDrops?.length" class="card" data-test="price-drops"><h3>Price drops</h3><ul><li v-for="drop in closing.priceDrops" :key="drop.id">{{ drop.name }} · {{ drop.code }}: {{ money(drop.oldPence) }} to {{ money(drop.newPence) }}. {{ drop.reason }}</li></ul></section>
          <template v-if="closing.charity">
            <h2>Charity pledge</h2>
            <section class="card" data-test="charity">
              <p>This stall pledges {{ closing.charity.percent }}% of recorded sales to {{ closing.charity.name }}.</p>
              <p><strong>Pledged: {{ money(closing.charity.pledgePence) }}</strong></p>
              <p class="note">Basis: {{ closing.charity.percent }}% of {{ money(closing.charity.basisPence) }} recorded sales, paid in PayPal less refunds, this trading session, rounded down to the penny.<template v-if="closing.status === 'provisional'"> The report is provisional, so this figure can still change.</template></p>
              <CharityDonate v-if="closing.charity.pledgePence > 0" :key="`${closing.sessionId}:${closing.charity.name}:${closing.charity.pledgePence}`" :session-id="closing.sessionId" :charity-name="closing.charity.name" :pledge-pence="closing.charity.pledgePence" @recorded="request()" />
              <p v-else-if="closing.charity.basisPence === 0">Nothing is pledged yet, because there are no recorded sales.</p>
              <p v-else>Nothing is pledged, because the pledge rounds down to less than a penny.</p>
              <template v-if="closing.charity.donations.length">
                <h3>Donations reported by the Donate button</h3>
                <ul><li v-for="donation in closing.charity.donations" :key="donation.transactionId">{{ donated(donation) }} · transaction {{ donation.transactionId }} · {{ stamp(donation.recordedAt) }}</li></ul>
                <p class="note">Donations are kept apart from sales and change no sales figure. This report records what the Donate button reported and cannot check it against PayPal.</p>
              </template>
            </section>
          </template>
          <p class="meta">A payment record can't prove an item left the stall.</p>
          <section v-if="paypalCheck || checkError" class="card" aria-label="PayPal cross-check">
            <p v-if="checkError" role="status">{{ checkError }}</p>
            <template v-if="paypalCheck">
              <p>Checked {{ stamp(paypalCheck.checkedAt) }}.
                <template v-if="paypalCheck.totalsAgree === null">{{ paypalCheck.totalsNote }}</template>
                <template v-else-if="paypalCheck.totalsAgree">PayPal's total for this session matches the recorded {{ money(paypalCheck.localSalesPence) }}.</template>
                <template v-else>PayPal shows {{ money(paypalCheck.paypalSalesPence ?? 0) }} for this session and the record shows {{ money(paypalCheck.localSalesPence) }}.</template>
                <template v-if="paypalCheck.localSalesPence !== closing.recordedSalesPence"> Recorded sales have changed since, so check again.</template>
              </p>
              <ul v-if="differing.length">
                <li v-for="order in differing" :key="order.orderId">{{ order.codes || order.orderId }}<template v-if="!order.inSession"> (earlier session)</template>: {{ order.note }}</li>
              </ul>
              <p v-if="agreeing">{{ agreeing }} of {{ sessionOrders.length }} orders from this session agree with the record.</p>
              <!-- When every order agrees and the totals match, a transaction list PayPal could not send changes nothing, so its note stays out of the way. -->
              <p v-if="paypalCheck.transactions.status === 'ran' || !checkAgrees">{{ paypalCheck.transactions.note }}<template v-if="paypalCheck.transactions.status === 'ran'"> PayPal listed {{ paypalCheck.transactions.listed }} transactions<template v-if="paypalCheck.transactions.missing !== null && paypalCheck.transactions.missing !== undefined">, with {{ paypalCheck.transactions.missing }} recorded captures not listed yet</template>.</template></p>
            </template>
          </section>
          <p v-if="closing.itemsTaken" class="meta">Free takes have no PayPal order, so the PayPal check has nothing to read for them.</p>
          <button class="btn sec" :disabled="busy" @click="checkWithPayPal()">{{ paypalCheck ? 'Check again' : 'Check with PayPal' }}</button>
          <button class="btn" @click="acknowledged = true">Acknowledge check</button>
          <p v-if="acknowledged" role="status">Check acknowledged on this page.</p>
    </template>
    <button class="btn sec" :disabled="busy" @click="request()">Refresh report</button>
  </main>
</template>
<style scoped>
.note { font-size: var(--text-small); }
.status-line { color: var(--muted); font-size: var(--text-small); }
.status-line strong { color: var(--ink); }
.thanks { overflow-wrap: anywhere; }
.metrics { display: flex; flex-wrap: wrap; gap: 12px; }
.metrics .card { flex: 1 1 34%; min-width: 0; gap: 6px; margin: 0; padding: 12px; }
.metrics.thirds .card { flex-basis: 26%; }
.metrics.thirds .card:not(.total) { padding-inline: 10px; }
.metrics.thirds .card:not(.total) dd:not(.meaning) { font-size: var(--text-body); }
.metrics .card.total { flex-basis: 100%; }
.metrics dt, .metrics dd.meaning { font-size: var(--text-small); }
/* Figures use the display face, as on the overview tiles and the live feed. */
dd { margin: 0; font-family: var(--font-display); font-size: var(--text-heading); font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.total dd { font-size: var(--text-title); }
.metrics dd.meaning { margin: 0; font-family: var(--font-body); font-weight: 400; white-space: normal; }
.exception-row { display: flex; align-items: center; gap: 10px; padding-top: 8px; }
/* The global .btn is width: 100%, which would squeeze the name column to nothing on a phone. */
.exception-row .btn { width: auto; flex: none; }
.name { flex: 1; min-width: 0; }
.name b { display: block; font-size: var(--text-body); font-weight: 600; overflow-wrap: anywhere; }
.name span, .meta { font-size: var(--text-small); color: var(--muted); }
.link-button { align-self: center; background: none; border: 0; padding: 0; min-height: 44px; color: var(--muted); font: inherit; font-size: var(--text-small); text-decoration: underline; cursor: pointer; }
li .link-button { margin-left: .5rem; }
h3 { overflow-wrap: anywhere; }
/* A list inside a card takes the card's own gap, so the card has the same padding above and below it. */
.card ul { margin: 0; padding-left: 1.25rem; }
</style>
