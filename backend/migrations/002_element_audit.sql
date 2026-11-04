-- 002: audit rows for element changes (Modelling). Who is recorded by id and by the display name
-- in the session at the time; what by the element id and the names of the changed fields (in
-- details), never their values. Idempotent: it can run again on a schema that already has it.

alter table audit add column if not exists user_name text;
alter table audit add column if not exists element_id text;

create index if not exists audit_model_element on audit (model_id, element_id);
