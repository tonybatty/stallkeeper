-- What PayPal said about each order the stall ledger read. A ledger read covers orders from any session, so it is kept by order,
-- not on one session's closing report. Only completed reads are stored, so a read that fails leaves the last one standing.
create table paypal_order_reads (
  stall_id uuid not null references stalls(id) on delete cascade,
  paypal_order_id text not null,
  outcome text not null check (outcome in ('agrees', 'differs', 'capture_not_recorded', 'capture_pending', 'no_capture')),
  read_at timestamptz not null,
  primary key (stall_id, paypal_order_id)
);
