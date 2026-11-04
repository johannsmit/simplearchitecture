-- 006: two relationship types, Relation and Contains (Sprint 29). Information flow becomes a
-- yes-or-no property of a Relation, stored as "informationFlow": true. Only the type, and that one
-- key, change: id, order, ends, direction, label, version and all other metadata stay as they are.
-- A model is read as the JGF these rows rebuild, and it holds no copy of the types elsewhere.
-- It can't be undone without a backup. An older API refuses the database afterwards.

-- A relationship with no metadata (SQL null, or a JSON null) gets an object holding the key.
-- Metadata of any other shape is left alone: such a model fails validation with or without this.
update relationships
set relation = 'Relation',
    metadata = case
      when metadata is null or jsonb_typeof(metadata) = 'null'
        then '{"informationFlow": true}'::jsonb
      when jsonb_typeof(metadata) = 'object'
        then metadata || '{"informationFlow": true}'::jsonb
      else metadata
    end
where relation = 'Information flow';

update relationships
set relation = 'Relation'
where relation = 'Integration';
