// Hand-run check of the closing summary against the real model. CI never runs this: it spends tokens and the output varies.
// It uses the shipped prompt and figure check (`draftSummary`) on three fixed reports and records which rule refused a reply.
//
//   ANTHROPIC_API_KEY=... pnpm --filter @stallkeeper/api exec tsx test/summary-run.ts --runs 5 --out <dir>
//
// Token counts are summed here with the same price as the `ai_usage` table. No database is involved.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAnthropic } from '@ai-sdk/anthropic';
import { draftSummary, summaryInput } from '../src/closing-summary.js';
import type { ClosingReport } from '../src/closing.js';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '5' }, out: { type: 'string' }, reports: { type: 'string', default: 'A,B,C' } } });
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY.');

type Row = [name: string, code: string];
interface Spec {
  status: 'provisional' | 'final'; stall: string; sales: number; refunded: number; checkouts: number; sold: number;
  paidAbsent?: Row[]; unsoldPresent?: Row[]; unpaidAbsent?: Row[]; unresolved?: Row[];
  removed?: [name: string, code: string, reason: string][]; refundedCodes?: string[];
}
const labels = {
  paidAbsent: 'Sold, gone with the buyer', unsoldPresent: 'Unsold, still at the stall',
  unpaidAbsent: 'Not on the shelf, no confirmed payment. This record cannot say what happened.', unresolved: 'Payment unresolved',
} as const;

// Shaped like what the closing route builds. Names mirror a car-boot stall; none is a real sale.
function report(spec: Spec): ClosingReport {
  const item = (key: keyof typeof labels, [name, code]: Row) => ({ id: code, name, code, seeded: false, observation: 'present' as const, reason: null, paid: key.startsWith('paid'), refunded: !!spec.refundedCodes?.includes(code), unresolved: key === 'unresolved' });
  const groups = (Object.keys(labels) as (keyof typeof labels)[]).map(key => ({ key, label: labels[key], items: (spec[key] ?? []).map(row => item(key, row)) }));
  const removed = (spec.removed ?? []).map(([name, code, reason]) => ({ ...item('unsoldPresent', [name, code]), observation: 'removed' as const, reason }));
  const items = [...groups.flatMap(group => group.items), ...removed];
  return { id: 'run', sessionId: 'run', sessionStatus: spec.stall, cutoffAt: null, status: spec.status, paymentAsOf: new Date('2026-11-07T16:00:00Z'),
    recordedSalesPence: spec.sales, refundedPence: spec.refunded, paidCheckouts: spec.checkouts, itemsSold: spec.sold, items, groups, removed } as unknown as ClosingReport;
}

const reports: Record<string, ClosingReport> = {
  A: report({
    status: 'final', stall: 'closed', sales: 8600, refunded: 0, checkouts: 4, sold: 5,
    paidAbsent: [['Blue ceramic mug', 'M3K8'], ['Brass desk lamp', 'L4P2'], ['Round wall mirror', 'R7W1'], ['Vintage cookbook set', 'C9D4'], ['Wicker basket', 'W2B6']],
    unsoldPresent: [['Copper kettle', 'K5T3'], ['Tin of buttons', 'B8N1'], ['Garden trowel', 'G1H7']], unpaidAbsent: [['Enamel jug', 'E6J2']],
    removed: [['Spare door key', 'S4D5', 'Taken back indoors']],
  }),
  B: report({
    status: 'provisional', stall: 'closing', sales: 4150, refunded: 1200, checkouts: 3, sold: 3, refundedCodes: ['O1S9'],
    paidAbsent: [['Oak stool 45 cm', 'O1S9'], ['Record player, 1970s', 'R1P7'], ['Set of 6 teacups', 'T6C2']],
    unsoldPresent: [['Pine bookshelf', 'P2B4'], ['Brass candlesticks', 'B3C5'], ['Knitting patterns', 'K9P1'], ['Glass vase', 'G4V8'], ['Picture frame 20x25', 'F2R6'], ['Toast rack', 'T8R3']],
    unresolved: [['Garden gnome', 'G7N2']],
    removed: [['Old radio', 'O5R9', 'Sold for £10 cash'], ['Jam jars, box of 12', 'J1M4', 'Gave to a neighbour']],
  }),
  // The shape the hosted demo stall produced: twelve items, one sale, one unsold item not seen. Set names carry counts the model tends to repeat in its own words.
  C: report({
    status: 'final', stall: 'closed', sales: 2400, refunded: 0, checkouts: 1, sold: 1,
    paidAbsent: [['Brass desk lamp', 'L4P2']],
    unsoldPresent: [['Round wall mirror', 'R7W1'], ['Film camera', 'F3C9'], ['Paperbacks, set of four', 'P4B2'], ['Terracotta plant pot', 'T5P8'], ['Vinyl records, set of six', 'V6R1'], ['Wooden stool', 'W2S7'], ['Blue ceramic vase', 'B1V4'], ['Woven basket', 'W9B3'], ['Wall clock', 'C8K6'], ['Watering can', 'W3C5']],
    unpaidAbsent: [['Ceramic mugs, pair', 'M2G9']],
  }),
};

const runs = Number(values.runs);
const model = createAnthropic({ apiKey })('claude-sonnet-5-5');
const results: object[] = [];
let inputTokens = 0, outputTokens = 0;
for (const name of values.reports!.split(',')) {
  const value = reports[name]!;
  const input = summaryInput(value);
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const draft = await draftSummary(model, input).catch((error: unknown) => ({ failure: error instanceof Error ? error.name : 'Unknown' }));
    if ('failure' in draft) { console.log(`${name}${run}: model call failed: ${draft.failure}`); results.push({ report: name, run, failure: draft.failure }); continue; }
    inputTokens += draft.usage.inputTokens ?? 0; outputTokens += draft.usage.outputTokens ?? 0;
    const verdict = 'text' in draft ? 'shown' : `refused: ${draft.refusal}`;
    console.log(`${name}${run}: ${verdict} (finish ${draft.finishReason}, ${draft.usage.inputTokens}/${draft.usage.outputTokens} tokens, ${Date.now() - started} ms)`);
    results.push({ report: name, run, verdict, finishReason: draft.finishReason, usage: draft.usage, text: 'text' in draft ? draft.text : undefined });
  }
}
const cost = (inputTokens * 2 + outputTokens * 10) / 1_000_000;
console.log(`tokens in ${inputTokens}, out ${outputTokens}, about $${cost.toFixed(4)}`);
if (values.out) { mkdirSync(values.out, { recursive: true }); writeFileSync(join(values.out, `summary-run-${Date.now()}.json`), JSON.stringify({ runs, inputTokens, outputTokens, cost, results }, null, 2)); }
