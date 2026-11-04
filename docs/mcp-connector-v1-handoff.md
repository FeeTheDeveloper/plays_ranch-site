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
| Status | REVIEW: built and tested locally. Not deployed. OAuth not provisioned. |
| Current owner | Claude (implementation) |
| Next owner | King Fee (decisions below), then Claude (deploy and connect) |

## Objective

Give ChatGPT a private, authenticated, read-only MCP connector so that Plays Ranch skills can retrieve registry records: plugins, verification evidence, releases and approved handoffs. Company isolation is enforced by the server.

## Current verified condition

- **Built:** MCP server (Streamable HTTP, stateless), the 5 read-only tools, an OAuth resource server (JWT/JWKS or RFC 7662 introspection), RFC 9728 metadata, a Postgres registry schema with a read-only role and RLS, a labeled demo fixture, CI workflow, and a Vercel entry.
- **Verified locally:** 57 tests passed on Node 22. That includes the Postgres suite run against a real Postgres 16, connected as the read-only role. The production build compiled. The compiled server answered `/healthz`, the metadata endpoint and the 401 challenge. The Vercel entry was run under a plain Node server.
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
- **Authorization server (decision needed):** proposed Clerk, which is already in the FTD stack. It must support authorization code + PKCE S256, the `resource` parameter or audience binding, and a client-registration method ChatGPT accepts (Dynamic Client Registration and/or Client ID Metadata Documents). Secondary sources disagree on which of those ChatGPT currently requires, so **confirm against OpenAI's current developer docs before provisioning.**

## Hosting target

- **Proposed:** a separate Vercel project with Root Directory `connector/`, on a dedicated subdomain (for example `mcp.<plays-ranch-domain>`), with `MCP_RESOURCE_URL=https://mcp.<domain>/mcp`.
- The service is kept separate from the marketing site. The site stays static and exposes no control-plane data.
- Rollback: redeploy the previous Vercel deployment, or disable the connector in ChatGPT. The database migration only adds objects.

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

## Decisions needed from King Fee

1. Approve **Clerk** (or name another provider) as the Plays Ranch authorization server.
2. Approve **Vercel** as the host, plus the connector **subdomain**.
3. Approve a **Plays Ranch Supabase project** as the registry database, and name who loads the first real records.
4. Name the initial **company memberships**: which user identities can read which companies.
5. Decide whether the connector should **move to its own repository**. It currently lives in `connector/`, inside this repo, as a separate deployable unit.

## Next release (v2, not built)

`submit_product_intake`, `create_handoff` and `record_verification_result`. These need a write scope (for example `registry:write`), the `operator` or `owner` membership role, an audit table, and ChatGPT write confirmations. Publishing, licensing commitments and access changes stay behind explicit owner controls and are out of scope for the connector.

## Decision log

- 2026-11-04: Connector built inside this repo as `connector/`, a separate service, because creating a new repository needs approval.
- 2026-11-04: Stateless Streamable HTTP chosen. No session state, and horizontal scaling is safe.
- 2026-11-04: Resource server is provider-neutral (JWKS or introspection), so the authorization server choice stays open.
- 2026-11-04: Node's built-in test runner used. vitest 4 failed to install under npm 10 (arborist peer-set bug).
