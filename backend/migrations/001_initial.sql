-- 001: the first schema. Models with their elements and relationships, the audit trail and
-- sessions. JGF stays the exchange format: a model's export is rebuilt exactly from these rows.

create table models (
  id uuid primary key,
  name text not null,
  -- The ISO 8601 text the API wrote (as in the JGF files), so it round-trips exactly and sorts
  -- the same way as before.
  created_at text not null,
  created_by_id text not null,
  created_by_name text not null,
  node_count integer not null check (node_count >= 0),
  edge_count integer not null check (edge_count >= 0),
  -- The client's own graph.id, cut short.
  source_id text,
  -- Top-level graph fields without a column of their own (label, directed, type, ...).
  graph jsonb not null default '{}'::jsonb check (jsonb_typeof(graph) = 'object'),
  -- The client's graph.metadata, without the server's own entry (rebuilt from the columns).
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  -- Whether the document had a nodes object and an edges list (an empty one is kept as such).
  has_nodes boolean not null,
  has_edges boolean not null,
  version integer not null default 1,
  stored_at timestamptz not null default now()
);

create index models_created_at on models (created_at desc, id);

-- One row per JGF node. The node's key is its id; ordinal keeps the document's order.
create table elements (
  model_id uuid not null references models (id) on delete cascade,
  id text not null,
  ordinal integer not null,
  -- metadata.type, when it is text. metadata holds the rest of the node's metadata.
  type text,
  label text,
  metadata jsonb,
  -- Any other fields of the node, kept as they were.
  extra jsonb,
  version integer not null default 1,
  primary key (model_id, id)
);

create unique index elements_model_ordinal on elements (model_id, ordinal);
create index elements_model_type on elements (model_id, type);

-- One row per JGF edge, in the document's order. JGF edge ids are optional.
create table relationships (
  model_id uuid not null references models (id) on delete cascade,
  ordinal integer not null,
  id text,
  source text,
  target text,
  relation text,
  directed boolean,
  label text,
  metadata jsonb,
  extra jsonb,
  version integer not null default 1,
  primary key (model_id, ordinal)
);

-- Neighbourhood (edges at an element) and containment (Contains edges from or to an element).
create index relationships_model_source on relationships (model_id, source, relation);
create index relationships_model_target on relationships (model_id, target, relation);
create index relationships_model_id on relationships (model_id, id) where id is not null;

-- Who did what, by id and counts only (never names or model content). No foreign key: the trail
-- outlives a deleted model.
create table audit (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  action text not null,
  user_id text,
  model_id uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index audit_occurred_at on audit (occurred_at);

-- Server-side sessions. Only a SHA-256 hash of the session id is stored, never the id itself.
create table sessions (
  id_hash text primary key,
  user_data jsonb not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null
);

create index sessions_last_seen_at on sessions (last_seen_at);
create index sessions_created_at on sessions (created_at);
