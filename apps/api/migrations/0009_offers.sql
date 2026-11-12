create table offers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id),
  buyer_session_id uuid not null references buyer_sessions(id),
  message_id bigint not null unique references chat_messages(id),
  round integer not null check (round > 0),
  amount_pence integer not null check (amount_pence > 0),
  outcome text not null check (outcome in ('accept','counter','above_asking')),
  created_at timestamptz not null default now()
);
create index offers_round on offers(buyer_session_id,item_id,round);
create table offer_cards (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null unique references offers(id),
  item_id uuid not null references items(id),
  buyer_session_id uuid not null references buyer_sessions(id),
  amount_pence integer not null check (amount_pence > 0),
  price_version integer not null,
  status text not null default 'open' check (status in ('open','agreed','superseded','expired')),
  expires_at timestamptz not null,
  agreed_at timestamptz
);
create unique index one_open_card on offer_cards(buyer_session_id,item_id) where status='open';
alter table checkouts add column offer_card_id uuid references offer_cards(id);
