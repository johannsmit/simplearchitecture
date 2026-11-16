-- 016: properties defined by an Admin, for relationships (Relation). One row per property: the key
-- that models store its values under (taken exactly), the name people see, its kind (text, or a
-- choice from the options in their order), and whether it was added from the custom metadata in
-- models and not yet saved by an Admin. Values stay in the relationships' metadata, so no model
-- changes here.
--
-- In the same transaction, right after this file, the API's upgrade step for this migration adds a
-- text property for every custom key found on relationships in the stored models, named after its
-- key, so no relationship is left with custom metadata that isn't a property. Standard, reserved and
-- retired keys never become properties. The step runs only when this migration does: once.

create table relationship_properties (
  key text primary key,
  -- Trimmed by the app, on one line, without braces; unique ignoring case (the app checks it).
  name text not null,
  kind text not null,
  -- A choice's options as a JSON list of texts, in order; null for text.
  options jsonb,
  from_models boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint relationship_properties_key_length check (char_length(key) >= 1),
  constraint relationship_properties_name_length check (char_length(name) between 1 and 60),
  constraint relationship_properties_kind check (kind in ('text', 'choice')),
  constraint relationship_properties_options check (
    (kind = 'choice' and jsonb_typeof(options) = 'array')
    or (kind = 'text' and options is null)
  )
);
