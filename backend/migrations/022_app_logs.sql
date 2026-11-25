-- 022: the application's log lines (Admin > Logs, and the get_logs MCP tool), kept for 30 days.
-- Each line is the JSON line the API writes to standard output, after its redaction, so it holds
-- no credentials. The app prunes older lines itself.

create table app_logs (
  id bigserial primary key,
  logged_at timestamptz not null,
  -- The logger's level: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal.
  level smallint not null,
  msg text,
  line jsonb not null
);

create index app_logs_logged_at on app_logs (logged_at);
