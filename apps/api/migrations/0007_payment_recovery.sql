alter table checkouts add column capture_started_at timestamptz;
update checkouts set capture_started_at=coalesce(approved_at,created_at)
  where state in ('capturing','checking');
