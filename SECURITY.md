# Security policy

## Reporting a vulnerability

Email **office@oktopeak.com** with the subject line `clio-mcp security`. Include the version (`npm ls @oktopeak/clio-mcp`), the transport you run (`stdio` or `http`), steps to reproduce, and what you believe the impact is. Please do not open a public GitHub issue for anything that could expose a firm's Clio data or tokens.

- We acknowledge reports within 3 business days.
- We aim to ship a fix within 30 days of confirming the issue, faster for anything that exposes tokens or client data.
- We ask for 90 days of coordinated disclosure from the first acknowledgement. We will credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest 2.x minor receives security fixes. Upgrade with `npm install -g @oktopeak/clio-mcp@latest` or bump the version in your Claude Desktop config.

## What is in scope

- The encrypted token file (`~/.clio-mcp/tokens.enc`) and the keychain-held encryption key.
- The audit log (`~/.clio-mcp/audit.log`): anything that lets client data reach it that the documented redaction rules say should not.
- The HTTP transport: the `MCP_API_KEY` gate, session isolation between concurrent users, and the OAuth callback.
- The OAuth flow against Clio (state handling, redirect URIs, token exchange).
- `AUTH_MODE=oauth`: the authorization server Claude signs in through (`/authorize`, `/token`, `/revoke`, the consent page, `/oauth/callback`), the Claude client allowlist, the email-domain and account checks, refresh-token rotation, session-to-user binding, and the encrypted token tables in Postgres.
- The `READ_ONLY` gate: any path that lets a write tool run while it is on.

## What is out of scope

- Clio's own API and web application (report those to Clio).
- Claude Desktop, Claude.ai, or other MCP clients.
- Issues that require an attacker to already control the machine or the user account the connector runs under.

## Hardening notes for operators

- Never run the HTTP transport with `MCP_ALLOW_UNAUTHENTICATED=true` on a host other people can reach.
- Keep `MCP_API_KEY` at 24 characters or more and rotate it when staff change.
- Set `READ_ONLY=true` if the firm has not decided to let Claude write to Clio yet.
- The audit log is append-only by convention, not by enforcement. Ship it to storage the firm controls if it has to survive a dispute.

### `AUTH_MODE=oauth` (Claude web, desktop, mobile)

- `ENCRYPTION_KEY` protects every attorney's Clio tokens in Postgres. Keep it only in the host's secret store, never in the database or the repository. Anyone with both the key and a database dump can act as every signed-in attorney until their Clio tokens are revoked. Rotating the key signs everyone out (their stored Clio tokens can no longer be decrypted), which is also the emergency response to a suspected leak.
- Set `ALLOWED_EMAIL_DOMAINS` to the firm's own domains only. Add `CLIO_ALLOWED_ACCOUNT_ID` if staff could have Clio users on other accounts under the same domain.
- Give the database role only what the server needs on the three `oauth_*` tables. The server never runs DDL.
- When someone leaves, revoke them with the statements at the bottom of `src/server/oauth/schema.sql` and deactivate their Clio user. Either one is enough to stop access; do both.
- Serve only over HTTPS (the server refuses a non-loopback `http://` base URL in this mode) and set `TRUST_PROXY_HOPS` to the real number of proxies, so rate limits cannot be dodged with a forged `X-Forwarded-For`.
- Sign-ins in progress and authorization codes live in memory. Run a single replica, or put sticky sessions in front of several.
