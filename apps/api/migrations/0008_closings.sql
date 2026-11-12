create table session_stock (
  trading_session_id uuid not null references trading_sessions(id),
  item_id uuid not null references items(id),
  primary key (trading_session_id,item_id)
);
insert into session_stock
select s.id,i.id from trading_sessions s join items i on i.stall_id=s.stall_id
where (i.created_at <= s.opened_at and (i.sold_at is null or i.sold_at >= s.opened_at)
  and (i.removed_at is null or i.removed_at >= s.opened_at))
  or (i.created_at > s.opened_at and (s.closed_at is null or i.created_at <= s.closed_at));

create table closings (
  id uuid primary key default gen_random_uuid(),
  trading_session_id uuid not null unique references trading_sessions(id),
  status text not null default 'provisional' check (status in ('provisional','final')),
  payment_as_of timestamptz not null default now(),
  totals jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table shelf_checks (
  closing_id uuid not null references closings(id),
  item_id uuid not null references items(id),
  observation text not null default 'unknown' check (observation in ('unknown','present','absent','removed')),
  reason text,
  observed_at timestamptz,
  took_off_sale boolean not null default false,
  primary key (closing_id,item_id),
  check ((observation='removed' and length(trim(reason)) > 0 and reason is not null)
    or (observation <> 'removed' and reason is null))
);
