import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from './App.vue';
import { routes } from './router.js';
enableAutoUnmount(afterEach);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const report = () => ({ sessionId: 'session', sessionStatus: 'closing', status: 'final', paymentAsOf: '2026-11-05T12:00:00Z', recordedSalesPence: 0, refundedPence: 0, paidCheckouts: 0, itemsSold: 0,
  items: [{ id: 'lamp', name: 'Brass lamp', code: 'K7Q2', seeded: true, observation: 'unknown', reason: null, refunded: false }],
  groups: [{ key: 'unsoldPresent', label: 'Unsold, still at the stall', items: [{ id: 'lamp', name: 'Brass lamp', code: 'K7Q2', seeded: true, observation: 'unknown', reason: null, refunded: false }] }], removed: [] });
const labels = { paidAbsent: 'Sold, gone with the buyer', takenAbsent: 'Taken free, gone with the taker', freeAbsent: 'Gone from the shelf, free item, nothing to pay', unsoldPresent: 'Unsold, still at the stall',
  unpaidAbsent: 'Not on the shelf, no confirmed payment. This record cannot say what happened.', unresolved: 'Payment unresolved' };
// Twelve items; the server lists the groups in its own order.
function observed(placement: Record<string, string>, extra: Partial<ReturnType<typeof report>> = {}) {
  const base = report();
  const items = Array.from({ length: 12 }, (_, n) => ({ id: `item${n}`, name: `Item ${n}`, code: `C${n}`, seeded: true, observation: 'unknown', reason: null, refunded: false }));
  const groups = Object.entries(labels).map(([key, label]) => ({ key, label, items: items.filter(item => placement[item.id] === key).map(({ id, name, code, seeded, observation, refunded }) => ({ id, name, code, seeded, observation, refunded })) }));
  return { ...base, status: 'final', items, groups, ...extra };
}
async function open(attachTo?: HTMLElement) {
  const router = createRouter({ routes, history: createMemoryHistory() });
  await router.push('/owner/closing'); await router.isReady();
  const wrapper = mount(App, { attachTo, global: { plugins: [router] } });
  await flushPromises(); return wrapper;
}
const button = (wrapper: Awaited<ReturnType<typeof open>>, label: string) => wrapper.findAll('button').find(entry => entry.text() === label)!;
it('says when the report is for an earlier session, and gives its closing time', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), sessionStatus: 'closed', status: 'final', earlierClosedAt: '2026-11-05T16:30:00Z' } })));
  const wrapper = await open();
  const line = wrapper.find('.earlier-session');
  expect(line.text()).toContain('earlier trading session');
  expect(line.text()).toContain('5 Nov, 16:30');
});
it('shows no earlier-session line for the current session\'s report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), earlierClosedAt: null } })));
  const wrapper = await open();
  expect(wrapper.find('.earlier-session').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('earlier trading session');
});
it('shows the server’s reason, and no match, when totals were not compared', async () => {
  const check = { checkedAt: '2026-11-05T12:00:00Z', localSalesPence: 0, paypalSalesPence: null, totalsAgree: null, totalsNote: 'There were no PayPal orders to check for this session.', ordersSkipped: 0, orders: [],
    transactions: { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal refused it for this app." } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: report() })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('There were no PayPal orders to check for this session.'); expect(wrapper.text()).not.toContain('matches');
});
it('shows the PayPal cross-check with its differences, and the transaction list in its own sentence', async () => {
  const check = { checkedAt: '2026-11-05T12:00:00Z', localSalesPence: 0, paypalSalesPence: 2800, totalsAgree: false, ordersSkipped: 0,
    orders: [{ orderId: 'O1', codes: 'K7Q2', inSession: true, outcome: 'capture_not_recorded', unresolved: true, note: 'PayPal shows a completed capture of £28.00 that this record has not confirmed.' }, { orderId: 'O2', codes: 'M2R9', inSession: true, outcome: 'agrees', unresolved: false, note: '' }],
    transactions: { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal refused it for this app." } };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: report() }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(fetcher.mock.calls[1]![0]).toBe('/api/owner/closing/paypal-check');
  const text = wrapper.text();
  for (const part of ['PayPal shows £28 for this session and the record shows £0.', 'K7Q2: PayPal shows a completed capture', '1 of 2 orders from this session agree with the record.', "PayPal's transaction list was not read: PayPal refused it for this app."]) expect(text).toContain(part);
  expect(text).not.toContain('Transaction Search');
  expect(text).not.toContain('Recorded sales have changed');
});
it('leaves out the unread transaction list when every order agrees and the totals match', async () => {
  const check = { checkedAt: '2026-11-05T12:00:00Z', localSalesPence: 2800, paypalSalesPence: 2800, totalsAgree: true, ordersSkipped: 0,
    orders: [{ orderId: 'O2', codes: 'M2R9', inSession: true, outcome: 'agrees', unresolved: false, note: '' }],
    transactions: { status: 'unavailable', note: "PayPal's transaction list was not read: PayPal could not list it just now." } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: { ...report(), recordedSalesPence: 2800 } })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain("PayPal's total for this session matches the recorded £28.");
  expect(wrapper.text()).not.toContain('transaction list was not read');
});
it('shows how many transactions PayPal listed and how many captures are not listed yet', async () => {
  const note = 'PayPal can take a few hours to list a new transaction, so a missing one is not a difference on its own.';
  const check = { checkedAt: '2026-11-08T17:34:00Z', localSalesPence: 2800, paypalSalesPence: 2800, totalsAgree: true, totalsNote: null,
    orders: [{ orderId: 'O1', codes: 'K7Q2', inSession: true, outcome: 'agrees', unresolved: false, note: 'PayPal and this record agree.' }],
    transactions: { status: 'ran', listed: 46, missing: 0, note } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: { ...report(), recordedSalesPence: 2800 } })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain(`${note} PayPal listed 46 transactions, with 0 recorded captures not listed yet.`);
});
it('leaves a cancelled basket order out of the session count, and keeps an unresolved one listed', async () => {
  const entry = (orderId: string, outcome: string, unresolved: boolean, inSession = true) => ({ orderId, codes: orderId, inSession, outcome, unresolved, note: `${orderId} note` });
  const check = { checkedAt: '2026-11-05T12:00:00Z', localSalesPence: 2800, paypalSalesPence: 2800, totalsAgree: true, totalsNote: null,
    orders: [entry('SOLD', 'agrees', false), entry('LEFT', 'no_capture', false), entry('OPEN', 'no_capture', true)],
    transactions: { status: 'unavailable', note: 'Listing did not run.' } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: report() })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('1 of 2 orders from this session agree'); expect(wrapper.text()).toContain('OPEN: OPEN note'); expect(wrapper.text()).not.toContain('LEFT note');
});
it('leaves an earlier session\'s order out of the agree count, and still lists one that needs attention', async () => {
  const entry = (orderId: string, outcome: string, unresolved: boolean, inSession: boolean) => ({ orderId, codes: orderId, inSession, outcome, unresolved, note: `${orderId} note` });
  const check = { checkedAt: '2026-11-05T12:00:00Z', localSalesPence: 5600, paypalSalesPence: 5600, totalsAgree: true, totalsNote: null,
    orders: [entry('SALE1', 'agrees', false, true), entry('SALE2', 'agrees', false, true), entry('REFUNDED', 'agrees', false, false), entry('STUCK', 'no_capture', true, false)],
    transactions: { status: 'unavailable', note: 'Listing did not run.' } };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ paypalCheck: check }) : Response.json({ closing: report() })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('2 of 2 orders from this session agree'); expect(wrapper.text()).not.toContain('of 4');
  expect(wrapper.text()).toContain('STUCK (earlier session): STUCK note'); expect(wrapper.text()).not.toContain('REFUNDED');
});
it('keeps the report and says so when the PayPal check cannot run', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'POST' ? Response.json({ error: 'The PayPal check could not run just now. The report above is unaffected.' }, { status: 502 }) : Response.json({ closing: report() })));
  const wrapper = await open();
  await button(wrapper, 'Check with PayPal').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('could not run just now'); expect(wrapper.text()).toContain('Brass lamp');
});
it('lists unaccounted-for and unresolved items before the other groups, and hides empty groups', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: observed({ item0: 'paidAbsent', item1: 'unsoldPresent', item2: 'unresolved', item3: 'unpaidAbsent' }) })));
  const wrapper = await open();
  const groupHeadings = wrapper.findAll('section h3, .unsold-group summary').map(heading => heading.text());
  expect(groupHeadings).toEqual([labels.unpaidAbsent, labels.unresolved, labels.paidAbsent, `${labels.unsoldPresent} (1)`]);
  // The unsold group is the long, quiet list, so it starts folded.
  expect((wrapper.find('details.unsold-group').element as HTMLDetailsElement).open).toBe(false);
  expect(wrapper.text()).not.toContain('No items in this group.');
  expect(wrapper.text()).toContain('Recorded sales');
});
it('does not lead the report with a free item gone from the shelf', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: observed({ item0: 'paidAbsent', item1: 'freeAbsent', item2: 'unpaidAbsent' }) })));
  const groupHeadings = (await open()).findAll('section h3').map(heading => heading.text());
  expect(groupHeadings).toEqual([labels.unpaidAbsent, labels.paidAbsent, labels.freeAbsent]);
});
it('shows the buyers-still-paying wording only on a provisional report while the session is closing', async () => {
  const provisional = observed({ item0: 'unresolved' }, { status: 'provisional' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: provisional })));
  expect((await open()).find('[role="status"]').text()).toContain('Buyers already paying can finish within their original deadline.');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...provisional, status: 'final', sessionStatus: 'closed' } })));
  const status = (await open()).find('[role="status"]').text();
  expect(status).toMatch(/^Final report · Payments checked .+\. Trading session closed\.$/);
});
it('lists price drops in the report with their old price, new price and reason', async () => {
  const priceDrops = [{ id: 'drop', name: 'Brass lamp', code: 'K7Q2', seeded: true, oldPence: 2800, newPence: 2400, reason: 'Plenty of views and no offers.', at: '2026-11-05T15:30:00Z' }];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), priceDrops } })));
  const wrapper = await open();
  expect(wrapper.find('[data-test=price-drops]').text()).toBe('Price dropsBrass lamp · K7Q2: £28 to £24. Plenty of views and no offers.');
});
it('leads the closing report with the AI summary and offers the PayPal check as an outlined button', async () => {
  const closing = observed({ item0: 'paidAbsent' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing, summary: 'One item sold.' })));
  const wrapper = await open();
  expect(wrapper.find('h1').text()).toBe('Closing report');
  expect(wrapper.findAll('h1, h2').map(heading => heading.text())).not.toContain('Closing');
  expect(wrapper.text()).toContain('The report is the record.');
  expect(wrapper.find('main section.card').text()).toContain('One item sold.');
  expect(wrapper.findAll('button.btn.sec').map(button => button.text())).toContain('Check with PayPal');
  expect(wrapper.text()).toContain("A payment record can't prove an item left the stall.");
  expect(wrapper.text()).not.toContain('Reads this stall');
});


it('reports at once with no shelf check: no row buttons, no Mark all, and the unsold item counts as still at the stall', async () => {
  const fetcher = vi.fn(async () => Response.json({ closing: report() })); vi.stubGlobal('fetch', fetcher);
  const wrapper = await open();
  expect(wrapper.find('.observations').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Mark all as seen'); expect(wrapper.text()).not.toMatch(/shelf check/i);
  expect(wrapper.text()).toContain('Final report'); expect(wrapper.text()).toContain('Unsold, still at the stall');
  expect(wrapper.text()).toContain('Brass lamp · K7Q2'); expect(wrapper.text()).not.toMatch(/matched/i);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('says the stall is open, that closing gives the report straight away, and links to the ledger, when no session has anything to report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: null, stallOpen: true })));
  const note = (await open()).find('.stall-open');
  expect(note.text()).toContain('Your stall is open'); expect(note.text()).toContain('report straight away');
  expect(note.find('a').attributes('href')).toBe('/owner/ledger');
});
it('flags an unsold item as not at the stall only when the owner chooses, and shows the saved result', async () => {
  const closing = report();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') {
      closing.items[0]!.observation = JSON.parse(String(init.body)).observation;
      closing.groups = [{ key: 'unpaidAbsent', label: labels.unpaidAbsent, items: [{ ...closing.items[0]! }] }];
    }
    return Response.json({ closing });
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = await open();
  expect(fetcher.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(0);
  expect(wrapper.find('details.exception summary').text()).toBe('Something missing?');
  await wrapper.find('[aria-label="Not at the stall: K7Q2"]').trigger('click'); await flushPromises();
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ sessionId: 'session', itemId: 'lamp', observation: 'absent' });
  expect(wrapper.text()).toContain(labels.unpaidAbsent);
  // The flag is confirmed where it was tapped, as the item has moved to a group at the top of the report.
  expect(wrapper.find('details.exception .exception-row').text()).toBe('Brass lamp flaggedUndo');
  await wrapper.find('[aria-label="Back at the stall: K7Q2"]').trigger('click'); await flushPromises();
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ sessionId: 'session', itemId: 'lamp', observation: 'unknown' });
});
it('undoes a flag from the row where it was tapped', async () => {
  const closing = report();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') {
      const observation = JSON.parse(String(init.body)).observation;
      closing.items[0]!.observation = observation;
      closing.groups = [{ key: observation === 'absent' ? 'unpaidAbsent' : 'unsoldPresent', label: observation === 'absent' ? labels.unpaidAbsent : labels.unsoldPresent, items: [{ ...closing.items[0]! }] }];
    }
    return Response.json({ closing });
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = await open();
  await wrapper.find('[aria-label="Not at the stall: K7Q2"]').trigger('click'); await flushPromises();
  await wrapper.find('[aria-label="Undo flag: K7Q2"]').trigger('click'); await flushPromises();
  expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ sessionId: 'session', itemId: 'lamp', observation: 'unknown' });
  expect(wrapper.find('details.exception .exception-row').text()).toBe('Brass lamp · K7Q2Not at the stall');
  expect(wrapper.text()).not.toContain(labels.unpaidAbsent);
});
it('shows a plain message and keeps the report when flagging an item fails', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => init?.method === 'PUT' ? Response.json({}, { status: 500 }) : Response.json({ closing: report() })));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const wrapper = await open();
  await wrapper.find('[aria-label="Not at the stall: K7Q2"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[role="alert"]').text()).toBe('That change could not be saved. Try again.');
  expect(wrapper.text()).toContain('Unsold, still at the stall');
});
it('offers no flag form for a session a reset closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), restocked: true } })));
  expect((await open()).find('details.exception').exists()).toBe(false);
});
it('shows refunds in the totals and the group, and acknowledgement changes no records', async () => {
  const closing = report(); closing.refundedPence = 400; closing.groups[0]!.items[0]!.refunded = true;
  const fetcher = vi.fn(async () => Response.json({ closing })); vi.stubGlobal('fetch', fetcher);
  const wrapper = await open();
  expect(wrapper.find('.metrics').text()).toContain('Refunded'); expect(wrapper.find('.unsold-group li').text()).toContain('Refunded');
  await wrapper.findAll('button').find(entry => entry.text() === 'Acknowledge check')!.trigger('click');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows the summary the server wrote, labelled as AI, with no button to write one', async () => {
  const summary = 'Final report. £0.00 recorded.\n\n- Consider a similar lamp.';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: report(), summary })));
  const wrapper = await open();
  expect(wrapper.text()).toContain('Final report. £0.00 recorded.'); expect(wrapper.text()).toContain('Consider a similar lamp.');
  expect(wrapper.text()).toContain('Written by an AI model from the closing report below');
  expect(wrapper.findAll('button').filter(entry => entry.text().startsWith('Write'))).toHaveLength(0);
});
it('renders summary lines starting with "- " or "* " as list items, and never as HTML', async () => {
  const summary = 'Two sales.\n- Restock <b>lamps</b>.\n* Check the stool.\n\nThat is all.';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: report(), summary })));
  const wrapper = await open();
  const card = wrapper.findAll('section.card').find(entry => entry.text().includes('Written by an AI model'))!;
  expect(card.findAll('li').map(entry => entry.text())).toEqual(['Restock <b>lamps</b>.', 'Check the stool.']);
  expect(card.find('b').exists()).toBe(false);
  expect(wrapper.text()).toContain('Two sales.'); expect(wrapper.text()).toContain('That is all.');
});
it('looks again shortly while the server is still writing the summary, then shows it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    let written = false;
    const fetcher = vi.fn(async () => Response.json(written ? { closing: report(), summary: 'Done.' } : { closing: report(), summaryPending: true }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = await open();
    expect(wrapper.text()).toContain('An AI model is writing a summary');
    written = true;
    await vi.advanceTimersByTimeAsync(3_000); await flushPromises();
    expect(wrapper.text()).toContain('Done.'); expect(wrapper.text()).not.toContain('is writing a summary');
  } finally { vi.useRealTimers(); }
});
it('shows no error and no button when there is no summary', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: report(), summary: null })));
  const wrapper = await open();
  expect(wrapper.text()).toContain('No summary this time. The closing report below has the figures.');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.findAll('button').filter(entry => entry.text().startsWith('Write'))).toHaveLength(0);
});
it('shows the plain report with no out-of-date notice when no summary matches the report', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: report(), summary: null, summaryPending: false })));
  const text = (await open()).text();
  expect(text).toContain('No summary this time. The closing report below has the figures.');
  expect(text).not.toContain('out of date');
});
it('says a reset restocked the shelf and lists only what was recorded', async () => {
  const item = { id: 'cb', name: 'Box of cookbooks', code: 'C0OK', seeded: true, observation: 'unknown', reason: null, refunded: false, taken: true, tipPence: 200, message: 'Thanks!' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), sessionStatus: 'closed', status: 'final', restocked: true, recordedSalesPence: 1200, paidCheckouts: 1, itemsSold: 1, earlierClosedAt: '2026-11-05T16:30:00Z',
    items: [item], groups: [{ key: 'taken', label: 'Taken free', items: [item] }] } })));
  const wrapper = await open();
  expect(wrapper.text()).toContain('Taken freeBox of cookbooks · C0OK · Tip £2');
  expect(wrapper.text()).toContain('Message from the buyer: Thanks!');
  expect(wrapper.find('.restocked').text()).toBe('A reset closed this session and restocked the shelf. The sales below are what was recorded before the reset.');
  expect(wrapper.text()).toContain('Recorded sales£12'); expect(wrapper.text()).not.toContain('Provisional report');
});
it('shows no restocked line for a session the owner closed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ closing: { ...report(), restocked: false } })));
  expect((await open()).find('.restocked').exists()).toBe(false);
});
