-- 003: audit rows for relationship changes (Modelling) name the relationship by its id, beside
-- element_id for element changes. Idempotent: it can run again on a schema that already has it.

alter table audit add column if not exists relationship_id text;

create index if not exists audit_model_relationship on audit (model_id, relationship_id);
