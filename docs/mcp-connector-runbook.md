# Plays Ranch MCP Connector — go-live runbook

Approved stack (King Fee, 2026-11-04): **Clerk** for OAuth, **Cloudflare Workers** for hosting, **Supabase** for the registry. Steps marked 👑 need King Fee's account access or approval. Steps marked 🤖 Claude can run once the step before it is done.

## Current state (verified 2026-11-04)

| Platform | State |
|---|---|
| Clerk | App **Plays Ranch** (`app_3LcccFakdXkx1gWH479K6r0Y0af`) created, **development** instance only. Issuer: `https://up-beagle-9921.clerk.accounts.dev`. Not yet registered for MCP: no audience claim, no client registration, opaque tokens. Sign-up mode is `public`. |
| Cloudflare | No Plays Ranch Worker and no Hyperdrive config yet. This session cannot deploy (no API token in this environment). |
| Supabase | The connected Supabase account has **no organizations**, so no project can be created yet. |
| Code | `connector/` v0.2.0 targets Workers. Tested on Node and in workerd, including Postgres through a local Hyperdrive binding. |

## Phase 1: staging (proves ChatGPT + Clerk before Supabase exists)

1. 👑 **Cloudflare deploy access.** Create an API token with *Workers Scripts: Edit*, scoped to the account. Add GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Optionally create GitHub environments `connector-staging` and `connector-production` with required reviewers.
2. 👑 Tell Claude the account's **workers.dev subdomain** (Cloudflare dashboard → Workers & Pages → Overview).
3. 🤖 Set `MCP_RESOURCE_URL` in `wrangler.toml` to `https://plays-ranch-mcp.<subdomain>.workers.dev/mcp`.
4. 🤖 Register the URL with Clerk: `configure_mcp_server` on the development instance. This turns on the audience claim and client registration (CIMD).
5. 👑 In the Clerk Dashboard for the Plays Ranch app → **OAuth applications settings**, enable **JWT access tokens**. The Clerk config API does not expose this setting.
6. 👑 Run the **connector-deploy** workflow with `staging`.
7. 🤖 Verify `/healthz`, `/.well-known/oauth-protected-resource/mcp`, and the 401 challenge on the live URL, then run Clerk `check_mcp_server` with `force_recheck`.
8. 👑 Sign in to the Plays Ranch Clerk app once and give Claude your Clerk user id (`user_…`). 🤖 Claude adds it to `DEMO_MEMBER_SUBJECTS` and redeploys staging.
9. 👑 **ChatGPT → Plugins → + → Add custom MCP server.** Use the staging URL with OAuth, sign in with Clerk, and run each of the five tools. The results must show `data_status: fixture`.

## Phase 2: production registry

10. 👑 **Supabase.** Create an organization (or connect the account that owns one), then approve creating a **Plays Ranch** project, with its region and plan. Plays Ranch must not share another company's project.
11. 🤖 Apply `connector/db/migrations/0001_registry.sql`.
12. 👑 Set the `plays_ranch_connector` login password from your secrets manager: `alter role plays_ranch_connector with login password '…'`. Use the **direct** or **session-pooler** connection string, not the transaction pooler.
13. 👑 or 🤖 Create the Hyperdrive config from that connection string: `wrangler hyperdrive create plays-ranch-registry --connection-string=…`. Put the returned id in `[[env.production.hyperdrive]]`.
14. 👑 Choose the **production domain**, for example `mcp.<plays-ranch-domain>`, on a Cloudflare zone you control. Create the Clerk **production instance** (it needs that domain's DNS).
15. 🤖 Fill in the production `[env.production.vars]` values, register the production URL with Clerk, and enable JWT access tokens on production (👑 Dashboard).
16. 👑 Load the first real records and the **company memberships** (which Clerk users can read which companies).
17. 👑 Run **connector-deploy** with `production`. 🤖 Run acceptance tests A10–A13 with two test users in different companies and capture the release evidence.

## Rollback

- Worker: `wrangler rollback`, or redeploy the previous commit through the workflow.
- ChatGPT: remove or disable the custom MCP server.
- Clerk: remove the MCP server registration.
- Database: the migration only adds objects, so no rollback is needed for v1.

## Security notes

- The Worker holds no secrets in JWT mode. The database credential lives only inside the Hyperdrive config.
- Clerk sign-up is currently `public`. That is safe, because users without a membership see nothing, but for a private connector set sign-up to restricted or invite-only (👑 decision).
- Staging serves only the labeled demo fixture. Production fails closed with 503 if the Hyperdrive binding is missing.
