/**
 * Environment configuration. See .env.example for the full inventory.
 * Secret values are read here and never logged.
 */

export type AuthMode = "jwt" | "introspection";
export type RegistrySource = "postgres" | "fixture";

export interface Config {
  port: number;
  /** Public HTTPS URL of the MCP endpoint, e.g. https://mcp.playsranch.com/mcp. Used as the OAuth audience/resource. */
  resourceUrl: string;
  auth: {
    mode: AuthMode;
    issuer: string;
    /** Value(s) the token's aud must contain. Defaults to resourceUrl. */
    audience: string;
    jwksUrl?: string;
    introspectionUrl?: string;
    introspectionClientId?: string;
    introspectionClientSecret?: string;
    allowMissingAudience?: boolean;
    requiredScope: string;
    scopesSupported: string[];
  };
  registry: {
    source: RegistrySource;
    databaseUrl?: string;
    databaseSsl: boolean;
    fixturePath?: string;
  };
  serviceVersion: string;
}

export class ConfigError extends Error {}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new ConfigError(`Missing required environment variable ${name}`);
  return v;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const resourceUrl = req(env, "MCP_RESOURCE_URL");
  const parsedResource = new URL(resourceUrl);
  if (production && parsedResource.protocol !== "https:") {
    throw new ConfigError("MCP_RESOURCE_URL must use https in production");
  }

  const mode = (opt(env, "OAUTH_MODE") ?? "jwt") as AuthMode;
  if (mode !== "jwt" && mode !== "introspection") {
    throw new ConfigError(`OAUTH_MODE must be "jwt" or "introspection", got "${mode}"`);
  }
  const issuer = req(env, "OAUTH_ISSUER");
  const requiredScope = opt(env, "OAUTH_REQUIRED_SCOPE") ?? "registry:read";

  const auth: Config["auth"] = {
    mode,
    issuer,
    audience: opt(env, "OAUTH_AUDIENCE") ?? resourceUrl,
    requiredScope,
    scopesSupported: [requiredScope],
  };
  if (mode === "jwt") {
    auth.jwksUrl = req(env, "OAUTH_JWKS_URL");
  } else {
    auth.introspectionUrl = req(env, "OAUTH_INTROSPECTION_URL");
    auth.introspectionClientId = req(env, "OAUTH_INTROSPECTION_CLIENT_ID");
    auth.introspectionClientSecret = req(env, "OAUTH_INTROSPECTION_CLIENT_SECRET");
    auth.allowMissingAudience = env.OAUTH_INTROSPECTION_ALLOW_MISSING_AUD === "true";
  }

  const source = (opt(env, "REGISTRY_SOURCE") ?? "postgres") as RegistrySource;
  if (source !== "postgres" && source !== "fixture") {
    throw new ConfigError(`REGISTRY_SOURCE must be "postgres" or "fixture", got "${source}"`);
  }
  const registry: Config["registry"] = {
    source,
    databaseSsl: (opt(env, "DATABASE_SSL") ?? "true") !== "false",
  };
  if (source === "postgres") {
    registry.databaseUrl = req(env, "DATABASE_URL");
  } else {
    if (production && env.ALLOW_FIXTURE_IN_PRODUCTION !== "true") {
      throw new ConfigError(
        "REGISTRY_SOURCE=fixture is refused in production; set ALLOW_FIXTURE_IN_PRODUCTION=true only for a labeled demo deployment",
      );
    }
    registry.fixturePath = opt(env, "REGISTRY_FIXTURE_PATH") ?? "fixtures/demo-registry.json";
  }

  const port = Number(opt(env, "PORT") ?? "8787");
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError("PORT must be a positive integer");

  return {
    port,
    resourceUrl,
    auth,
    registry,
    serviceVersion: opt(env, "SERVICE_VERSION") ?? "0.1.0",
  };
}

/** RFC 9728 metadata URL for a resource: insert the well-known segment before the resource path. */
export function protectedResourceMetadataUrl(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `${u.origin}/.well-known/oauth-protected-resource${path}`;
}
