-- 020: properties defined by an Admin, for elements (every element type). One row per property:
-- the key that models store its values under (taken exactly), the name people see, its kind (text,
-- a choice from the options in their order, or a reference to other elements of the same model),
-- and whether it was added from the custom metadata in models and not yet saved by an Admin. Values
-- stay in the elements' metadata, so no model changes here.
--
-- In the same transaction, right after this file, the API's upgrade step for this migration adds a
-- property for every custom key found on elements in the stored models, named after its key: a
-- reference property when every value under the key is a reference, a text property otherwise. So
-- no element is left with custom metadata that isn't a property. The standard properties of every
-- element type and the reserved keys never become properties. The step runs only when this
-- migration does: once.

create table element_properties (
  key text primary key,
  -- Trimmed by the app, on one line, without braces; unique ignoring case (the app checks it).
  name text not null,
  kind text not null,
  -- A choice's options as a JSON list of texts, in order; null for text and reference.
  options jsonb,
  from_models boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint element_properties_key_length check (char_length(key) >= 1),
  constraint element_properties_key_not_reserved check (key not in ('type', '__proto__')),
  constraint element_properties_name_length check (char_length(name) between 1 and 60),
  constraint element_properties_kind check (kind in ('text', 'choice', 'reference')),
  constraint element_properties_options check (
    (kind = 'choice' and jsonb_typeof(options) = 'array')
    or (kind in ('text', 'reference') and options is null)
  )
);
