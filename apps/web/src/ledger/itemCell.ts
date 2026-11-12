import type { AgGridWidgetOptions, AgWidgetCellRendererParams, AgWidgetField, AgWidgetFieldReference } from 'ag-studio';
import { clockTime, stamp } from '../time.js';
import { phoneQuery } from './phone.js';

const amount: AgWidgetFieldReference = { id: 'ledger.amount', aggregation: 'first' };
const kind: AgWidgetFieldReference = { id: 'ledger.kind', aggregation: 'first' };
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' });
type ItemContext = { itemId?: string; amount?: string; kind?: string };
const itemContext = (field: AgWidgetField) => field.context as ItemContext | undefined;
const itemIdFor = (field: AgWidgetField): AgWidgetFieldReference | undefined => {
  const itemId = itemContext(field)?.itemId;
  return itemId ? { id: itemId, aggregation: 'first' } : undefined;
};
const linkedFor = (field: AgWidgetField) => {
  const context = itemContext(field);
  if (!context?.itemId) return undefined;
  const refs: AgWidgetFieldReference[] = [];
  if (context.amount) refs.push({ id: context.amount, aggregation: 'first' });
  if (context.kind) refs.push({ id: context.kind, aggregation: 'first' });
  refs.push({ id: context.itemId, aggregation: 'first' });
  return refs;
};

// On a phone the columns after Item sit off to the right, so the Item cell carries the row's amount, with the kind named
// when it is not a plain sale. Studio's CSV export and the column order are untouched, because a linked field is never a column.
// The cell reads the viewport when it is drawn: Studio options are shared by every width, so a CSS rule cannot choose.
export function itemCell(name: unknown, linked: (ref: AgWidgetFieldReference) => unknown, phone: boolean, itemId?: string, openItemStory?: (itemId: string) => void): HTMLElement | string {
  const text = String(name ?? '');
  const value = linked(amount);
  const story = itemId && openItemStory ? () => openItemStory(itemId) : undefined;
  if ((!phone || typeof value !== 'number') && !story) return text;
  const label = String(linked(kind) ?? '');
  const cell = document.createElement('span');
  cell.className = 'ledger-item-cell';
  // With a story to open, the item's name is the link to it, so a narrow column truncates one thing, not the name beside a second link.
  const top = document.createElement(story ? 'button' : 'span');
  top.className = story ? 'ledger-item-story' : 'ledger-item-name';
  const nameLabel = document.createElement('span');
  nameLabel.className = 'ledger-item-name';
  nameLabel.textContent = text;
  top.append(nameLabel);
  if (story && top instanceof HTMLButtonElement) {
    top.type = 'button';
    top.setAttribute('aria-label', `Open item story: ${text}`);
    top.addEventListener('click', event => {
      event.stopPropagation();
      story();
    });
  }
  cell.append(top);
  if (phone && typeof value === 'number') {
    const bottom = document.createElement('span');
    bottom.className = 'ledger-item-amount';
    bottom.textContent = label && label !== 'Sale' ? `${label} ${money.format(value)}` : money.format(value);
    if (label === 'Refund') bottom.dataset.kind = 'refund';
    (story ? top : cell).append(bottom);
    if (story) top.setAttribute('aria-label', `Open item story: ${text}, ${bottom.textContent}`);
  }
  return cell;
}

// Studio's grid hands a cell renderer only `getLinkedValue`, with no grid context, so the Ledger view registers its opener
// here. It clears it inside an item story and on unmount, which leaves no story action on any Item cell.
let storyOpener: ((itemId: string) => void) | undefined;
export function setItemStoryOpener(open: ((itemId: string) => void) | undefined) { storyOpener = open; }

export const itemCellOptions: Pick<AgGridWidgetOptions, 'createCellRenderer' | 'getLinkedFields'> = {
  getLinkedFields: linkedFor,
  createCellRenderer: field => field.fieldId === 'ledger.at'
    ? (params: { value?: unknown; valueFormatted?: string }) => {
      const value = params.value instanceof Date ? params.value.toISOString() : String(params.value ?? '');
      if (!value) return document.createElement('span');
      const time = document.createElement('time');
      time.dateTime = value;
      time.title = stamp(value);
      time.setAttribute('aria-label', time.title);
      if (!window.matchMedia?.(phoneQuery).matches) {
        time.textContent = params.valueFormatted ?? time.title;
        return time;
      }
      const date = document.createElement('span');
      date.className = 'ledger-when-date';
      date.textContent = `${day.format(new Date(value))}, `;
      time.append(date, clockTime(value));
      return time;
    }
    : itemIdFor(field)
    ? (params: AgWidgetCellRendererParams & { value?: unknown }) => {
      const itemId = String(params.getLinkedValue(itemIdFor(field)!) ?? '') || undefined;
      return itemCell(params.value, params.getLinkedValue, !!window.matchMedia?.(phoneQuery).matches, itemId, storyOpener);
    }
    : undefined,
};
