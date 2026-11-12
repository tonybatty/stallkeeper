-- A fourth pricing mode. A free item is taken with no PayPal step, so a take is its own record and never a checkout.
-- The suggested tip lives in asking_pence, like the suggested amount of a pay-what-you-want item.
alter table items drop constraint items_mode_check;
alter table items add constraint items_mode_check check (mode in ('fixed', 'haggle', 'pwyw', 'free'));

-- A tip is an ordinary checkout on an item that has already been taken. It never reserves or sells the item.
alter table checkouts add column kind text not null default 'sale' check (kind in ('sale', 'tip'));
drop index one_buyer_reservation;
create unique index one_buyer_reservation on checkouts(buyer_session_id)
  where kind = 'sale' and state in ('creating','awaiting_approval','capturing','checking');

-- One row per taken item. The message is the taker's own text, kept here and never on items, so no model prompt reads it.
-- A later owner's note to the taker can sit beside it as another column, keyed by the same buyer session.
create table free_takes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null unique references items(id),
  stall_id uuid not null references stalls(id),
  trading_session_id uuid not null references trading_sessions(id),
  buyer_session_id uuid not null references buyer_sessions(id),
  message text check (message is null or char_length(message) between 1 and 280),
  taken_at timestamptz not null default now()
);
create index free_takes_session on free_takes(trading_session_id);
