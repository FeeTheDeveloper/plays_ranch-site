# Plays Ranch MCP Connector

A private, read-only MCP server that lets ChatGPT (as a custom MCP connector) read the Plays Ranch registry. It is deployed as its own service and kept separate from the public marketing site in the repository root.

**Status:** v0.2.0 targets Cloudflare Workers. It has been tested locally on Node and in the Workers runtime (workerd), against both the demo fixture and a real Postgres 16 reached through a local Hyperdrive binding. **It has not been deployed.** The Plays Ranch Clerk app exists (development instance) but is not yet registered for the MCP server. See [docs/mcp-connector-v1-handoff.md](../docs/mcp-connector-v1-handoff.md).

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `POST /mcp` | Bearer (OAuth) | MCP Streamable HTTP, stateless, JSON responses |
| `GET /.well-known/oauth-protected-resource[/mcp]` | none | RFC 9728 protected resource metadata |
| `GET /healthz` | none | Liveness. Reports version, registry source and data status. Contains no secrets. |
| `GET /readyz` | none | Readiness. Pings the registry store. |

## Tools (all read-only)

| Tool | Input | Returns |
|---|---|---|
| `search_plugins` | `query?`, `company?`, `capability?`, `availability?`, `limit?` | Plugin summaries |
| `get_plugin` | `plugin_id` | Capabilities, permissions, dependencies, availability, version, support |
| `get_verification_report` | `plugin_id`, `version?` | Report, evidence, findings, plus `unresolved_findings` |
| `list_releases` | `plugin_id?`, `company?`, `status?`, `limit?` | Releases, newest first |
| `get_handoff` | `handoff_id` | One **approved** handoff |

Every result includes `meta.data_status` (`live` or `fixture`), `meta.source` and `meta.retrieved_at`. Results from fixture data also carry a notice saying they are demo data.

## Security model

1. **Authentication.** The server is an OAuth 2.1 resource server. Access tokens are checked against a JWKS (`OAUTH_MODE=jwt`, used with Clerk) or with RFC 7662 introspection (`OAUTH_MODE=introspection`). Issuer, audience (= `MCP_RESOURCE_URL`), expiry and subject are always enforced. A scope is also enforced unless `OAUTH_REQUIRED_SCOPE=none`; Clerk uses `none` because it issues only standard scopes. A failed check returns 401 or 403 with a `WWW-Authenticate` challenge that points to the resource metadata.
2. **Authorization.** The company scope comes from `registry.company_memberships` on the server, keyed by the token's `sub`. Tool inputs never decide scope. Every store query filters on `company_id = ANY(scope)`. A record from another company returns the same response as a record that does not exist.
3. **Database.** The connector connects as `plays_ranch_connector`, which has SELECT grants only and `default_transaction_read_only = on`. RLS is enabled on every table, with a policy for that role only.
4. **Logging.** Logs are JSON lines with tool name, subject, client and outcome. They never include tokens or record bodies.

## Develop

```bash
cd connector
npm ci
npm run typecheck
npm test                       # Postgres suite is skipped without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://postgres@localhost:5432/registry_test npm test
npm run build && npm start     # requires env, see .env.example
```

To run locally against the demo fixture: set `REGISTRY_SOURCE=fixture` along with the OAuth variables. This mode is refused when `NODE_ENV=production` unless `ALLOW_FIXTURE_IN_PRODUCTION=true`.

## Database

Apply `db/migrations/0001_registry.sql` with an owner role. The migration only adds objects and can safely be run more than once. Then set a login password for `plays_ranch_connector` from the secrets manager, out of band. Do not put that password in this repo.

## Deploy: Cloudflare Workers

Approved stack: **Clerk** (OAuth), **Cloudflare Workers** (hosting), **Supabase** (registry Postgres via Hyperdrive). The full go-live sequence is in [docs/mcp-connector-runbook.md](../docs/mcp-connector-runbook.md).

| Environment | Worker | Registry | Command |
|---|---|---|---|
| staging | `plays-ranch-mcp` on workers.dev | Bundled demo fixture, labeled `fixture` | `npm run deploy:staging` |
| production | `plays-ranch-mcp-production` on a custom domain | Supabase through the `HYPERDRIVE` binding | `npm run deploy:production` |

Deploys run from the manual **connector-deploy** GitHub workflow, which uses the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. JWT mode needs no Worker secrets.

Local verification in the real Workers runtime:

```bash
npm run worker:bundle                       # bundle only, no deploy
npx wrangler dev --local --var NODE_ENV:development \
  --var MCP_RESOURCE_URL:http://127.0.0.1:8787/mcp --var OAUTH_ISSUER:https://issuer.local.test \
  --var OAUTH_JWKS_URL:http://127.0.0.1:8791/jwks --var DEMO_MEMBER_SUBJECTS:user_smoke_test
npm run worker:smoke -- http://127.0.0.1:8787 8791
# Production path against a local Postgres: npx wrangler dev -c wrangler.pg-smoke.toml --local
```

`src/server.ts` (Node) stays available for local development and container hosting. Both runtimes share one web-standard handler (`src/http.ts`).
