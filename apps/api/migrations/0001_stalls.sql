create table stalls (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location_label text not null,
  is_demo boolean not null
);

-- Each login password maps to one of these two rows through is_demo (ADR 0006).
create unique index stalls_one_per_kind on stalls (is_demo);

insert into stalls (name, location_label, is_demo) values
  ('Front-garden stall', 'Front garden', false),
  ('Demo stall', 'Online demo', true);
