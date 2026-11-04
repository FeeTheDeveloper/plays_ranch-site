# Plays Ranch MCP Connector v1 — engineering handoff

| Field | Value |
|---|---|
| Handoff ID | PR-MCP-V1-20261104 |
| Date | 2026-11-04 |
| Originating workspace | Fee The Developer Main (Claude) |
| Receiving workspace | King Fee (approval), then Hutchrok/ChatGPT for skill wiring |
| Company | Plays Ranch |
| Repository / branch | `feethedeveloper/plays_ranch-site` / `feat/mcp-connector-v1` |
| Service path | `connector/` (separate deployable service; the public site is unchanged) |
| Status | ACCEPTED: stack approved (Clerk, Cloudflare Workers, Supabase). Code is Workers-ready. Deploy is blocked on Cloudflare deploy credentials and a Supabase organization. See [mcp-connector-runbook.md](mcp-connector-runbook.md). |
| Current owner | Claude (implementation) |
| Next owner | King Fee (decisions below), then Claude (deploy and connect) |

## Objective

Give ChatGPT a private, authenticated, read-only MCP connector so that Plays Ranch skills can retrieve registry records: plugins, verification evidence, releases and approved handoffs. Company isolation is enforced by the server.

## Current verified condition

- **Built:** MCP server (Streamable HTTP, stateless), the 5 read-only tools, an OAuth resource server (JWT/JWKS or RFC 7662 introspection), RFC 9728 metadata, a Postgres registry schema with a read-only role and RLS, a labeled demo fixture, CI and deploy workflows, and a Cloudflare Workers entry with a Hyperdrive binding.
- **Verified locally:** 64 tests passed on Node 22, including the Postgres suite against a real Postgres 16 connected as the read-only role. The Worker bundle is 299 KiB gzipped. In the Workers runtime (`wrangler dev`), the 10-check smoke test passed against the demo fixture, and again against Postgres through a local Hyperdrive binding (`data_status: live`).
- **Not done:** no hosting project, domain, authorization server, production database or ChatGPT connection exists yet. There are no real Plays Ranch records; the fixture is demo data and is labeled as such.

## Tool contracts (v1)

All tools carry `readOnlyHint: true`, `destructiveHint: false` and `openWorldHint: false`. Each returns `structuredContent` plus a text mirror. `meta` = `{data_status, source, retrieved_at}`.

| Tool | Input (validated) | Output | Not-found behavior |
|---|---|---|---|
| `search_plugins` | `query` ≤200, `company` slug, `capability` (exact, case-insensitive), `availability` ∈ internal/private_beta/available/suspended/retired, `limit` 1–50 (default 20) | `{count, plugins[]}` | Returns an empty list |
| `get_plugin` | `plugin_id` | `{plugin}` with capabilities, permissions, dependencies, support | `isError` "not available to you" |
| `get_verification_report` | `plugin_id`, `version?` (defaults to the current version) | `{plugin, report{status, evidence[], findings[]}, unresolved_findings[]}` | `isError` |
| `list_releases` | `plugin_id?`, `company?`, `status?` ∈ planned/in_review/approved/released/rolled_back/withdrawn, `limit` | `{count, releases[]}`, newest first | Returns an empty list |
| `get_handoff` | `handoff_id` | `{handoff}`, only when `approval_status = approved` | `isError` "No approved handoff" |

A record from another company produces the same response as a record that does not exist. This is covered by tests, and a mutation check confirmed the tests fail when scoping is removed.

## Registry data source

- Schema: `connector/db/migrations/0001_registry.sql` (schema `registry`). Tables: `companies`, `company_memberships`, `plugins`, `verification_reports`, `releases`, `handoffs`.
- Integrity: a trigger requires every child record's plugin to belong to the same `company_id`. An approved handoff requires `approved_by` and `approved_at`.
- Access: the `plays_ranch_connector` role has SELECT only, read-only transactions, RLS enabled, and a policy for that role only. Supabase API roles have no access.
- **Proposed home:** a Plays Ranch-owned Supabase project, separate from other companies' projects. Records get there through a manual or admin process until the v2 write tools exist.

## Authentication design

- The connector is an **OAuth 2.1 resource server only**. It does not issue tokens.
- It publishes `/.well-known/oauth-protected-resource/mcp` with `authorization_servers = [OAUTH_ISSUER]` and `scopes_supported = [registry:read]`.
- It enforces issuer, audience = `MCP_RESOURCE_URL`, expiry, `sub`, and the `registry:read` scope. Responses are 401 for an invalid token and 403 for a missing scope, each with a `WWW-Authenticate: Bearer resource_metadata=...` header.
- The user's `sub` is mapped to companies through `company_memberships`. Users with no membership see nothing.
- **Authorization server (approved: Clerk).** The Plays Ranch Clerk app (`app_3LcccFakdXkx1gWH479K6r0Y0af`) is separate from Hutchrok's. Its development issuer is `https://up-beagle-9921.clerk.accounts.dev`.
- Clerk's `configure_mcp_server` turns on the audience claim and Client ID Metadata Document registration. PKCE is already required. JWT access tokens must be enabled in the Clerk Dashboard; the connector then verifies them against Clerk's JWKS and needs no secrets.
- Clerk issues standard OAuth scopes only, so the connector runs with `OAUTH_REQUIRED_SCOPE=none`. Access is enforced by audience binding to the connector URL plus server-side company memberships.
- Open item: confirm in ChatGPT that its connector registers through CIMD. If it needs Dynamic Client Registration instead, enable DCR in Clerk.

## Hosting target (approved: Cloudflare Workers)

- **Staging:** Worker `plays-ranch-mcp` on workers.dev, serving the bundled demo fixture (labeled `fixture`). It is used to prove the ChatGPT + Clerk flow before the registry exists.
- **Production:** Worker `plays-ranch-mcp-production` on a custom domain (for example `mcp.<plays-ranch-domain>`). It reads Supabase Postgres through a **Hyperdrive** binding, with one connection per request.
- Config lives in `connector/wrangler.toml`. Deploys run from the manual `connector-deploy` GitHub workflow, which uses the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
- The connector stays separate from the marketing site. The site remains static and exposes no control-plane data.
- Rollback: `wrangler rollback`, or disable the connector in ChatGPT. The migration only adds objects.

## Environment variables

Listed in `connector/.env.example`: `MCP_RESOURCE_URL`, `OAUTH_MODE`, `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, `OAUTH_REQUIRED_SCOPE`, `OAUTH_JWKS_URL` or `OAUTH_INTROSPECTION_URL` / `_CLIENT_ID` / `_CLIENT_SECRET`, `REGISTRY_SOURCE`, `DATABASE_URL` (read-only role), `DATABASE_SSL`, `SERVICE_VERSION`. No secret values are in the repo.

## Skill to tool wiring (existing Plays Ranch skills)

| Skill workflow | Tool |
|---|---|
| Company and capability registry | `search_plugins`, `get_plugin` |
| Verification and release | `get_verification_report`, `list_releases` |
| Support and lifecycle / handoffs | `get_handoff` |

Skill instructions should name these tools exactly. They should also report `meta.data_status` and must not present `fixture` data as real.

## Acceptance tests

| # | Test | Where | Status |
|---|---|---|---|
| A1 | No token, invalid signature, wrong issuer, wrong audience, expired token or no `sub` → 401 with challenge | `test/auth.test.ts` | Pass (local) |
| A2 | Missing scope → 403 `insufficient_scope` | `test/auth.test.ts` | Pass (local) |
| A3 | RFC 9728 metadata is correct | `test/auth.test.ts` | Pass (local) |
| A4 | Exactly 5 tools, read-only annotations, input schemas | `test/tools.test.ts` | Pass (local) |
| A5 | Company isolation on every tool (memory store and Postgres) | `test/tools.test.ts`, `test/postgres.test.ts` | Pass (local) |
| A6 | Unapproved handoffs are never returned | both | Pass (local) |
| A7 | Invalid input is rejected; store errors return a generic message | `test/tools.test.ts` | Pass (local) |
| A8 | DB role cannot write; cross-company child rows are rejected | `test/postgres.test.ts` | Pass (local) |
| A9 | Tokens and record bodies never appear in logs | both test files | Pass (local) |
| A10 | Deployed HTTPS endpoint answers health and metadata | production | **Pending deploy** |
| A11 | ChatGPT → Plugins → + → Add custom MCP server → OAuth sign-in succeeds | ChatGPT | **Pending** |
| A12 | In ChatGPT, a user sees only their company's records; a second test user sees only theirs | ChatGPT | **Pending** |
| A13 | Full workflow in ChatGPT: search → plugin → verification → releases → handoff | ChatGPT | **Pending** |

## Release evidence to capture at A10–A13

The deployment URL and commit SHA. `/healthz` output. Metadata JSON. Screenshots of the ChatGPT connector setup and a tool call for each test user. Log excerpts showing `tool_call` events (these contain no tokens).

## Decisions

| # | Decision | Status |
|---|---|---|
| 1 | Authorization server | **Clerk**: approved 2026-11-04 |
| 2 | Hosting | **Cloudflare Workers**: approved 2026-11-04 |
| 3 | Registry database | **Supabase**: approved 2026-11-04. Needs an organization on the connected account. |
| 4 | Initial company memberships | Open |
| 5 | Production domain for the connector | Open |
| 6 | Clerk sign-up mode (public vs restricted) for a private connector | Open (recommend restricted) |
| 7 | Own repository for the connector | Open (currently `connector/` in this repo) |

## Next release (v2, not built)

`submit_product_intake`, `create_handoff` and `record_verification_result`. These need a write scope (for example `registry:write`), the `operator` or `owner` membership role, an audit table, and ChatGPT write confirmations. Publishing, licensing commitments and access changes stay behind explicit owner controls and are out of scope for the connector.

## Decision log

- 2026-11-04: Connector built inside this repo as `connector/`, a separate service, because creating a new repository needs approval.
- 2026-11-04: Stateless Streamable HTTP chosen. No session state, and horizontal scaling is safe.
- 2026-11-04: Resource server is provider-neutral (JWKS or introspection), so the authorization server choice stays open.
- 2026-11-04: King Fee approved Clerk, Cloudflare and Supabase. The Vercel target was removed. The HTTP layer was rewritten to the web-standard Fetch API so one handler serves Workers and Node.
- 2026-11-04: Plays Ranch Clerk application created (development instance) to keep it separate from Hutchrok's Clerk app.
- 2026-11-04: Node's built-in test runner used. vitest 4 failed to install under npm 10 (arborist peer-set bug).
