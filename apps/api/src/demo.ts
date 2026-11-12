import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { active, transaction } from './checkouts.js';
import { availability, buyerAsking, newItemCode, type newItemLimit } from './items.js';
import { buyerCharity } from './charity.js';
import type { RetailService } from './retail.js';

// Keep the stock list stable across resets. The buyer shortcut separately prefers an available item with a saved reference so judges see a "New from" price.
// `retailProductId` is a Channel3 product we picked for the seeded item, so its item page shows a real "New from" line without the owner searching. It is not a photo match.
// `lowest` opts a fixed-price item into price drops with that lowest price. Haggle items allow them by default.
// `views` is a seeded starting count, so a price review has something to read straight after a reset. Only the review prompt tells the model these views are not real visitors; no screen or drop reason marks them as seeded.
const stock: Array<{ name: string; illustration: string; asking: number; floor?: number; lowest?: number; views?: number; pwyw?: boolean; free?: boolean; notes: string; retailProductId?: string }> = [
  { name: 'Brass desk lamp', illustration: 'lamp', asking: 2800, floor: 1800, views: 14, notes: 'Tested, it works. Small scuff on the base. Takes a standard screw bulb.' },
  { name: 'Film camera', illustration: 'camera', asking: 4500, floor: 3000, views: 18, notes: 'Not tested with film. Shutter clicks. No film or batteries included.' },
  { name: 'Paperbacks, set of four', illustration: 'books', asking: 1000, notes: 'Read, with creased spines. Four gardening books, sold as one set.' },
  { name: 'Terracotta plant pot', illustration: 'pot', asking: 1000, notes: 'Used, no cracks. Empty pot, 25 cm diameter. Drainage hole in the base.' },
  { name: 'Vinyl records, set of six', illustration: 'records', asking: 3000, floor: 2000, views: 12, notes: 'Used, light marks on sleeves. Six records sold as one set. Playback not tested.' },
  { name: 'Blue ceramic vase', illustration: 'vase', asking: 1200, lowest: 800, views: 9, notes: 'Good used condition. 20 cm tall. No chips seen.' },
  { name: 'Woven basket', illustration: 'basket', asking: 1400, lowest: 900, views: 16, notes: 'Used, handles intact. 35 cm wide. Empty basket.' },
  { name: 'Wall clock', illustration: 'clock', asking: 1600, floor: 1100, notes: 'Tested, it works. 30 cm across. Uses one AA battery, not included.' },
  { name: 'Round wall mirror', illustration: 'mirror', asking: 1800, floor: 1200, views: 3, notes: 'Good used condition. 40 cm across. Hanging wire included.', retailProductId: 'w33nMA4' },
  { name: 'Wooden stool', illustration: 'stool', asking: 2200, floor: 1500, views: 2, notes: 'Sturdy, with marks on the seat. 45 cm high. Solid wood.', retailProductId: 'CGSjnDZ' },
  { name: 'Watering can', illustration: 'watering-can', asking: 1000, notes: 'Used, holds water. Two litres. Detachable rose included.' },
  { name: 'Ceramic mugs, pair', illustration: 'mugs', asking: 1200, notes: 'Good used condition. Two mugs sold together. No chips seen.' },
  // Pay what you want: the figure is only the owner's expected amount, which buyers never see, and no minimum is set, so a judge's first amount is never refused.
  { name: 'Garden seed tins', illustration: 'pot', asking: 500, pwyw: true, notes: 'Empty, clean tins. Four small tins with lids. Handy for seeds or screws.' },
  // Free: taken with no PayPal step. The figure is only the owner's expected tip, which buyers never see. A tip is the buyer's own amount, or none.
  { name: 'Box of cookbooks', illustration: 'books', asking: 200, free: true, notes: 'Well used, all pages present. A box of old cookbooks, free to a good home. Some pages have splashes.' },
];
// How long the demo stall may sit closed, or with no item that takes offers, before the repair timer resets it. Judges close the
// stall as part of What to try, so without this the next visitor meets closed items until someone presses the reset button.
// Flagging an item as not at the stall, payment activity and new stock on a closed stall restart the window. The web copy and the capture tooling read it from /api/demo.
export const demoIdleResetMs = 20 * 60_000;
const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function localTime(date: Date) {
  const parts = Object.fromEntries(london.formatToParts(date).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

type Query = Pick<Pool, 'query'>;
// When the demo stall last had something going on while it could not take offers, or null while it can. A visitor needs
// an available item that takes offers, so a closed stall, or an open one whose haggle items are all sold, removed or held, counts.
async function idleSince(db: Query, stallId: string) {
  const session = (await db.query<{ id: string; status: string; opened_at: Date; cutoff_at: Date | null; closed_at: Date | null }>(
    'select id,status,opened_at,cutoff_at,closed_at from trading_sessions where stall_id=$1 order by opened_at desc,id desc limit 1', [stallId])).rows[0];
  // Every reset opens a session, so a stall with none has not been closed by anyone. The nightly reset and an owner's button cover it.
  if (!session) return null;
  const times: Array<Date | null> = [session.opened_at];
  if (session.status === 'open') {
    const open = (await db.query<{ count: number }>("select count(*)::integer as count from items where stall_id=$1 and mode='haggle' and status='available' and reserved_checkout_id is null", [stallId])).rows[0]!.count;
    if (open) return null;
    const left = (await db.query<{ at: Date | null }>("select greatest(max(sold_at),max(removed_at)) as at from items where stall_id=$1 and mode='haggle'", [stallId])).rows[0]!;
    times.push(left.at);
  } else {
    // A judge flagging an item in the closing report keeps the whole window: each flag restarts it.
    const checked = (await db.query<{ at: Date | null }>('select max(sc.observed_at) as at from shelf_checks sc join closings c on c.id=sc.closing_id where c.trading_session_id=$1', [session.id])).rows[0]!;
    // An owner adding stock is using the stall, and a reset would remove what they just added. Seeded stock arrives with the session opened above.
    const added = (await db.query<{ at: Date | null }>('select max(created_at) as at from items where stall_id=$1 and not seeded', [stallId])).rows[0]!;
    times.push(session.cutoff_at, session.closed_at, checked.at, added.at);
  }
  const payment = (await db.query<{ at: Date | null }>('select greatest(max(created_at),max(approved_at)) as at from checkouts where stall_id=$1', [stallId])).rows[0]!;
  times.push(payment.at);
  return new Date(Math.max(...times.flatMap(time => time ? [time.getTime()] : [])));
}

export function demoStall(db: Pool, now: () => Date, notify: (stallId: string) => void, retail: RetailService, logWarning: (errorType: string) => void, newItems: ReturnType<typeof newItemLimit>) {
  // Looks up the saved references after the reset has committed, so a slow or failing Channel3 cannot roll it back or leave the stall without stock. The reset call does wait for the lookup, three seconds at most.
  // Not counted against `allowLookup`: that is the owner's hourly allowance, which a visitor looping the public reset would use up, and Channel3 lists /products as free, so a reset spends no credits (https://docs.trychannel3.com/pricing).
  // An item without one shows no "New from" line. The buyer page refreshes a saved one the same way as an owner's.
  async function addReferences(items: Array<{ id: string; productId: string }>) {
    if (!retail.enabled) return;
    await Promise.all(items.map(async ({ id, productId }) => {
      try {
        const reference = await retail.reference(productId, { timeoutInSeconds: 3, doubtful: false });
        if (reference) await db.query("update items set retail_ref=$2 where id=$1 and status='available' and retail_ref is null", [id, JSON.stringify(reference)]);
      } catch (error) {
        logWarning(error instanceof Error ? error.name : 'Unknown');
      }
    }));
  }
  async function reset(stallId: string, trigger: 'owner' | 'nightly' | 'idle' = 'owner') {
    const withReference: Array<{ id: string; productId: string }> = [];
    const result = await transaction(db, async tx => {
      const stall = (await tx.query<{ id: string; demo_reset_at: Date | null }>('select id,demo_reset_at from stalls where id=$1 and is_demo=true for no key update', [stallId])).rows[0];
      if (!stall) return 'forbidden' as const;
      const time = now();
      const local = localTime(time);
      // Persist the last reset so process restarts and both DST changes cannot repeat a night's reset.
      if (trigger === 'nightly' && stall.demo_reset_at) {
        const last = localTime(stall.demo_reset_at);
        if (local.hour < 3 || last.day > local.day || (last.day === local.day && last.hour >= 3)) return 'unchanged' as const;
      }
      // Admission locks this same session before reserving stock. Checkouts lock before items in payment evidence handling.
      await tx.query("select id from trading_sessions where stall_id=$1 and status <> 'closed' for update", [stallId]);
      // Checked under the session lock, so a buyer who reserves stock a moment before the reset keeps the stall as it is.
      if (trigger === 'idle') {
        const since = await idleSince(tx, stallId);
        if (!since || time.getTime() - since.getTime() < demoIdleResetMs) return 'unchanged' as const;
      }
      const checkouts = await tx.query<{ busy: boolean }>(`select state in ${active} and not review_required as busy from checkouts where stall_id=$1 order by id for update`, [stallId]);
      if (checkouts.rows.some(c => c.busy)) return 'busy' as const;
      await tx.query("update trading_sessions set status='closed',cutoff_at=coalesce(cutoff_at,$2),closed_at=$2,closed_by=coalesce(closed_by,'demo_reset') where stall_id=$1 and status <> 'closed'", [stallId, time]);
      await tx.query(`update items set status='removed',removed_at=$2,removed_reason='Stall reset' where stall_id=$1 and status <> 'removed'
        and id not in (select l.item_id from checkout_lines l join checkouts c on c.id=l.checkout_id where c.stall_id=$1 and c.review_required)`, [stallId, time]);
      for (const item of stock) {
        let id: string | undefined;
        for (let attempt = 0; attempt < 100 && !id; attempt++) {
          id = (await tx.query<{ id: string }>(`insert into items(stall_id,code,name,notes,mode,asking_pence,seeded,illustration,price_drops,seeded_views)
            values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9) on conflict(code) do nothing returning id`,
          [stallId, newItemCode(), item.name, item.notes, item.free ? 'free' : item.pwyw ? 'pwyw' : item.floor ? 'haggle' : 'fixed', item.asking, item.illustration, !!(item.floor ?? item.lowest), item.views ?? 0])).rows[0]?.id;
        }
        if (!id) throw new Error('Unable to allocate demo tag code');
        if (item.floor ?? item.lowest) await tx.query('insert into item_floors(item_id,floor_pence) values ($1,$2)', [id, item.floor ?? item.lowest]);
        if (item.retailProductId) withReference.push({ id, productId: item.retailProductId });
      }
      const session = (await tx.query<{ id: string }>('insert into trading_sessions(stall_id,opened_at) values ($1,$2) returning id', [stallId, time])).rows[0]!;
      await tx.query("insert into session_stock select $1,id from items where stall_id=$2 and status='available'", [session.id, stallId]);
      await tx.query('update stalls set demo_reset_at=$2,charity_name=null,charity_percent=null,closing_time=null where id=$1', [stallId, time]);
      return 'reset' as const;
    });
    if (result === 'reset') {
      newItems.clear(stallId);
      await addReferences(withReference);
      notify(stallId);
    }
    return result;
  }
  async function repair() {
    const stall = (await db.query<{ id: string }>('select id from stalls where is_demo=true')).rows[0];
    if (!stall) return;
    if (await reset(stall.id, 'nightly') === 'unchanged') await reset(stall.id, 'idle');
  }
  return { reset, repair };
}

export async function demoRoutes(app: FastifyInstance, db: Pool, config: {
  publicBaseUrl: string; demoOwnerPassword: string; demoBuyerEmail?: string; demoBuyerPassword?: string; demoFilmUrl?: string; demoRepoUrl?: string;
}) {
  app.get('/api/demo', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const stall = (await db.query<{ id: string; name: string }>('select id,name from stalls where is_demo=true')).rows[0]!;
    // A reset keeps items behind a flagged payment so the owner can review them. They are not stock, so list only the stock of the unclosed session, or of the last one while the stall is closed. That includes what sold in it.
    const { rows } = await db.query<{ code: string; name: string; mode: 'fixed' | 'haggle' | 'pwyw' | 'free'; asking_pence: number | null; status: 'available' | 'sold' | 'removed'; illustration: string | null; seeded: boolean; reserved_checkout_id: string | null; session_status: string | null; retail_ref: unknown }>(`select i.code,i.name,i.mode,i.asking_pence,i.status,i.illustration,i.seeded,i.reserved_checkout_id,i.retail_ref,t.status as session_status
      from items i
      join (select id,status from trading_sessions where stall_id=$1 order by status='closed', opened_at desc limit 1) t on true
      join session_stock s on s.item_id=i.id and s.trading_session_id=t.id
      where i.stall_id=$1 and i.status <> 'removed'`, [stall.id]);
    // Every seeded item shares one insert time and a random id, so the database order changes at each reset. Order by the seed list instead, with items that take offers first, so a judge meets the AI stallholder before the fixed-price items.
    const seedRank = (name: string) => { const index = stock.findIndex(seed => seed.name === name); return index < 0 ? stock.length : index; };
    rows.sort((a, b) => Number(b.mode === 'haggle') - Number(a.mode === 'haggle') || seedRank(a.name) - seedRank(b.name) || a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
    return {
      name: stall.name, charity: await buyerCharity(db, stall.id),
      filmUrl: config.demoFilmUrl ?? null, repoUrl: config.demoRepoUrl ?? null,
      buyer: config.demoBuyerEmail && config.demoBuyerPassword ? { email: config.demoBuyerEmail, password: config.demoBuyerPassword } : null,
      owner: { loginUrl: '/owner/login', password: config.demoOwnerPassword },
      reset: { schedule: '03:00 Europe/London', idleMinutes: demoIdleResetMs / 60_000 },
      // Every listed item shares the one session, so any row tells whether the stall is open. The demo page hides its reset link while it is.
      open: rows[0]?.session_status === 'open',
      items: await Promise.all(rows.map(async item => {
        const url = new URL(`/i/${item.code}`, config.publicBaseUrl).href;
        return { code: item.code, name: item.name, mode: item.mode, askingPence: buyerAsking(item), seeded: item.seeded, illustration: item.illustration,
          availability: availability(item), newFrom: item.retail_ref != null,
          url, qrPng: await QRCode.toDataURL(url, { margin: 4, scale: 6, errorCorrectionLevel: 'M' }) };
      })),
    };
  });
}
