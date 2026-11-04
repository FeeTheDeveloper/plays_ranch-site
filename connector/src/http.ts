import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { protectedResourceMetadataUrl } from "./config.js";
import { AuthError, requireScope, type Principal, type TokenVerifier } from "./auth/verifier.js";
import type { Logger } from "./log.js";
import type { RegistryStore } from "./store/store.js";
import { registerTools } from "./tools.js";

export interface AppDeps {
  resourceUrl: string;
  issuer: string;
  /** Scope every token must carry. null = audience binding only (for servers without custom scopes). */
  requiredScope: string | null;
  scopesSupported: string[];
  serviceVersion: string;
  verifier: TokenVerifier;
  /**
   * Returns the registry store for one request. Node returns a shared pool; Workers open a
   * per-request connection (I/O objects cannot be shared across Worker requests).
   */
  openStore: () => RegistryStore;
  /** Called once the request is finished with a store from openStore. */
  releaseStore?: (store: RegistryStore) => Promise<void>;
  logger: Logger;
}

export const SERVER_INSTRUCTIONS =
  "Plays Ranch registry (read-only). Use search_plugins to find plugins, get_plugin for details, " +
  "get_verification_report for evidence and unresolved findings, list_releases for release status, " +
  "and get_handoff for approved handoffs. Results are limited to companies the user belongs to. " +
  "Report records exactly as returned; if meta.data_status is \"fixture\", say the data is demo data.";

export const MAX_BODY_BYTES = 1_000_000;

export type FetchHandler = (request: Request) => Promise<Response>;

const BASE_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

class BodyTooLarge extends Error {}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BodyTooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new BodyTooLarge();
  return text ? JSON.parse(text) : undefined;
}

export function createFetchHandler(deps: AppDeps): FetchHandler {
  const metadataUrl = protectedResourceMetadataUrl(deps.resourceUrl);
  const mcpPath = new URL(deps.resourceUrl).pathname.replace(/\/$/, "") || "/";
  const metadataPath = new URL(metadataUrl).pathname;
  const release = deps.releaseStore ?? (async () => {});

  const protectedResourceMetadata = {
    resource: deps.resourceUrl,
    authorization_servers: [deps.issuer],
    scopes_supported: deps.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: "Plays Ranch Registry",
  };

  const challenge = (error: string, description: string, extra = "") =>
    `Bearer resource_metadata="${metadataUrl}", error="${error}", error_description="${description}"${extra}`;

  async function withStore(fn: (store: RegistryStore) => Promise<Response>): Promise<Response> {
    const store = deps.openStore();
    try {
      return await fn(store);
    } finally {
      await release(store).catch((err) =>
        deps.logger("warn", "store_release_failed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method;

    if (method === "GET" && path === "/healthz") {
      const store = deps.openStore();
      const body = {
        status: "ok",
        service: "plays-ranch-mcp-connector",
        version: deps.serviceVersion,
        registry_source: store.kind,
        data_status: store.dataStatus,
      };
      await release(store).catch(() => {});
      return json(200, body);
    }

    if (method === "GET" && path === "/readyz") {
      return withStore(async (store) => {
        try {
          await store.ping();
          return json(200, { status: "ready" });
        } catch {
          deps.logger("error", "readiness_failed", { source: store.kind });
          return json(503, { status: "unavailable" });
        }
      });
    }

    if (method === "GET" && (path === metadataPath || path === "/.well-known/oauth-protected-resource")) {
      return json(200, protectedResourceMetadata, { "access-control-allow-origin": "*" });
    }

    if (path !== mcpPath) return json(404, { error: "not_found" });

    if (method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to DELETE.
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    // --- Authentication -------------------------------------------------------
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match) {
      return json(401, { error: "unauthorized" }, {
        "www-authenticate": challenge("invalid_token", "Missing bearer token"),
      });
    }

    let principal: Principal;
    try {
      principal = await deps.verifier.verify(match[1]!);
      if (deps.requiredScope) requireScope(principal, deps.requiredScope);
    } catch (err) {
      if (err instanceof AuthError && err.code === "insufficient_scope") {
        deps.logger("warn", "auth_rejected", { reason: "insufficient_scope" });
        return json(403, { error: "insufficient_scope" }, {
          "www-authenticate": challenge("insufficient_scope", err.message, `, scope="${deps.requiredScope}"`),
        });
      }
      deps.logger("warn", "auth_rejected", { reason: err instanceof Error ? err.message : "unknown" });
      return json(401, { error: "unauthorized" }, {
        "www-authenticate": challenge("invalid_token", "Access token is invalid or expired"),
      });
    }

    // --- Body -----------------------------------------------------------------
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (err) {
      if (err instanceof BodyTooLarge) return json(413, { error: "payload_too_large" });
      return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }

    return withStore(async (store) => {
      // --- Authorization: company scope from server-side memberships ------------
      let companyIds: string[];
      try {
        companyIds = await store.companyIdsForSubject(principal.subject);
      } catch (err) {
        deps.logger("error", "membership_lookup_failed", {
          subject: principal.subject,
          error: err instanceof Error ? err.message : String(err),
        });
        return json(503, { error: "registry_unavailable" });
      }
      if (companyIds.length === 0) {
        deps.logger("warn", "no_company_membership", { subject: principal.subject, client: principal.clientId });
      }

      const server = new McpServer(
        { name: "plays-ranch-registry", title: "Plays Ranch Registry", version: deps.serviceVersion },
        { instructions: SERVER_INSTRUCTIONS },
      );
      registerTools(server, {
        store,
        scope: { userSubject: principal.subject, companyIds },
        clientId: principal.clientId,
        logger: deps.logger,
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      const authInfo: AuthInfo = {
        token: principal.token,
        clientId: principal.clientId,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
        resource: new URL(deps.resourceUrl),
        extra: { subject: principal.subject },
      };

      try {
        await server.connect(transport);
        // JSON-response mode resolves after the tool handlers finish, so the store can be released afterwards.
        const response = await transport.handleRequest(request, { parsedBody: body, authInfo });
        const buffered = await response.text();
        return new Response(buffered, { status: response.status, headers: response.headers });
      } catch (err) {
        deps.logger("error", "mcp_request_failed", { error: err instanceof Error ? err.message : String(err) });
        return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      } finally {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    });
  };
}
