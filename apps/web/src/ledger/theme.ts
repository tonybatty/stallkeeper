import { studioTheme } from 'ag-studio';

const token = (name: string) => `var(--${name})`;
const line = (name: string, width = 1) => ({ width, color: token(name) });
// Forest leads the sales chart; the other labelled series keep distinct colours.
const fills = ['accent', 'chip', 'pp', 'stop', 'ink', 'flag', 'muted', 'line', 'ok', 'rule'];
const palette = Object.fromEntries(fills.flatMap((name, index) => [[`chartPaletteFills${index + 1}Color`, token(name)], [`chartPaletteStrokes${index + 1}Color`, token('ink')]]));

// The ledger and custom widgets share the scoped palette in styles.css.
export const ledgerTheme = studioTheme.withParams({
  // Studio refuses to draw narrower than this, and the owner is on a phone.
  studioMinWidth: 0,
  fontFamily: token('font-body'), fontSize: token('text-body'), textColor: token('ink'), foregroundColor: token('ink'), subtleTextColor: token('muted'),
  backgroundColor: token('card'), borderColor: token('line'), accentColor: token('accent'), iconColor: token('ink'), rowHoverColor: token('art-bg'),
  studioWrapperBorder: false, studioWrapperBorderRadius: 0, studioWrapperSpacing: 0, studioWrapperBackgroundColor: token('bg'),
  studioCanvasBorder: false, studioCanvasBorderRadius: 0, studioCanvasShadow: false, studioCanvasBackgroundColor: token('bg'), studioCanvasPadding: 12, studioCanvasRowHeight: 18, studioCanvasFontFamily: token('font-body'),
  // Rem, so it grows with the browser's text size, and never under 44 px, so the CSV button stays a touch target.
  studioWidgetToolbarHeight: 'max(2.75rem, 44px)',
  studioWidgetBackgroundColor: token('card'), studioWidgetBorder: line('rule'), studioWidgetBorderRadius: 12, studioWidgetShadow: false, studioWidgetPadding: 12,
  studioWidgetTitleFontFamily: token('font-body'), studioWidgetTitleFontSize: token('text-body'), studioWidgetTitleFontWeight: 600, studioWidgetTitleTextColor: token('ink'),
  studioWidgetSubtitleFontFamily: token('font-body'), studioWidgetSubtitleFontSize: token('text-small'), studioWidgetSubtitleTextColor: token('muted'),
  studioWidgetCaptionFontFamily: token('font-body'), studioWidgetCaptionFontSize: token('text-small'), studioWidgetCaptionTextColor: token('muted'), studioWidgetResizeBorderColor: token('ink'),
  studioPanelContainerBackgroundColor: token('card'), studioPanelContainerBorder: line('rule'), studioPanelContainerBorderRadius: 12, studioPanelDividerColor: token('rule'), studioPanelDividerActiveColor: token('ink'), studioPanelSectionBorderColor: token('rule'),
  studioPanelHeaderFontFamily: token('font-body'), studioPanelHeaderFontWeight: 600, studioPanelChevronButtonHoverBackgroundColor: token('art-bg'), studioPanelChevronButtonHoverColor: token('ink'),
  inputBorder: line('line'), pickerButtonBorder: line('line'), buttonBorder: line('line'), checkboxUncheckedBorderColor: token('line'), studioWidgetSelectionItemBorder: line('line'),
  studioToggleButtonActiveBackgroundColor: token('art-bg'), studioToggleButtonActiveBorderColor: token('ink'), studioToggleButtonActiveColor: token('ink'),
  gridFontFamily: token('font-body'), gridFontSize: token('text-body'), gridCellTextColor: token('ink'), gridHeaderBackgroundColor: token('card'), gridHeaderTextColor: token('muted'), gridHeaderFontWeight: 600, gridHeaderFontSize: token('text-small'), gridHeaderHeight: 'max(2.75rem, 44px)',
  gridRowHeight: 'max(2.75rem, 44px)', gridRowBorder: line('rule'), gridHeaderRowBorder: line('line'), gridPinnedRowBorder: line('line'), gridRowHoverColor: token('art-bg'), gridWrapperBorder: false,
  chartFontFamily: token('font-body'), chartFontSize: token('text-small'), chartAxisLabelFontSize: token('text-small'), chartAxisTitleFontSize: token('text-small'), chartSeriesLabelFontSize: token('text-small'), chartTextColor: token('ink'), chartSubtleTextColor: token('muted'), chartAxisLineColor: token('line'), chartGridLineColor: token('rule'),
  ...palette,
});
