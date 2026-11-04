-- 005: the signed licence and the latest time seen, in one row. The licence file is stored as it
-- came and verified again on every read; nothing here is trusted. The time is in milliseconds, so
-- several containers compare it exactly (raised with GREATEST, see licence/licence-store.ts).
-- Uploads are audited in `audit` with no model id.

create table if not exists licence (
  -- Exactly one row.
  id smallint primary key default 1 check (id = 1),
  licence_file text check (octet_length(licence_file) <= 16384),
  latest_time_seen_ms bigint check (latest_time_seen_ms >= 0),
  updated_at timestamptz not null default now()
);

insert into licence (id) values (1) on conflict (id) do nothing;
