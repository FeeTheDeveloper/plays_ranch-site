import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, protectedResourceMetadataUrl } from "../src/config.js";
import { AuthError, IntrospectionVerifier, scopesFromClaims } from "../src/auth/verifier.js";

const BASE = {
  MCP_RESOURCE_URL: "https://mcp.example.com/mcp",
  OAUTH_ISSUER: "https://auth.example.com",
  OAUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
  DATABASE_URL: "postgres://u:p@db.example.com:5432/registry",
};

describe("config", () => {
  it("loads a jwt + postgres configuration with defaults", () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.auth.mode, "jwt");
    assert.equal(c.auth.audience, BASE.MCP_RESOURCE_URL);
    assert.equal(c.auth.requiredScope, "registry:read");
    assert.equal(c.registry.source, "postgres");
    assert.equal(c.registry.databaseSsl, true);
    assert.equal(c.port, 8787);
  });

  it("supports audience-only mode with OAUTH_REQUIRED_SCOPE=none", () => {
    const c = loadConfig({ ...BASE, OAUTH_REQUIRED_SCOPE: "none" });
    assert.equal(c.auth.requiredScope, null);
    assert.deepEqual(c.auth.scopesSupported, []);
  });

  it("requires https for the resource URL in production", () => {
    assert.throws(
      () => loadConfig({ ...BASE, NODE_ENV: "production", MCP_RESOURCE_URL: "http://mcp.example.com/mcp" }),
      ConfigError,
    );
  });

  it("refuses fixture data in production unless explicitly allowed", () => {
    const env = { ...BASE, NODE_ENV: "production", REGISTRY_SOURCE: "fixture" };
    assert.throws(() => loadConfig(env), /refused in production/);
    assert.equal(loadConfig({ ...env, ALLOW_FIXTURE_IN_PRODUCTION: "true" }).registry.source, "fixture");
  });

  it("requires introspection credentials in introspection mode", () => {
    assert.throws(() => loadConfig({ ...BASE, OAUTH_MODE: "introspection" }), /OAUTH_INTROSPECTION_URL/);
  });

  it("rejects unknown modes and missing required values", () => {
    assert.throws(() => loadConfig({ ...BASE, OAUTH_MODE: "none" }), ConfigError);
    assert.throws(() => loadConfig({ ...BASE, OAUTH_ISSUER: "" }), /OAUTH_ISSUER/);
  });

  it("builds RFC 9728 metadata URLs", () => {
    assert.equal(
      protectedResourceMetadataUrl("https://mcp.example.com/mcp"),
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(
      protectedResourceMetadataUrl("https://mcp.example.com/"),
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });
});

describe("scope parsing", () => {
  it("reads scope strings, scp arrays and permissions arrays", () => {
    assert.deepEqual(scopesFromClaims({ scope: "a b" }).sort(), ["a", "b"]);
    assert.deepEqual(scopesFromClaims({ scp: ["a"], permissions: ["c"] }).sort(), ["a", "c"]);
    assert.deepEqual(scopesFromClaims({}), []);
  });
});

describe("introspection verifier", () => {
  const opts = {
    issuer: "https://auth.example.com",
    audience: "https://mcp.example.com/mcp",
    introspectionUrl: "https://auth.example.com/oauth/introspect",
    clientId: "cid",
    clientSecret: "secret",
  };
  const fakeFetch = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  const active = {
    active: true,
    sub: "user-1",
    client_id: "chatgpt",
    scope: "registry:read",
    iss: opts.issuer,
    aud: opts.audience,
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  it("accepts an active token for this resource", async () => {
    const p = await new IntrospectionVerifier(opts, fakeFetch(active)).verify("tok");
    assert.equal(p.subject, "user-1");
    assert.equal(p.clientId, "chatgpt");
    assert.deepEqual(p.scopes, ["registry:read"]);
  });

  it("sends client credentials with HTTP Basic", async () => {
    let auth = "";
    const f = (async (_url: string, init: RequestInit) => {
      auth = new Headers(init.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(active));
    }) as unknown as typeof fetch;
    await new IntrospectionVerifier(opts, f).verify("tok");
    assert.equal(auth, `Basic ${Buffer.from("cid:secret").toString("base64")}`);
  });

  for (const [name, body, status] of [
    ["inactive", { ...active, active: false }, 200],
    ["wrong audience", { ...active, aud: "https://other/mcp" }, 200],
    ["missing audience", { ...active, aud: undefined }, 200],
    ["wrong issuer", { ...active, iss: "https://evil" }, 200],
    ["expired", { ...active, exp: 1 }, 200],
    ["introspection endpoint error", {}, 500],
  ] as const) {
    it(`rejects: ${name}`, async () => {
      await assert.rejects(new IntrospectionVerifier(opts, fakeFetch(body, status)).verify("tok"), AuthError);
    });
  }

  it("accepts a missing audience only when explicitly allowed", async () => {
    const v = new IntrospectionVerifier({ ...opts, allowMissingAudience: true }, fakeFetch({ ...active, aud: undefined }));
    assert.equal((await v.verify("tok")).subject, "user-1");
  });
});
