-- 022: the app's own log entries, for Admin > Logs and the get_logs agent tool. Each is a line the
-- logger wrote, after its redaction, so credentials are already [Redacted]; the writer also blanks
-- any field named like a credential. Kept for 30 days: older entries are removed as new ones come.

create table app_logs (
  id bigint generated always as identity primary key,
  time timestamptz not null,
  -- The logger's level number: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
  level smallint not null check (level between 10 and 60),
  msg text not null check (char_length(msg) <= 2000),
  -- The entry's other fields, as a JSON object.
  extra jsonb not null check (jsonb_typeof(extra) = 'object')
);

create index app_logs_time on app_logs (time);
