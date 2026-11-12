// A take's beats in order, as data. The script uses them for what is ready to
// run, and the captions use them for timing.

export type Role = 'buyer' | 'owner' | 'rival';
export type Footage = 'live' | 'earlier' | 'generated' | 'card';

export interface Beat {
  id: string;
  /** Film window in seconds. */
  start: number;
  end: number;
  /** Which simulators show this beat. Empty for beats that are not simulator footage. */
  roles: Role[];
  footage: Footage;
  /** Caption text. {asking}, {price} and {counter} are filled from the take. No caption names a tag code, because the demo stall's codes change at every reset. */
  caption: string;
  /** What the script cannot run yet, and why. Absent when the script runs it. */
  pending?: string;
}

export const FILM_SECONDS = 165;

export const beats: Beat[] = [
  { id: 'establishing', start: 0, end: 8, roles: [], footage: 'generated', caption: 'Generated scene. The stallholder is busy nearby.', pending: 'Generated visual, made when the video is assembled.' },
  { id: 'tag-url', start: 8, end: 15, roles: ['buyer'], footage: 'live', caption: 'iOS Simulator, not a phone. The tag URL is opened directly; no physical scan is shown. {asking} for the lamp.' },
  { id: 'question', start: 15, end: 34, roles: ['buyer'], footage: 'live', caption: 'Stallkeeper answers from the stallholder\'s notes.' },
  { id: 'offer', start: 34, end: 54, roles: ['buyer'], footage: 'live', caption: 'A low offer gets a counter-offer of {counter}, set by the server.' },
  { id: 'agree', start: 54, end: 64, roles: ['buyer'], footage: 'live', caption: 'Tapping Accept agrees {price}. Stallkeeper checks it against the stallholder\'s limits.' },
  { id: 'reserve', start: 64, end: 71, roles: ['buyer', 'rival'], footage: 'live', caption: 'Pay reserves the item. A second buyer is told it is being paid for.' },
  { id: 'approve', start: 71, end: 96, roles: ['buyer'], footage: 'live', caption: 'PayPal sandbox approval and capture of {price}. Waits shortened.' },
  { id: 'paid', start: 96, end: 106, roles: ['buyer'], footage: 'live', caption: 'The page says it is paid only after a completed capture.', pending: 'The take reads the paid page inside the approve beat, so there is no separate step.' },
  { id: 'feed', start: 106, end: 121, roles: ['owner'], footage: 'live', caption: 'The stallholder feed shows the sale at {price}, then the webhook verified mark.' },
  { id: 'earlier', start: 121, end: 141, roles: ['owner'], footage: 'earlier', caption: 'Earlier: the stallholder adds the item, sets the price and limits, and prints the tag.' },
  { id: 'closing', start: 141, end: 156, roles: ['owner'], footage: 'live', caption: 'Closing report: one staged difference, labelled as staged. It reports, it does not accuse.' },
  { id: 'end-card', start: 156, end: 165, roles: [], footage: 'card', caption: 'A prototype on PayPal sandbox. No real sale.', pending: 'End card, made when the video is assembled.' },
];

/** The order the simulators act in, which differs from the film's order: the owner's setup is filmed first and shown as "Earlier". */
export const runOrder = ['earlier', 'tag-url', 'question', 'offer', 'agree', 'reserve', 'approve', 'paid', 'feed', 'closing'] as const;

export interface CaptionFacts { askingPence: number; priceAgreedPence: number | null; counterPence: number | null; dryRun: boolean }

const pounds = (pence: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100);

/** Fills a beat's caption from the take. With no offer, the price is the asking price, so no caption shows an amount that was not paid. */
export function captionText(beat: Beat, facts: CaptionFacts) {
  const price = facts.priceAgreedPence ?? facts.askingPence;
  const text = beat.caption
    .replaceAll('{asking}', pounds(facts.askingPence))
    .replaceAll('{price}', pounds(price))
    .replaceAll('{counter}', facts.counterPence === null ? 'the counter-offer' : pounds(facts.counterPence));
  return facts.dryRun ? `DRY RUN, scripted model. ${text}` : text;
}

const stamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  const part = (value: number, width: number) => String(value).padStart(width, '0');
  return `${part(Math.floor(ms / 3_600_000), 2)}:${part(Math.floor(ms / 60_000) % 60, 2)}:${part(Math.floor(ms / 1000) % 60, 2)},${part(ms % 1000, 3)}`;
};

export function captionsSrt(facts: CaptionFacts) {
  return beats.map((beat, index) => `${index + 1}\n${stamp(beat.start)} --> ${stamp(beat.end)}\n${captionText(beat, facts)}\n`).join('\n');
}
