import type { AgAiAgentRunner, AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from 'ag-studio';
import { displayNames } from './sources.js';

interface Finish { type: 'FINISH'; finishReason: string; usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number } }
type Line = AgAiEvent | Finish;

// Studio's agents name fields, widgets and tables as @field[ledger.recordedSales]. Its chat panel turns a reference into a
// pill only where it parses the text, and the notes of a delegated agent are shown as written, so the owner would see the raw token.
const reference = /@(?:field|widget|table)\[([^\]\s]{1,120})\]/g;
// A reference still arriving: held back until it closes, so a token split across deltas is never shown half-way.
const unfinished = /@(?:f(?:i(?:e(?:ld?)?)?)?|w(?:i(?:d(?:g(?:et?)?)?)?)?|t(?:a(?:b(?:le?)?)?)?)?(?:\[[^\]\s]{0,120})?$/;
// A known reference reads as its name on the page, so ledger.recordedSales and sessions.recordedSales stay told apart.
// The first letter drops to lower case unless the first word is a name such as PayPal.
const sentenceCase = (name: string) => /^[A-Z][a-z]*(?:\s|$)/.test(name) ? name[0]!.toLowerCase() + name.slice(1) : name;
const humanise = (id: string) => id.split('.').pop()!.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();
export const readableReferences = (text: string) => text.replace(reference, (_, id: string) => {
  const name = displayNames.get(id);
  return name ? sentenceCase(name) : humanise(id);
});

class ReferenceReader {
  private held = new Map<string, string>();
  read(line: AgAiEvent): AgAiEvent[] {
    if (line.type === 'TEXT_MESSAGE_CONTENT') {
      const text = (this.held.get(line.messageId) ?? '') + line.delta;
      const tail = unfinished.exec(text)?.[0] ?? '';
      this.held.set(line.messageId, tail);
      const ready = readableReferences(text.slice(0, text.length - tail.length));
      return ready ? [{ ...line, delta: ready }] : [];
    }
    if (line.type === 'TEXT_MESSAGE_END') {
      const tail = this.held.get(line.messageId) ?? '';
      this.held.delete(line.messageId);
      return tail ? [{ type: 'TEXT_MESSAGE_CONTENT', messageId: line.messageId, delta: readableReferences(tail) }, line] : [line];
    }
    return [line];
  }
}

// Only the streamed notes are rewritten. The completed turn keeps its references, because Studio feeds it back as history.
export function readableNotes(adapter: AgLlmAdapter): AgLlmAdapter {
  return {
    executeTurn(request, options) {
      const handler = adapter.executeTurn(request, options);
      async function* stream() {
        const references = new ReferenceReader();
        for await (const event of handler.stream) yield* references.read(event);
      }
      return { stream: stream(), complete: handler.complete };
    },
  };
}

// The collapsed "Delegated to Stall clerk" step shows the `response` of the delegate_to result, which is the clerk's
// complete_task summary as written. Studio stores that result from the TOOL_CALL_RESULT event, so only the event is
// rewritten: the lead's current turn still gets the raw result, and the raw summary rides along under `data.summary`,
// so later turns, which Studio rebuilds from the stored result, keep the references.
// AG Studio 3.1.0 fills in this placeholder when a delegate ends without calling complete_task. The owner sees a plain word
// instead; the delegates are told to call complete_task, so this shows only when a model skips it.
const noSummary = '(the delegate finished without a summary)';
const handBack = (response: string) => response === noSummary ? 'Finished.' : readableReferences(response);

export function readableHandBack<T>(runner: AgAiAgentRunner<T>): AgAiAgentRunner<T> {
  return {
    ...runner,
    async *run(input, ctx) {
      const delegations = new Set<string>();
      for await (const event of runner.run(input, ctx)) {
        if (event.type === 'TOOL_CALL_START' && event.toolCallName === 'delegate_to') delegations.add(event.toolCallId);
        if (event.type !== 'TOOL_CALL_RESULT' || !delegations.has(event.toolCallId)) { yield event; continue; }
        // A tool that throws comes back as plain text, not JSON.
        const result = (() => { try { return JSON.parse(event.content) as { response?: unknown }; } catch { return {}; } })();
        yield typeof result.response === 'string'
          ? { ...event, content: JSON.stringify({ ...result, response: handBack(result.response), data: { summary: result.response } }) }
          : event;
      }
    },
  };
}

// Folds one turn's events into the response Studio pairs tool results against. A tool call's callId must be the id
// streamed in TOOL_CALL_START, or the result Studio sends back matches nothing.
export function collectTurn(lines: Line[], id: string, now: number): AgLlmResponse {
  const output: AgAiOutputItem[] = [];
  const texts = new Map<string, string>();
  const calls = new Map<string, { name: string; args: string }>();
  let usage: Finish['usage'] | undefined;
  let finish = 'stop';
  for (const line of lines) {
    if (line.type === 'TEXT_MESSAGE_START') texts.set(line.messageId, '');
    else if (line.type === 'TEXT_MESSAGE_CONTENT') texts.set(line.messageId, (texts.get(line.messageId) ?? '') + line.delta);
    else if (line.type === 'TEXT_MESSAGE_END') {
      output.push({ id: line.messageId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: texts.get(line.messageId) ?? '', annotations: [] }] });
    } else if (line.type === 'TOOL_CALL_START') calls.set(line.toolCallId, { name: line.toolCallName, args: '' });
    else if (line.type === 'TOOL_CALL_ARGS') calls.get(line.toolCallId)!.args += line.delta;
    else if (line.type === 'TOOL_CALL_END') {
      const call = calls.get(line.toolCallId)!;
      output.push({ id: line.toolCallId, kind: 'output', type: 'function_call', callId: line.toolCallId, name: call.name, arguments: call.args || '{}', status: 'completed' });
    } else if (line.type === 'FINISH') { usage = line.usage; finish = line.finishReason; }
    else if (line.type === 'RUN_ERROR') return { id, createdAt: now, output, status: 'failed', error: { code: line.code ?? 'turn_failed', message: line.message } };
  }
  return { id, createdAt: now, output, usage, status: finish === 'length' ? 'incomplete' : 'completed', ...(finish === 'length' && { incompleteDetails: { reason: 'max_output_tokens' as const } }) };
}

// One model call per turn, through the API, which holds the key and fixes the model. The browser sends only what Studio
// built for this turn, and the route checks it. Studio ships no Claude adapter, so this is the provider boundary it asks for.
export function claudeAdapter(endpoint = '/api/owner/ledger/ai'): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
      const queue: AgAiEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      const flush = () => { wake?.(); wake = undefined; };
      const complete = (async () => {
        const id = crypto.randomUUID();
        const now = Date.now();
        const failed = (message: string): AgLlmResponse => ({ id, createdAt: now, output: [], status: 'failed', error: { code: 'turn_failed', message } });
        try {
          const response = await fetch(endpoint, {
            method: 'POST', headers: { 'content-type': 'application/json' }, signal: options?.signal,
            body: JSON.stringify({ input: request.input, instructions: request.instructions, toolChoice: request.toolChoice, tools: request.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
          });
          if (!response.ok || !response.body) {
            const reply = await response.json().catch(() => null) as { error?: string } | null;
            return failed(reply?.error ?? 'The Stall clerk could not answer just now. The report is unaffected.');
          }
          const lines: Line[] = [];
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            buffer += value;
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const part of parts.filter(Boolean)) {
              const line = JSON.parse(part) as Line;
              lines.push(line);
              if (line.type !== 'FINISH') { queue.push(line); flush(); }
            }
          }
          return collectTurn(lines, id, now);
        } catch (error) {
          if (options?.signal?.aborted) return { id, createdAt: now, output: [], status: 'cancelled' as const };
          console.error('Stall clerk turn failed', error);
          return failed('The Stall clerk could not be reached. The report is unaffected.');
        } finally { done = true; flush(); }
      })();
      async function* stream() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (done) return;
          await new Promise<void>(resolve => { wake = resolve; });
        }
      }
      return { stream: stream(), complete };
    },
  };
}
