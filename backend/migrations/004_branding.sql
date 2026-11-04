-- 004: the organisation's branding (Admin → Branding): two colours and a logo, in one row. The
-- service checks every value; the checks here only keep a wrong write out. Branding changes are
-- audited in `audit` with no model id (model_id is already nullable), field names only.

create table if not exists branding (
  -- Exactly one row.
  id smallint primary key default 1 check (id = 1),
  primary_colour text check (primary_colour ~ '^#[0-9a-f]{6}$'),
  secondary_colour text check (secondary_colour ~ '^#[0-9a-f]{6}$'),
  logo bytea check (logo is null or octet_length(logo) between 1 and 307200),
  logo_type text check (logo_type in ('image/png', 'image/jpeg', 'image/webp')),
  version integer not null default 1 check (version >= 1),
  updated_by_id text,
  updated_by_name text,
  updated_at timestamptz not null default now(),
  check ((logo is null) = (logo_type is null))
);

insert into branding (id) values (1) on conflict (id) do nothing;
