import type { AgFormatShapeParams, AgShapeBuilder, AgStudioApi, AgWidgetFormParams } from 'ag-studio';
import { createWidgets } from 'ag-studio-vue3';
import CheckStamp from './CheckStamp.vue';
import PledgeProgress from './PledgeProgress.vue';
import { itemCellOptions } from './itemCell.js';
import PriceJourney from './PriceJourney.vue';
import TillRoll from './TillRoll.vue';

const size = (width: number, height: number) => ({ defaultSize: { width, height }, minSize: { width: 240, height: 160 } });
const noHighlight = { crossFilter: { supportsHighlight: false } };
const fields = (aiDescription: string) => ({ type: 'fieldset' as const, supportedRoles: ['category' as const, 'temporal' as const, 'numeric' as const], required: true, aiDescription });

const titleShape = (s: AgShapeBuilder) => s.object({
  enabled: s.boolean().optional(),
  text: s.string().optional(),
  typography: s.object({
    fontFamily: s.string().optional(),
    fontSize: s.number().optional(),
    fontWeight: s.enum(['normal', 'bold']).optional(),
    fontStyle: s.enum(['normal', 'italic']).optional(),
  }).optional(),
  color: s.string().optional(),
  textAlign: s.enum(['left', 'center', 'right']).optional(),
  wrapping: s.boolean().optional(),
});

const formatShape = (storesTriggerCrossFilter = false) => ({ api }: AgFormatShapeParams) => {
  // Studio exposes its shape builder through commands, so this no-op command only compiles the widget schema. Remove it when a standalone builder is public: https://www.ag-grid.com/studio/vue/custom-widgets/#ai-integration
  return (api as unknown as AgStudioApi).defineAiCommand(s => ({
    input: s.object({
      title: titleShape(s).optional(),
      subtitle: titleShape(s).optional(),
      caption: titleShape(s).optional(),
      crossFilter: s.enum(['filter', 'none']).optional(),
      ...(storesTriggerCrossFilter ? { triggerCrossFilter: s.boolean().optional() } : {}),
    }).optional(),
    execute: () => ({ success: true, value: undefined }),
  })).shape;
};

// Every widget needs a form, or Studio stops on "Loading..." when it resets widgets. Agents read `ai` to place them.
// The default registry's type list does not name our widgets, so the type stops at this boundary.
const stallWidgetIds = ['till-roll', 'check-stamp', 'pledge-progress', 'price-journey'];
const builtIn = createWidgets({
  overrides: [{ id: 'grid', options: itemCellOptions }],
  additionalTypes: [
    { id: 'till-roll', label: 'Till roll', icon: { url: '/favicon.svg' }, comp: TillRoll, ...size(320, 480),
      dataMapping: { cols: fields('Exactly six fields in this order: ledger.at, ledger.kind, ledger.item, ledger.code, ledger.amount, ledger.itemId. Do not add, omit, aggregate or reorder fields.') },
      formatShape: formatShape(true),
      form: (params: AgWidgetFormParams) => params.createDefaults({ dataMappingItems: [{ key: 'cols', label: 'Fields' }], supportsTriggerCrossFilter: true }),
      featureConfig: noHighlight,
      ai: {
        description: 'A receipt-like list of ledger movements, newest first, whose rows can cross-filter the report by item.',
        usage: 'Use for an auditable list of sales, tips, refunds and donations. Do not use for a single total, a PayPal check result or pledge progress.',
        configuration: 'Map cols to exactly ledger.at, ledger.kind, ledger.item, ledger.code, ledger.amount and ledger.itemId, in that order, with no aggregation. Set a short title and place a new roll in free space.',
      } },
    { id: 'check-stamp', label: 'Check stamp', icon: { url: '/favicon.svg' }, comp: CheckStamp, ...size(420, 280),
      dataMapping: { value: fields('Exactly two fields in this order: ledger.status, then ledger.id aggregated with count. Do not add, omit or reorder fields.') },
      formatShape: formatShape(),
      form: (params: AgWidgetFormParams) => params.createDefaults({ dataMappingItems: [{ key: 'value', label: 'Fields' }] }),
      featureConfig: noHighlight,
      ai: {
        description: 'An ink stamp that summarises whether recorded payments agree with PayPal and can run the read-only PayPal check.',
        usage: 'Use for payment verification status or unresolved payment counts. Do not use for a transaction list, sales total or donation pledge.',
        configuration: 'Map value to exactly ledger.status with no aggregation, then ledger.id aggregated with count. Use a title that names the payment check represented by the card.',
      } },
    { id: 'pledge-progress', label: 'Pledge progress', icon: { url: '/favicon.svg' }, comp: PledgeProgress, ...size(360, 320),
      dataMapping: { value: fields('Exactly four fields in this order: sessions.label, sessions.pledged summed, sessions.donated summed, sessions.recordedSales summed. Do not add, omit or reorder fields.') },
      formatShape: formatShape(),
      form: (params: AgWidgetFormParams) => params.createDefaults({ dataMappingItems: [{ key: 'value', label: 'Fields' }] }),
      featureConfig: noHighlight,
      ai: {
        description: 'A progress card comparing donations with the stall pledge and explaining the recorded-sales basis.',
        usage: 'Use only for progress towards a session pledge. Do not use for unresolved payments, a PayPal check or general takings.',
        configuration: 'Map value to exactly sessions.label with no aggregation, then sums of sessions.pledged, sessions.donated and sessions.recordedSales, in that order.',
      } },
    { id: 'price-journey', label: 'Price journey', icon: { url: '/favicon.svg' }, comp: PriceJourney, defaultSize: { width: 900, height: 420 }, minSize: { width: 320, height: 240 },
      dataMapping: { cols: fields('Map all journey event fields in order: id, itemId, item, code, sessionId, at, stage, amount, previousAmount, outcome, note and source.') },
      formatShape: formatShape(true),
      form: (params: AgWidgetFormParams) => params.createDefaults({ dataMappingItems: [{ key: 'cols', label: 'Journey fields' }], supportsTriggerCrossFilter: true }),
      featureConfig: noHighlight,
      ai: {
        label: 'Price journey',
        description: 'A chronological strip of price events for each item, including listing, offers, agreement, payment and refunds.',
        usage: 'Use it to explain how an item moved from its asking price to its final payment state. Do not use it for totals or comparisons across many items.',
        configuration: 'Map cols to every field in the Price journeys source. Keep the fields in their source order so the item and event cards have complete labels.',
      } },
  ],
} as unknown as Parameters<typeof createWidgets>[0]);

// Passing `menu` to createWidgets replaces the built-in groups. Studio then finds no `grid` in it, drops `defaultType` and takes the
// first widget of the first group, which is the Till roll. So we keep the built-in menu, put "Stall" ahead of it and name the default.
export const ledgerWidgets = { ...builtIn, menu: [{ label: 'Stall', widgetIds: stallWidgetIds }, ...builtIn.menu], defaultType: 'grid' } as typeof builtIn;
