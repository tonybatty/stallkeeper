create table trading_sessions (
  id uuid primary key default gen_random_uuid(),
  stall_id uuid not null references stalls(id),
  status text not null default 'open' check (status in ('open', 'closing', 'closed')),
  opened_at timestamptz not null default now(),
  cutoff_at timestamptz,
  closed_at timestamptz
);
create unique index one_unclosed_session on trading_sessions(stall_id) where status <> 'closed';

create table items (
  id uuid primary key default gen_random_uuid(),
  stall_id uuid not null references stalls(id),
  code text not null unique check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$'),
  name text not null,
  condition text not null,
  notes text not null,
  mode text not null check (mode in ('fixed', 'haggle')),
  asking_pence integer not null check (asking_pence > 0),
  price_version integer not null default 1,
  status text not null default 'available' check (status in ('available', 'sold', 'removed')),
  reserved_checkout_id uuid,
  reserved_until timestamptz,
  sold_checkout_id uuid,
  sold_at timestamptz,
  removed_at timestamptz,
  removed_reason text,
  seeded boolean not null default false,
  created_at timestamptz not null default now()
);
create index items_stall on items(stall_id);

-- Keeping the item preserves old printed URLs even after removal or sale (ADR 0002).
create function retain_item_code() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then raise exception 'Items must be removed, not deleted'; end if;
  if NEW.code <> OLD.code then raise exception 'Tag codes are immutable'; end if;
  return NEW;
end $$;
create trigger retain_item_code before update or delete on items for each row execute function retain_item_code();

create table item_floors (
  item_id uuid primary key references items(id),
  floor_pence integer not null check (floor_pence > 0)
);
create table buyer_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  turns_used integer not null default 0,
  created_at timestamptz not null default now()
);
