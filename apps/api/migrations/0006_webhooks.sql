create table webhook_inbox (
  event_id text primary key,
  event_type text not null,
  raw_body text not null,
  state text not null default 'pending' check (state in ('pending','processed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index webhook_retry on webhook_inbox(next_attempt_at) where state='pending';
create table refunds (
  paypal_refund_id text primary key,
  paypal_capture_id text not null references captures(paypal_capture_id),
  amount_pence integer not null check (amount_pence > 0),
  status text not null,
  observed_at timestamptz not null default now()
);
