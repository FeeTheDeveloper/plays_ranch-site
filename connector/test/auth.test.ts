import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeKeys, mintToken, startHarness, type Harness } from "./helpers.js";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

async function post(h: Harness, token?: string, body: unknown = INIT) {
  return fetch(h.resourceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("OAuth resource server", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it("publishes RFC 9728 protected resource metadata at the path-suffixed and root well-known URLs", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(h.baseUrl + path);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.resource, h.resourceUrl);
      assert.deepEqual(body.authorization_servers, ["https://auth.test.example"]);
      assert.deepEqual(body.scopes_supported, ["registry:read"]);
      assert.deepEqual(body.bearer_methods_supported, ["header"]);
    }
  });

  it("rejects a request with no token with 401 and a resource_metadata challenge", async () => {
    const res = await post(h);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.match(challenge, /error="invalid_token"/);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await makeKeys();
    const token = await mintToken(other, { aud: h.resourceUrl });
    assert.equal((await post(h, token)).status, 401);
  });

  it("rejects a token for a different audience (resource)", async () => {
    assert.equal((await post(h, await h.token({ aud: "https://other.example/mcp" }))).status, 401);
  });

  it("rejects a token from a different issuer", async () => {
    assert.equal((await post(h, await h.token({ iss: "https://evil.example" }))).status, 401);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    assert.equal((await post(h, await h.token({ expiresIn: past }))).status, 401);
  });

  it("rejects a token with no subject", async () => {
    assert.equal((await post(h, await h.token({ sub: "" }))).status, 401);
  });

  it("returns 403 insufficient_scope when the required scope is missing", async () => {
    const res = await post(h, await h.token({ scope: "profile" }));
    assert.equal(res.status, 403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /error="insufficient_scope"/);
    assert.match(challenge, /scope="registry:read"/);
  });

  it("accepts a valid token and completes MCP initialize", async () => {
    const res = await post(h, await h.token());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, "plays-ranch-registry");
    assert.ok(body.result.capabilities.tools);
    assert.match(body.result.instructions, /read-only/);
  });

  it("never logs the bearer token", async () => {
    const token = await h.token();
    await post(h, token);
    assert.ok(!JSON.stringify(h.logs).includes(token));
  });

  it("returns 405 for GET and DELETE on the stateless MCP endpoint", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(h.resourceUrl, { method, headers: { authorization: `Bearer ${await h.token()}` } });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
    }
  });

  it("returns a JSON-RPC parse error for malformed JSON", async () => {
    const res = await fetch(h.resourceUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${await h.token()}`, "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  it("serves an unauthenticated health check without exposing configuration secrets", async () => {
    const res = await fetch(`${h.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.data_status, "fixture");
    assert.deepEqual(Object.keys(body).sort(), ["data_status", "registry_source", "service", "status", "version"]);
  });

  it("returns 404 for unknown paths", async () => {
    assert.equal((await fetch(`${h.baseUrl}/admin`)).status, 404);
  });
});
