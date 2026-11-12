import { expect, it } from 'vitest';
import { scriptedReply } from './scripted-model.js';

const system = `Rules.\nStallholder facts: ${JSON.stringify({ notes: 'Tested, it works. Scuff on the base. Made in 1970. Height 30 cm.' })}`;

it('answers a working question from the first line of the notes', () => {
  expect(scriptedReply(system, 'Does it work?')).toBe('The stallholder says: Tested, it works.');
});

it('quotes the note sentence that shares a word with the question', () => {
  expect(scriptedReply(system, 'How tall is it? Is there a scuff?')).toBe('The stallholder says: Scuff on the base.');
});

it('admits what the notes do not cover', () => {
  expect(scriptedReply(system, 'Is the shade original?')).toBe("I don't know that. The stallholder's notes don't cover it.");
});
