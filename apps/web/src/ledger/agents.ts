import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgAiTool, type AgAiToolContext, type AgLlmAdapter, type AgStudioApi } from 'ag-studio';
import { readableHandBack, readableNotes } from './claudeAdapter.js';
import { needsPaypal, type LedgerData, type LedgerRow } from './sources.js';

export const clerkPanelNote = 'Part of Stallkeeper. Answers from your stall records. The closing report stays the record.';
export const clerkLimitNote = 'The Stall clerk is not available. It has a daily AI limit and may be used up for the day. The report still works.';

const starters: AgAiPromptStarter[] = [
  { label: 'Waiting on PayPal?', prompt: 'Is anything still waiting on PayPal? Add a widget for it.' },
  { label: 'Net sales by session', prompt: 'What are the recorded sales for each session?' },
  { label: 'Run the PayPal check', prompt: 'Run the PayPal check and tell me what it says.' },
];

const clerkInstructions = `You are Stallkeeper's Stall clerk, who keeps one small stall's records.
Answer from read_unresolved_payments, run_paypal_check, view_schema and execute_query only. Say which of these an answer came from.
Recorded sales are ledger.recordedSales. Never sum ledger.amount for sales, because it holds donations and payments to check.
run_paypal_check reads from PayPal each captured order that has no PayPal read yet, from every session, and changes nothing. Repeat its note, which says how many it read and how many agree.
It does not read PayPal's transaction list. read_unresolved_payments gives that line from the latest closing check, with that check's own time in closingCheckAt. Give that date with the line, never latestReadAt, and do not present an old line as current. Say what you did not confirm.
You hold no tool that changes a price, stock or a payment. If asked, say so.
Keep the wording neutral. The record cannot say why a payment is unresolved or what happened to an item, so do not guess.
Write for the stallholder in plain sentences. Name a session by its Session label, never by an id, and never show an id, a table name or a field name.
When another agent asked you, finish by calling complete_task with your whole answer as the summary. Text alone does not reach anyone.`;

// The report is laid out by hand, and a new card must not rearrange it.
const keepLayout = `Leave the widgets already on the page where they are, unless the stallholder asks to move them. Put a new widget in free space at the bottom of the page.
For a Waiting on PayPal count card across all sessions, use a value widget with paymentSummary.unresolved aggregated by sum, with no status filter. This source always has a numeric count, including zero. Label it "Waiting on PayPal, all sessions".
Finish by calling complete_task with a short summary. Text alone does not reach anyone.`;

// A delegate that ends without complete_task hands back nothing, and the lead then asks again, so the owner would see a placeholder
// and the same step twice. Every delegate is told to finish with it.
const handBack = 'Finish by calling complete_task with your whole answer as the summary. Text alone does not reach anyone.';

const leadInstructions = `For questions about payments, PayPal, sales, sessions or anything else the records say, delegate to the Stall clerk, never to the Data agent, and only once per question. Pass on the clerk's answer in plain sentences.
Name a session by its Session label, never by an id, and never show an id, a table name or a field name.
For a request that combines a records question with a page change, delegate to the Stall clerk first. Wait for its answer, then pass that answer to the Page or Widget agent that will make the change. Do not configure the widget yourself.
Tell the Page or Widget agent to leave every existing widget at its current position and put a new widget in free space at the bottom.`;

export const unresolved = (rows: LedgerRow[]) => rows.filter(needsPaypal)
  .map(({ kind, at, item, code, amount, status, capture, webhook, paypalCheck }) => ({ kind, at, item, code, amount, status, capture, webhook, paypalCheck }));
// The latest PayPal read of any kind can be minutes old while the transaction list line is days old, so each time goes in under a name that says which it is.
export function unresolvedPayments(data: LedgerData) {
  const rows = unresolved(data.ledger);
  const { checkedAt, transactionList: { ran, note, checkedAt: closingCheckAt } } = data.paypalCheck;
  return { count: rows.length, rows, paypalCheck: { latestReadAt: checkedAt, transactionList: { ran, note, closingCheckAt } } };
}

interface LedgerCheck { sent: number; read: number; agree: number; differ: number; notRead: number; left: number; note: string; orders: { codes: string; outcome: string; note: string }[] }
export async function paypalCheck(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/owner/ledger/paypal-check', { method: 'POST' }).catch(() => null);
  if (!response?.ok) return { ran: false, note: 'The PayPal check could not run just now. The ledger is unaffected.' };
  const { paypalCheck: check } = await response.json() as { paypalCheck: LedgerCheck };
  // The server already leaves order ids out, and this picks fields by name, so a new one never reaches the model by accident.
  return { ran: true, note: check.note, sent: check.sent, read: check.read, agree: check.agree, differ: check.differ, notRead: check.notRead, left: check.left,
    orders: check.orders.map(({ codes, outcome, note }) => ({ codes, outcome, note })) };
}

// Studio's lead delegates to a fixed list, so ours is the built-in lead with the clerk added to that list.
export function ledgerAi(adapter: AgLlmAdapter, data: () => LedgerData, onChecked: () => void): AgAiHarnessSetup {
  return params => {
    // The harness hands over the headless API type, though in a browser it is the full one, which alone can define tools.
    const api = params.api as unknown as AgStudioApi;
    return createAiHarness(api, ({ builtIn, tools }) => {
    const readUnresolved: AgAiTool = api.defineAiTool({
      name: 'read_unresolved_payments', description: 'List payments that still need PayPal or the stallholder: flagged for review, with a capture still pending, waiting for PayPal to confirm, or differing from PayPal.',
      params: s => s.object({}),
      execute: (_args: unknown, ctx: AgAiToolContext) => {
        const payload = unresolvedPayments(data());
        return ctx.success(payload.count ? `${payload.count} payments are unresolved.` : 'No payments are unresolved in these records.', payload);
      },
    });
    const runCheck: AgAiTool = api.defineAiTool({
      name: 'run_paypal_check', description: 'Run the ledger\'s read-only PayPal check, which reads from PayPal each captured order that has no read yet, across every session, and compares it with the records. It changes nothing.',
      params: s => s.object({}),
      execute: async (_args: unknown, ctx: AgAiToolContext) => {
        const result = await paypalCheck();
        onChecked();
        return ctx.success(result.note, result);
      },
    });
    const lead = builtIn.lead;
    const notes = readableNotes(adapter);
    const targets = ['data', 'page', 'planning', 'widget', 'clerk'];
    return {
      primary: 'lead', promptStarters: starters,
      agents: [
        readableHandBack(directLlmRunner({ ...lead, adapter, tools: (ctx, params) => [...(lead.tools?.(ctx, params) ?? []).filter(tool => tool.name !== 'delegate_to'), tools.delegateTo(targets)],
          instructions: (ctx, params) => `${lead.instructions?.(ctx, params) ?? ''}\n${leadInstructions}` })),
        directLlmRunner({ ...builtIn.data, adapter: notes, instructions: (ctx, params) => `${builtIn.data.instructions?.(ctx, params) ?? ''}\n${handBack}` }),
        directLlmRunner({ ...builtIn.planning, adapter: notes, instructions: (ctx, params) => `${builtIn.planning.instructions?.(ctx, params) ?? ''}\n${handBack}` }),
        directLlmRunner({ ...builtIn.widget, adapter: notes, instructions: (ctx, params) => `${builtIn.widget.instructions?.(ctx, params) ?? ''}\n${keepLayout}` }),
        directLlmRunner({ ...builtIn.page, adapter: notes, instructions: (ctx, params) => `${builtIn.page.instructions?.(ctx, params) ?? ''}\n${keepLayout}` }),
        directLlmRunner({ id: 'clerk', name: 'Stall clerk', description: 'Answers questions about payments, PayPal and the stall records, and can run the read-only PayPal check.',
          adapter: notes, maxTurns: 12, instructions: () => clerkInstructions, tools: ctx => [readUnresolved, runCheck, ctx.studio.viewSchema(), ctx.studio.executeQuery()] }),
      ],
    };
    });
  };
}
