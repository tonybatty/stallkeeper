import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

// A deterministic stand-in for Claude, so the capture rig can rehearse a sale on a laptop with no
// Anthropic key. It answers only from the stallholder facts in the prompt, like the real prompt asks.
// Its replies are not Claude's. A take that uses it is a dry run and must be logged as one.
const stop = new Set(['the', 'and', 'are', 'was', 'for', 'any', 'its', 'you', 'can', 'how', 'not', 'does', 'this', 'that', 'what', 'with', 'have', 'there', 'about', 'much', 'many', 'tell', 'your', 'from', 'will', 'work', 'works', 'working', 'item', 'lamp']);
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(word => !stop.has(word)) ?? [];

interface OwnerFacts { notes?: string }

export function scriptedReply(system: string, question: string) {
  const facts: OwnerFacts = JSON.parse(system.slice(system.indexOf('Stallholder facts: ') + 'Stallholder facts: '.length));
  const sentences = (facts.notes ?? '').split(/(?<=\.)\s+/);
  // The owner's first line usually says whether it works, so a working question reads that line.
  const working = /\b(work|works|working|tested|condition)\b/i.test(question) ? sentences.find(candidate => /\b(works?|working|tested|condition)\b/i.test(candidate)) : undefined;
  if (working) return `The stallholder says: ${working}`;
  const asked = new Set(words(question));
  const sentence = sentences.find(candidate => words(candidate).some(word => asked.has(word)));
  if (sentence) return `The stallholder says: ${sentence}`;
  return "I don't know that. The stallholder's notes don't cover it.";
}

export function scriptedModel(): LanguageModel {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const system = prompt.find(message => message.role === 'system')?.content ?? '';
      const last = prompt.filter(message => message.role === 'user').at(-1);
      const question = (Array.isArray(last?.content) ? last.content : []).map(part => (part.type === 'text' ? part.text : '')).join(' ');
      return {
        content: [{ type: 'text', text: scriptedReply(system, question) }],
        finishReason: { unified: 'stop', raw: 'scripted' },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        warnings: [],
      };
    },
  });
}
