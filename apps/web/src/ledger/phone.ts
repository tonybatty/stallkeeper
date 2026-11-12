import { singleColumnLayout, type AgResponsiveLayoutBreakpoint, type AgWidgetLayoutState } from 'ag-studio';
import type { LedgerData } from './sources.js';

// Below this width the report is one column that the page scrolls, with the figures first.
const phoneWidth = 500;
export const phoneQuery = `(max-width: ${phoneWidth}px)`;
export const canvasRowHeight = 18;
const canvasPadding = 12;

// Widget order on a phone. A widget not listed here, such as an agent's card, follows the listed ones in its desktop order.
export const phoneOrder: Record<string, string[]> = {
  takings: ['kpi-sales', 'kpi-items', 'kpi-refunds', 'kpi-discount', 'hours', 'till', 'grid'],
  offers: ['outcomes', 'kpi-rate', 'funnel', 'prices', 'table'],
  paypal: ['stamp', 'attention'],
  story: ['journey', 'story-offers', 'story-payment'],
};
const halves = new Set(['kpi-sales', 'kpi-items', 'kpi-refunds', 'kpi-discount']);
const fixedRows: Record<string, number> = { 'kpi-sales': 6, 'kpi-items': 6, 'kpi-refunds': 6, 'kpi-discount': 6, 'kpi-rate': 6, hours: 16, outcomes: 18, funnel: 16, prices: 20, stamp: 22 };

// A phone gives the page the scroll, so a list must be tall enough for every row. These are pixel heights at the default 16 px text
// size of one row and of what surrounds the rows: the widget's title and padding, a grid's header row, and the Till roll's printed total.
const gridRow = 44;
const gridChrome = 52 + 80;
const tillRow = 110;
const tillChrome = 48 + 80;
const journeyEvent = 144;
const journeyChrome = 112;
// One spare row keeps a long item name that wraps from putting a scroll area back.
const spare = 1;
const rowsFor = (pixels: number, scale: number) => Math.ceil(pixels * scale / canvasRowHeight) + spare;

// The ledger's text and rows are sized in rem, so they grow with the browser's text size. Never below 1, because tap targets keep 44 px.
const textScale = () => Math.max(1, (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16);

interface PhoneCounts { ledger: number; offers: number; journey?: number; textScale?: number }
export const phoneCounts = (data: LedgerData, itemId?: string): PhoneCounts => ({
  textScale: textScale(),
  ledger: itemId ? data.ledger.filter(row => row.itemId === itemId).length : data.ledger.length,
  offers: itemId ? data.offers.filter(row => row.itemId === itemId).length : data.offers.length,
  journey: itemId ? (data.journeys ?? []).filter(row => row.itemId === itemId).length : (data.journeys ?? []).length,
});

function spanOf(id: string, counts: PhoneCounts, own: number) {
  const scale = counts.textScale ?? 1;
  const grid = (rows: number) => rowsFor(rows * gridRow + gridChrome, scale);
  switch (id) {
    case 'till': return rowsFor(counts.ledger * tillRow + tillChrome, scale);
    case 'grid': case 'attention': return grid(counts.ledger);
    case 'table': return grid(counts.offers);
    case 'journey': return rowsFor((counts.journey ?? 0) * journeyEvent + journeyChrome, scale);
    case 'story-offers': return grid(counts.offers);
    case 'story-payment': return grid(counts.ledger);
    default: return fixedRows[id] ? Math.ceil(fixedRows[id] * scale) : own;
  }
}

// The order and row height of each widget, from the widgets as the page holds them. `layouts` and `ids` run in step.
export function arrange(pageId: string, ids: string[], layouts: AgWidgetLayoutState[], columns: number, counts: PhoneCounts) {
  const order = phoneOrder[pageId] ?? [];
  const rank = (index: number) => { const at = order.indexOf(ids[index]!); return at < 0 ? order.length : at; };
  const indices = ids.map((_, index) => index).sort((a, b) => rank(a) - rank(b) || layouts[a]!.yTrack - layouts[b]!.yTrack || layouts[a]!.xTrack - layouts[b]!.xTrack);
  const half = Math.floor(columns / 2);
  const out: AgWidgetLayoutState[] = new Array(ids.length);
  let y = 0;
  let side = 0;
  let rowSpan = 0;
  for (const index of indices) {
    const id = ids[index]!;
    const ySpan = spanOf(id, counts, layouts[index]!.ySpan);
    if (halves.has(id)) {
      out[index] = { xTrack: side * half, yTrack: y, xSpan: side ? columns - half : half, ySpan };
      rowSpan = Math.max(rowSpan, ySpan);
      side = 1 - side;
      if (side === 0) { y += rowSpan; rowSpan = 0; }
      continue;
    }
    if (side === 1) { y += rowSpan; rowSpan = 0; side = 0; }
    out[index] = { xTrack: 0, yTrack: y, xSpan: columns, ySpan };
    y += ySpan;
  }
  if (side === 1) y += rowSpan;
  return { layouts: out, rows: y };
}

// The canvas is as tall as its widgets, so the page scrolls and the report has no scroll of its own.
// The extra pixels cover the canvas's own border, so Studio's layout box has nothing left to scroll.
export const canvasHeight = (rows: number) => rows * canvasRowHeight + canvasPadding * 2 + 4;

export function phoneBreakpoint(pageId: string, ids: string[], counts: PhoneCounts): AgResponsiveLayoutBreakpoint {
  return {
    maxWidth: phoneWidth,
    // Studio hands over the widgets without their ids, in the order of the page's layout. If that order is not the one the page holds, fall back to a plain column.
    layout: (candidates, { columns }) => candidates.length === ids.length
      ? arrange(pageId, ids, candidates.map(candidate => candidate.layout), columns, counts).layouts
      : singleColumnLayout(candidates, { columns, rows: undefined }),
  };
}
