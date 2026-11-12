-- A stall can pledge a whole-number percentage of a session's recorded sales to a named charity.
-- Both columns are set together or both are null.
alter table stalls
  add column charity_name text check (charity_name is null or (length(trim(charity_name)) between 1 and 80)),
  add column charity_percent integer check (charity_percent is null or charity_percent between 1 and 100),
  add constraint charity_set_together check ((charity_name is null) = (charity_percent is null));

-- The pledge a session traded under, so a later edit to the stall's pledge cannot rewrite its closing report.
alter table trading_sessions
  add column charity_name text,
  add column charity_percent integer,
  add constraint session_charity_set_together check ((charity_name is null) = (charity_percent is null));

-- Donations made through PayPal's Donate button. They never touch captures, refunds or the sales totals.
-- The button's completion callback comes from the owner's browser, so a row records what the button reported.
create table charity_donations (
  paypal_transaction_id text primary key,
  trading_session_id uuid not null references trading_sessions(id),
  amount_pence integer not null check (amount_pence > 0),
  currency text not null,
  recorded_at timestamptz not null default now()
);
create index charity_donations_session on charity_donations(trading_session_id);

-- The demo stall shows the feature to judges. This pledge is seeded, and the app labels it so.
update stalls set charity_name='Sample Charity', charity_percent=10 where is_demo;
update trading_sessions t set charity_name=s.charity_name, charity_percent=s.charity_percent
  from stalls s where s.id=t.stall_id and s.is_demo and t.status <> 'closed';
