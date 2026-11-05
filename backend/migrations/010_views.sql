-- 010: views. A view is a named, stored set of elements and relationships of one model. It only
-- refers to them: a view never changes the model, and deleting a view leaves them alone. Card
-- positions and canvas settings aren't stored. Views aren't part of a model's JGF export.
--
-- Every row of a view carries its model's id, so the foreign keys keep a view to its own model and
-- keep it consistent on their own: deleting a model deletes its views, and deleting an element or
-- a relationship removes it from every view (on delete cascade).

create table views (
  id uuid primary key,
  model_id uuid not null references models (id) on delete cascade,
  name text not null,
  version integer not null default 1,
  created_at timestamptz not null,
  created_by_id text not null,
  created_by_name text not null,
  updated_at timestamptz not null,
  updated_by_id text not null,
  updated_by_name text not null,
  -- The key the view's own rows refer to, with the model's id.
  unique (id, model_id)
);

create index views_model on views (model_id);

-- One row per element in a view, keyed as elements are: by the model's id and the element's id.
create table view_elements (
  view_id uuid not null,
  model_id uuid not null,
  element_id text not null,
  primary key (view_id, element_id),
  foreign key (view_id, model_id) references views (id, model_id) on delete cascade,
  foreign key (model_id, element_id) references elements (model_id, id) on delete cascade
);

-- For the cascade when an element is deleted.
create index view_elements_element on view_elements (model_id, element_id);

-- One row per relationship in a view, keyed as relationships are: by the model's id and the
-- relationship's ordinal, which never changes while the relationship exists (a JGF edge id is
-- optional, so it isn't a key). The API speaks in relationship ids, so only relationships with an
-- id are ever added.
create table view_relationships (
  view_id uuid not null,
  model_id uuid not null,
  relationship_ordinal integer not null,
  primary key (view_id, relationship_ordinal),
  foreign key (view_id, model_id) references views (id, model_id) on delete cascade,
  foreign key (model_id, relationship_ordinal)
    references relationships (model_id, ordinal) on delete cascade
);

-- For the cascade when a relationship is deleted.
create index view_relationships_relationship
  on view_relationships (model_id, relationship_ordinal);

-- Audit rows for view changes name the view by its id, beside element_id and relationship_id.
alter table audit add column if not exists view_id uuid;

create index if not exists audit_model_view on audit (model_id, view_id);
