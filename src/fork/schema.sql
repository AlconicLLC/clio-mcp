-- Neon (or any Postgres) table for the hosted audit sink.
-- Run once against the database in DATABASE_URL.
-- The MCP process never creates this table at startup.

CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  timestamp     timestamptz NOT NULL,
  session_id    text NOT NULL,
  machine_ip    text,
  user_id       text,
  request_id    text,
  tool          text NOT NULL,
  args          jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome       text NOT NULL,
  error_message text,
  clio_user_id  text,
  matter_id     integer,
  result_count  integer
);

CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx ON audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS audit_log_matter_idx    ON audit_log (matter_id);
CREATE INDEX IF NOT EXISTS audit_log_tool_idx      ON audit_log (tool);
CREATE INDEX IF NOT EXISTS audit_log_session_idx   ON audit_log (session_id);
