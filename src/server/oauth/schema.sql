-- Tables for AUTH_MODE=oauth (Claude sign-in). Run once against DATABASE_URL:
--   psql "$DATABASE_URL" -f src/server/oauth/schema.sql
-- The MCP process never creates these at startup; it only checks they exist.
--
-- Nothing here is usable if leaked on its own: tokens are stored as SHA-256
-- hashes, and Clio tokens are AES-256-GCM ciphertext under ENCRYPTION_KEY,
-- bound to their clio_user_id. Times are Unix milliseconds.

CREATE TABLE IF NOT EXISTS oauth_users (
  clio_user_id  text PRIMARY KEY,
  email         text NOT NULL,
  clio_tokens   text NOT NULL,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_id      text PRIMARY KEY,
  clio_user_id  text NOT NULL REFERENCES oauth_users (clio_user_id) ON DELETE CASCADE,
  client_id     text NOT NULL,
  created_at    bigint NOT NULL,
  revoked_at    bigint
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash    text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id      text NOT NULL REFERENCES oauth_grants (grant_id) ON DELETE CASCADE,
  expires_at    bigint NOT NULL,
  used_at       bigint
);

CREATE INDEX IF NOT EXISTS oauth_grants_user_idx  ON oauth_grants (clio_user_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_exp_idx   ON oauth_tokens (expires_at);

-- To sign one person out everywhere:
--   UPDATE oauth_grants SET revoked_at = (extract(epoch from now()) * 1000)::bigint
--   WHERE clio_user_id = (SELECT clio_user_id FROM oauth_users WHERE email = 'name@yourfirm.com');
-- To remove them entirely (tokens and grants cascade):
--   DELETE FROM oauth_users WHERE email = 'name@yourfirm.com';
