-- Local Europe/London time. With none set, no price review runs by itself.
alter table stalls add column closing_time text check (closing_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

alter table items add column price_drops boolean not null default false;
update items set price_drops = true where mode = 'haggle';
-- A demo stall has had no visitors after a reset, so its stock carries a labelled starting count for the review to read.
alter table items add column seeded_views integer not null default 0;

create table item_views (
  item_id uuid not null references items(id),
  buyer_session_id uuid not null references buyer_sessions(id),
  first_viewed_at timestamptz not null default now(),
  primary key (item_id, buyer_session_id)
);
