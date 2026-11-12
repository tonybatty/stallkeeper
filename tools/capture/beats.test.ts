import { expect, it } from 'vitest';
import { beats, captionsSrt, captionText, FILM_SECONDS, runOrder } from './beats.ts';

const facts = { askingPence: 2800, priceAgreedPence: 2400, counterPence: 2400, dryRun: false };
const beat = (id: string) => beats.find(candidate => candidate.id === id)!;

it('fills the film with no gap or overlap', () => {
  expect(beats[0]!.start).toBe(0);
  expect(beats.at(-1)!.end).toBe(FILM_SECONDS);
  beats.forEach((current, index) => { if (index) expect(current.start).toBe(beats[index - 1]!.end); });
});

it('puts the AI answer before 0:34', () => {
  expect(beat('question').start).toBeLessThan(34);
  expect(beat('question').end).toBeLessThanOrEqual(34);
});

it('labels the owner setup as earlier footage and runs it first', () => {
  expect(beat('earlier').footage).toBe('earlier');
  expect(runOrder[0]).toBe('earlier');
  expect(new Set(runOrder)).toEqual(new Set(beats.filter(candidate => candidate.roles.length).map(candidate => candidate.id)));
});

it('shows the second buyer refused before payment completes', () => {
  expect(beat('reserve').roles).toContain('rival');
  expect(beat('reserve').end).toBeLessThanOrEqual(beat('approve').start);
});

it('puts the accepted amount in every caption that names a price', () => {
  expect(captionText(beat('agree'), facts)).toContain('£24');
  expect(captionText(beat('feed'), facts)).toContain('£24');
  expect(captionText(beat('feed'), { ...facts, priceAgreedPence: 2200 })).toContain('£22');
});

it('uses the asking price when no offer was made, and says so on a dry run', () => {
  const noOffer = { ...facts, priceAgreedPence: null, counterPence: null, dryRun: true };
  expect(captionText(beat('feed'), noOffer)).toBe('DRY RUN, scripted model. The stallholder feed shows the sale at £28, then the webhook verified mark.');
});

it('writes one SubRip cue per beat', () => {
  const srt = captionsSrt(facts);
  expect(srt.split('\n\n').filter(Boolean)).toHaveLength(beats.length);
  expect(srt).toContain('00:00:15,000 --> 00:00:34,000');
});

it('names no tag code in any caption, because the demo stall\'s codes change at every reset', () => {
  expect(beats.filter(candidate => candidate.caption.includes('{code}'))).toEqual([]);
});

it('runs the closing beat', () => {
  expect(beat('closing').pending).toBeUndefined();
});
