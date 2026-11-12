create table checkouts (
  id uuid primary key default gen_random_uuid(),
  stall_id uuid not null references stalls(id),
  trading_session_id uuid not null references trading_sessions(id),
  buyer_session_id uuid not null references buyer_sessions(id),
  state text not null check (state in ('creating','awaiting_approval','capturing','checking','paid','expired','cancelled','failed')),
  total_pence integer not null check (total_pence > 0),
  checkout_key text not null,
  create_request_id uuid not null unique,
  capture_request_id uuid not null unique,
  paypal_order_id text unique,
  reservation_deadline timestamptz not null,
  approved_at timestamptz,
  review_required boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now()
);
create unique index active_checkout_key on checkouts(buyer_session_id, checkout_key)
  where state in ('creating','awaiting_approval','capturing','checking');
create unique index one_buyer_reservation on checkouts(buyer_session_id)
  where state in ('creating','awaiting_approval','capturing','checking');
create table checkout_lines (
  checkout_id uuid not null references checkouts(id),
  item_id uuid not null references items(id),
  code text not null,
  name text not null,
  asking_pence integer not null check (asking_pence > 0),
  amount_pence integer not null check (amount_pence > 0),
  primary key (checkout_id,item_id)
);
create table captures (
  paypal_capture_id text primary key,
  checkout_id uuid not null references checkouts(id),
  amount_pence integer not null check (amount_pence > 0),
  currency text not null,
  status text not null,
  captured_at timestamptz,
  observed_at timestamptz not null default now(),
  webhook_verified_at timestamptz
);
create table events (
  id uuid primary key default gen_random_uuid(),
  stall_id uuid not null references stalls(id),
  trading_session_id uuid not null references trading_sessions(id),
  type text not null,
  payload jsonb not null,
  business_key text not null unique,
  created_at timestamptz not null default now()
);
alter table items add foreign key (reserved_checkout_id) references checkouts(id);
alter table items add foreign key (sold_checkout_id) references checkouts(id);
