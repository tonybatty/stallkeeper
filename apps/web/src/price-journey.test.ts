import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PriceJourney from './ledger/PriceJourney.vue';
import { priceJourneyFieldIds, priceJourneyFixture, type PriceJourneyRow } from './ledger/priceJourney.fixtures.js';

afterEach(() => vi.unstubAllGlobals());

const media = (phone: boolean) => vi.stubGlobal('matchMedia', vi.fn(() => ({
  matches: phone,
  media: '(max-width: 500px)',
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})));

function params(rows: PriceJourneyRow[], extra: Record<string, unknown> = {}) {
  const fields = priceJourneyFieldIds.map(fieldId => ({ fieldId, key: fieldId.split('.')[1] }));
  return {
    dataMapping: { cols: fields },
    widgetApi: {
      setDisplayState: vi.fn(),
      getData: vi.fn(async () => ({ results: { rows } })),
      getCrossFilterSelections: vi.fn(() => undefined),
      toggleCrossFilter: vi.fn(),
      ...extra,
    },
  };
}

const stages = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.stage-name').map(stage => stage.text());

describe('price journey', () => {
  it('lays the desktop journey out from left to right in time order', async () => {
    media(false);
    const widget = params([...priceJourneyFixture].reverse());
    const wrapper = mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    expect(wrapper.find('.price-journeys').attributes('aria-orientation')).toBe('horizontal');
    expect(stages(wrapper)).toEqual(['Listed', 'Price dropped', 'Offer', 'Offer shown', 'Offer', 'Offer shown', 'Agreed', 'Paid', 'Refunded']);
    expect(wrapper.findAll('.speech-card')).toHaveLength(4);
    expect(wrapper.findAll('.journey-stage time').every(time => time.text().length > 0)).toBe(true);
    expect(widget.widgetApi.setDisplayState).toHaveBeenLastCalledWith('displayed');
  });

  it('stacks the same chronological journey from top to bottom on a phone', async () => {
    media(true);
    const widget = params(priceJourneyFixture);
    const wrapper = mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    expect(wrapper.find('.price-journeys').attributes('aria-orientation')).toBe('vertical');
    expect(stages(wrapper).slice(0, 4)).toEqual(['Listed', 'Price dropped', 'Offer', 'Offer shown']);
    expect(wrapper.find('.price-change').text()).toContain('£28.00£26.00');
    expect(wrapper.find('.price-tag .stage-note').text()).toBe('Still unsold late in the day.');
  });

  it('shows a refund as a reversed receipt with pounds and time', async () => {
    media(false);
    const widget = params(priceJourneyFixture);
    const wrapper = mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    const refund = wrapper.find('.reversed-receipt');
    expect(refund.find('.stage-name').text()).toBe('Refunded');
    expect(refund.find('.stage-amount').text()).toBe('£22.00');
    expect(refund.find('time').text()).toContain('11:02');
  });

  it('uses Studio loading and no-data states', async () => {
    media(false);
    const widget = params([]);
    const wrapper = mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    expect(widget.widgetApi.setDisplayState.mock.calls).toEqual([
      ['loading', { prominent: true }],
      ['noData'],
    ]);
    expect(wrapper.findAll('.price-journey')).toHaveLength(0);
  });

  it('reports an incomplete mapping before asking Studio for data', async () => {
    media(false);
    const widget = params(priceJourneyFixture);
    widget.dataMapping.cols = widget.dataMapping.cols.filter(field => field.fieldId !== 'journeys.itemId');
    mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    expect(widget.widgetApi.setDisplayState).toHaveBeenCalledWith('incompleteDataMapping');
    expect(widget.widgetApi.getData).not.toHaveBeenCalled();
  });

  it('cross-filters on itemId and exposes the selected journey', async () => {
    media(false);
    const widget = params(priceJourneyFixture);
    const wrapper = mount(PriceJourney, { props: { params: widget as never } });
    await flushPromises();
    const journey = wrapper.find('.price-journey');
    const toggle = journey.find('button.journey-heading');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(toggle.find('.journey-events').exists()).toBe(false);
    expect(journey.find('.journey-events').exists()).toBe(true);
    await toggle.trigger('click');
    expect(widget.widgetApi.toggleCrossFilter).toHaveBeenCalledWith({
      type: 'value',
      field: expect.objectContaining({ fieldId: 'journeys.itemId' }),
      value: 'item-lamp',
      group: 0,
    });
    expect(toggle.attributes('aria-pressed')).toBe('true');
    expect(journey.classes()).toContain('selected');
  });

  it('orders Date values from Studio by time, not by weekday name', async () => {
    media(false);
    const lamp = priceJourneyFixture.filter(row => row.itemId === 'item-lamp');
    const listed = lamp.find(row => row.stage === 'Listed')!;
    const paid = lamp.find(row => row.stage === 'Paid')!;
    // Thursday then Sunday: "Sun ..." sorts before "Thu ..." as text.
    const rows = [
      { ...paid, at: new Date('2026-11-08T16:30:00Z') },
      { ...listed, at: new Date('2026-11-05T16:30:00Z') },
    ];
    const wrapper = mount(PriceJourney, { props: { params: params(rows as never) as never } });
    await flushPromises();
    expect(stages(wrapper)).toEqual(['Listed', 'Paid']);
    expect(wrapper.findAll('.journey-stage time').map(time => time.attributes('datetime'))).toEqual([
      '2026-11-05T16:30:00.000Z',
      '2026-11-08T16:30:00.000Z',
    ]);
  });

  it('leaves out a missing old or new price instead of showing zero', async () => {
    media(false);
    const rows = priceJourneyFixture.map(row => row.stage === 'Price dropped' ? { ...row, previousAmount: null } : row);
    const wrapper = mount(PriceJourney, { props: { params: params(rows) as never } });
    await flushPromises();
    const change = wrapper.find('.price-change');
    expect(change.find('s').exists()).toBe(false);
    expect(change.text()).toBe('£26.00');
  });
});
