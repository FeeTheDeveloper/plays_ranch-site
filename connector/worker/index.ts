/**
 * Cloudflare Workers entry for the Plays Ranch MCP Connector.
 *
 * Shares the web-standard handler (src/http.ts) with the Node server. Differences:
 *  - Postgres access goes through a Hyperdrive binding, with one connection per request
 *    (Workers cannot share I/O objects across requests).
 *  - The demo fixture is bundled at build time, since there is no filesystem.
 */
import dataset from "../fixtures/demo-registry.json" with { type: "json" };
import { createVerifier } from "../src/auth/verifier.js";
import { ConfigError, loadConfig, type Config, type Env } from "../src/config.js";
import { createFetchHandler, type FetchHandler } from "../src/http.js";
import { jsonLogger } from "../src/log.js";
import { MemoryRegistryStore, type RegistryDataset } from "../src/store/memory.js";
import { PostgresRegistryStore } from "../src/store/postgres.js";
import type { RegistryStore } from "../src/store/store.js";

export interface WorkerBindings {
  /** Hyperdrive binding to the Plays Ranch Supabase Postgres (read-only connector role). */
  HYPERDRIVE?: { connectionString: string };
  [name: string]: unknown;
}

let cached: { handler: FetchHandler; config: Config } | undefined;

function stringEnv(bindings: WorkerBindings): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(bindings)) if (typeof v === "string") env[k] = v;
  if (bindings.HYPERDRIVE) {
    env.REGISTRY_SOURCE ??= "postgres";
    env.DATABASE_URL = bindings.HYPERDRIVE.connectionString;
  }
  return env;
}

/**
 * Fixture mode only: grant listed Clerk user ids read access to the demo company so a real
 * sign-in can exercise the staging connector. Ignored when the registry is Postgres.
 */
export function withDemoMembers(data: RegistryDataset, bindings: WorkerBindings): RegistryDataset {
  const raw = typeof bindings.DEMO_MEMBER_SUBJECTS === "string" ? bindings.DEMO_MEMBER_SUBJECTS : "";
  const subjects = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const demoCompany = data.companies[0];
  if (!subjects.length || !demoCompany) return data;
  return {
    ...data,
    memberships: [
      ...data.memberships,
      ...subjects.map((user_subject) => ({ user_subject, company_id: demoCompany.id, role: "viewer" as const })),
    ],
  };
}

function build(bindings: WorkerBindings): { handler: FetchHandler; config: Config } {
  const config = loadConfig(stringEnv(bindings));
  const fixture =
    config.registry.source === "fixture"
      ? new MemoryRegistryStore(withDemoMembers(dataset as unknown as RegistryDataset, bindings), "fixture")
      : undefined;

  const handler = createFetchHandler({
    resourceUrl: config.resourceUrl,
    issuer: config.auth.issuer,
    requiredScope: config.auth.requiredScope,
    scopesSupported: config.auth.scopesSupported,
    serviceVersion: config.serviceVersion,
    verifier: createVerifier(config), // cached per isolate, so JWKS stays warm
    openStore: (): RegistryStore =>
      fixture ??
      // Hyperdrive terminates TLS to the origin; the Worker-to-Hyperdrive hop needs none.
      new PostgresRegistryStore(config.registry.databaseUrl!, { ssl: false, max: 1 }),
    releaseStore: async (store) => {
      if (store !== fixture) await store.close();
    },
    logger: jsonLogger,
  });
  jsonLogger("info", "connector_configured", {
    runtime: "cloudflare-workers",
    resource: config.resourceUrl,
    auth_mode: config.auth.mode,
    registry_source: config.registry.source,
    version: config.serviceVersion,
  });
  return { handler, config };
}

export default {
  async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    try {
      cached ??= build(bindings);
    } catch (err) {
      // Misconfiguration: fail closed, log the variable name only (ConfigError never includes values).
      jsonLogger("error", "connector_misconfigured", {
        error: err instanceof ConfigError ? err.message : "unexpected configuration error",
      });
      return new Response(JSON.stringify({ error: "service_misconfigured" }), {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return cached.handler(request);
  },
};
