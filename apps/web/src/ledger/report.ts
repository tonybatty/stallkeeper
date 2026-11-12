import type { AgDrillThroughOptions, AgPageState, AgReportState, AgWidgetLayoutState } from 'ag-studio';
import { priceJourneyFieldIds } from './priceJourney.fixtures.js';

export const pageTitles: Record<string, string> = { takings: 'Takings', offers: 'Offers', paypal: 'PayPal check' };
// The tab strip shows the two pages an owner reads most. The PayPal check opens from the header menu and shows a tab while it is open.
export const tabPages = ['takings', 'offers'];

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });
const title = (text: string) => ({ title: { enabled: true, text } });
const gridTitle = (text: string) => ({ ...title(text), style: { columnAutoSize: true } });
const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const typography = (fontSize: number) => ({ fontFamily: "Inter, system-ui, Arial, sans-serif", fontSize, fontStyle: 'normal' as const });
// The label is set in the muted colour so the figure leads.
const kpi = (text: string, value: { id: string; aggregation?: 'sum' }, recordedSales = false) => ({
  type: 'value' as const,
  dataMapping: { value: [value] },
  format: { title: { enabled: true, text, typography: { ...typography(15), fontWeight: 'bold' as const }, color: 'var(--muted)' }, caption: { enabled: true, text: '', typography: typography(0) }, style: { typography: { ...typography(32), fontWeight: 'bold' as const, ...(recordedSales && { fontFamily: "Fraunces, Georgia, 'Times New Roman', serif" }) } } },
});
// Our own widgets are registered at run time, so the default registry's type list does not name them.
const custom = (type: string, dataMapping: Record<string, unknown>, text: string) => ({ type, dataMapping, format: title(text) }) as unknown as NonNullable<AgPageState['widgets']>[string];
// Price source and asking price carry the payment context, so there is no mode column. That leaves the item link and PayPal state room to stay readable without a horizontal scroll.
const ledgerColumns = ['ledger.at', 'ledger.kind', 'ledger.item', 'ledger.code', 'ledger.priceSource', 'ledger.asking', 'ledger.amount', 'ledger.status'].map(id => ({ id }));
const poundsAxis = { title: { enabled: true, text: '£' } };

function pages(): AgPageState[] {
  const takings: AgPageState = {
    id: 'takings',
    widgets: {
      'kpi-sales': kpi('Recorded sales', sum('ledger.recordedSales'), true),
      'kpi-items': kpi('Items sold', sum('ledger.itemsSold')),
      'kpi-refunds': kpi('Refund rate', { id: 'refundRate' }),
      'kpi-discount': kpi('Discount given', sum('ledger.discount')),
      hours: { type: 'column-chart-grouped', dataMapping: { categoryKey: [{ id: 'ledger.hour' }], valueKey: [sum('ledger.recordedSales')] }, format: { ...title('Takings by hour'), style: { custom: { valueAxis: poundsAxis } } } },
      till: custom('till-roll', { cols: ['ledger.at', 'ledger.kind', 'ledger.item', 'ledger.code', 'ledger.amount', 'ledger.itemId'].map(id => ({ id })) }, 'Till roll'),
      grid: { type: 'grid', dataMapping: { cols: ledgerColumns }, sort: [{ field: { id: 'ledger.at' }, direction: 'desc' }], format: gridTitle('Ledger') },
    },
    widgetLayout: {
      'kpi-sales': at(0, 0, 6, 6), 'kpi-items': at(6, 0, 6, 6), 'kpi-discount': at(12, 0, 6, 6), 'kpi-refunds': at(18, 0, 6, 6),
      hours: at(0, 6, 14, 18), till: at(14, 6, 10, 18), grid: at(0, 24, 24, 20),
    },
  };
  const offers: AgPageState = {
    id: 'offers',
    widgets: {
      'kpi-rate': kpi('Offer to sale rate', { id: 'offerToSale' }),
      outcomes: { type: 'donut-chart', dataMapping: { categoryKey: [{ id: 'offers.outcome' }], valueKey: [sum('offers.made')] }, format: { ...title('Offers by outcome'), style: { custom: { pieDataLabel: { enabled: true }, totalLabel: { enabled: false } } } } },
      funnel: { type: 'funnel-chart', dataMapping: { categoryKey: [{ id: 'stages.stage' }], valueKey: [sum('stages.count')] }, format: { ...title('From offer to paid'), style: { theme: { funnel: { series: { label: { enabled: true } } } } } } },
      prices: { type: 'bar-chart-grouped', dataMapping: { categoryKey: [{ id: 'offers.code' }], valueKey: [{ id: 'offers.asking', aggregation: 'max' }, { id: 'offers.card', aggregation: 'max' }] }, format: { ...title('Asking and offer price by tag'), style: { custom: { valueAxis: poundsAxis }, theme: { common: { legend: { enabled: true } } } } } },
      table: { type: 'grid', dataMapping: { cols: ['offers.at', 'offers.item', 'offers.round', 'offers.offered', 'offers.outcome', 'offers.card', 'offers.cardStatus', 'offers.becameSale'].map(id => ({ id })) }, sort: [{ field: { id: 'offers.at' }, direction: 'desc' }], format: gridTitle('Offers') },
    },
    widgetLayout: { 'kpi-rate': at(0, 0, 8, 6), funnel: at(0, 6, 8, 12), outcomes: at(8, 0, 16, 18), prices: at(0, 18, 24, 16), table: at(0, 34, 24, 20) },
  };
  const paypal: AgPageState = {
    id: 'paypal',
    widgets: {
      stamp: custom('check-stamp', { value: [{ id: 'ledger.status' }, { id: 'ledger.id', aggregation: 'count' }] }, 'Check'),
      // The combined PayPal status already reflects capture, webhook and order reads, so only the capture fact sits beside it, which keeps the amount and status readable at the demo width.
      attention: { type: 'grid', dataMapping: { cols: ['ledger.at', 'ledger.item', 'ledger.code', 'ledger.amount', 'ledger.capture', 'ledger.status'].map(id => ({ id })) }, sort: [{ field: { id: 'ledger.at' }, direction: 'desc' }], format: gridTitle('Every payment, with its PayPal state') },
    },
    widgetLayout: { stamp: at(0, 0, 24, 16), attention: at(0, 16, 24, 26) },
  };
  return [takings, offers, paypal];
}

// The ledger is the report across every session, so no filter is set. The owner narrows to one session with the Session filter.
export function initialReport(): AgReportState {
  return { selectedPageId: 'takings', panels: { filters: { collapsed: true }, data: { collapsed: true } }, pages: pages() };
}

export function itemStoryFilter(itemId: string): AgDrillThroughOptions {
  return { filter: { field: { id: 'items.id' }, operator: 'isIn', value: [itemId] } };
}

export function itemStoryReport(): AgReportState {
  const story: AgPageState = {
    id: 'story',
    widgets: {
      journey: custom('price-journey', { cols: priceJourneyFieldIds.map(id => ({ id })) }, 'Price journey'),
      'story-offers': { type: 'grid', dataMapping: { cols: ['offers.at', 'offers.item', 'offers.round', 'offers.offered', 'offers.outcome', 'offers.card', 'offers.cardStatus', 'offers.becameSale'].map(id => ({ id })) }, sort: [{ field: { id: 'offers.at' }, direction: 'desc' }], format: gridTitle('Offers') },
      'story-payment': { type: 'grid', dataMapping: { cols: ['ledger.at', 'ledger.item', 'ledger.amount', 'ledger.capture', 'ledger.webhook', 'ledger.paypalCheck', 'ledger.status'].map(id => ({ id })) }, sort: [{ field: { id: 'ledger.at' }, direction: 'desc' }], format: gridTitle('Payment state') },
    },
    // Each grid gets the full width, as the summary grids do: side by side at 1440 px their columns would scroll sideways.
    widgetLayout: { journey: at(0, 0, 24, 18), 'story-offers': at(0, 18, 24, 20), 'story-payment': at(0, 38, 24, 20) },
  };
  return { selectedPageId: 'story', panels: { filters: { collapsed: true }, data: { collapsed: true } }, pages: [story] };
}

// A saved layout keeps the owner's edits and an agent's cards. Filters a widget set, such as a session chosen last time, are dropped,
// so the report opens on every session, and a cross filter is a moment's selection and not an edit.
export function keepEdits(built: AgReportState, saved: AgReportState): AgReportState {
  const pages = saved.pages.map(page => ({ ...page, crossFilter: undefined, filter: { ...page.filter, page: page.filter?.page?.filter(filter => !filter.filterWidgetId) ?? [] } }));
  return { ...built, pages };
}
