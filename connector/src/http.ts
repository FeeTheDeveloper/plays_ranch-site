import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { protectedResourceMetadataUrl } from "./config.js";
import { AuthError, requireScope, type TokenVerifier } from "./auth/verifier.js";
import type { Logger } from "./log.js";
import type { RegistryStore } from "./store/store.js";
import { registerTools } from "./tools.js";

export interface AppDeps {
  resourceUrl: string;
  issuer: string;
  requiredScope: string;
  scopesSupported: string[];
  serviceVersion: string;
  verifier: TokenVerifier;
  store: RegistryStore;
  logger: Logger;
}

export const SERVER_INSTRUCTIONS =
  "Plays Ranch registry (read-only). Use search_plugins to find plugins, get_plugin for details, " +
  "get_verification_report for evidence and unresolved findings, list_releases for release status, " +
  "and get_handoff for approved handoffs. Results are limited to companies the user belongs to. " +
  "Report records exactly as returned; if meta.data_status is \"fixture\", say the data is demo data.";

const MAX_BODY_BYTES = 1_000_000;

type Handler = (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void>;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  if (req.body !== undefined) {
    // Some hosts (e.g. Vercel) pre-parse the body.
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

class BodyTooLarge extends Error {}

export function createApp(deps: AppDeps): Handler {
  const metadataUrl = protectedResourceMetadataUrl(deps.resourceUrl);
  const mcpPath = new URL(deps.resourceUrl).pathname.replace(/\/$/, "") || "/";
  const metadataPath = new URL(metadataUrl).pathname;

  const protectedResourceMetadata = {
    resource: deps.resourceUrl,
    authorization_servers: [deps.issuer],
    scopes_supported: deps.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: "Plays Ranch Registry",
  };

  const challenge = (error: string, description: string, extra = "") =>
    `Bearer resource_metadata="${metadataUrl}", error="${error}", error_description="${description}"${extra}`;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, {
        status: "ok",
        service: "plays-ranch-mcp-connector",
        version: deps.serviceVersion,
        registry_source: deps.store.kind,
        data_status: deps.store.dataStatus,
      });
    }

    if (req.method === "GET" && path === "/readyz") {
      try {
        await deps.store.ping();
        return send(res, 200, { status: "ready" });
      } catch {
        deps.logger("error", "readiness_failed", { source: deps.store.kind });
        return send(res, 503, { status: "unavailable" });
      }
    }

    if (
      req.method === "GET" &&
      (path === metadataPath || path === "/.well-known/oauth-protected-resource")
    ) {
      return send(res, 200, protectedResourceMetadata, { "access-control-allow-origin": "*" });
    }

    if (path !== mcpPath) return send(res, 404, { error: "not_found" });

    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to DELETE.
      return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    }

    // --- Authentication -------------------------------------------------------
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      return send(res, 401, { error: "unauthorized" }, {
        "www-authenticate": challenge("invalid_token", "Missing bearer token"),
      });
    }

    let principal;
    try {
      principal = await deps.verifier.verify(match[1]!);
      requireScope(principal, deps.requiredScope);
    } catch (err) {
      if (err instanceof AuthError && err.code === "insufficient_scope") {
        deps.logger("warn", "auth_rejected", { reason: "insufficient_scope" });
        return send(res, 403, { error: "insufficient_scope" }, {
          "www-authenticate": challenge("insufficient_scope", err.message, `, scope="${deps.requiredScope}"`),
        });
      }
      deps.logger("warn", "auth_rejected", { reason: err instanceof Error ? err.message : "unknown" });
      return send(res, 401, { error: "unauthorized" }, {
        "www-authenticate": challenge("invalid_token", "Access token is invalid or expired"),
      });
    }

    // --- Body -----------------------------------------------------------------
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, { error: "payload_too_large" });
      return send(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      });
    }

    // --- Authorization: company scope from server-side memberships -------------
    let companyIds: string[];
    try {
      companyIds = await deps.store.companyIdsForSubject(principal.subject);
    } catch (err) {
      deps.logger("error", "membership_lookup_failed", {
        subject: principal.subject,
        error: err instanceof Error ? err.message : String(err),
      });
      return send(res, 503, { error: "registry_unavailable" });
    }
    if (companyIds.length === 0) {
      deps.logger("warn", "no_company_membership", { subject: principal.subject, client: principal.clientId });
    }

    const server = new McpServer(
      { name: "plays-ranch-registry", title: "Plays Ranch Registry", version: deps.serviceVersion },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server, {
      store: deps.store,
      scope: { userSubject: principal.subject, companyIds },
      clientId: principal.clientId,
      logger: deps.logger,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    const auth: AuthInfo = {
      token: principal.token,
      clientId: principal.clientId,
      scopes: principal.scopes,
      expiresAt: principal.expiresAt,
      resource: new URL(deps.resourceUrl),
      extra: { subject: principal.subject },
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(Object.assign(req, { auth }), res, body);
    } catch (err) {
      deps.logger("error", "mcp_request_failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };
}
