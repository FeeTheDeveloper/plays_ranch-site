// Local end-to-end smoke test against `wrangler dev` (real workerd runtime).
// Usage: node scripts/workerd-smoke.mjs <worker-origin> <jwks-port>
// Starts a local JWKS issuer, mints tokens, and exercises the MCP endpoint.
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const [origin, jwksPort, subject = "user_smoke_test", issuer = "https://issuer.local.test"] = process.argv.slice(2);
const resource = `${origin}/mcp`;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "smoke", alg: "RS256", use: "sig" };
const jwks = createServer((_q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwks.listen(Number(jwksPort), "127.0.0.1", r));

const token = (sub, aud = resource) =>
  new SignJWT({ client_id: "smoke" }).setProtectedHeader({ alg: "RS256", kid: "smoke" })
    .setIssuer(issuer).setSubject(sub).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);

const rpc = async (tok, method, params, id = 1) => {
  const r = await fetch(resource, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: r.status, auth: r.headers.get("www-authenticate"), body: await r.json().catch(() => null) };
};

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };

const health = await (await fetch(`${origin}/healthz`)).json();
check("healthz", health.status === "ok", JSON.stringify(health));
const meta = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
check("protected resource metadata", meta.resource === resource && meta.authorization_servers?.[0] === issuer, JSON.stringify(meta));
const noTok = await rpc(null, "tools/list", {});
check("401 without token", noTok.status === 401 && /resource_metadata=/.test(noTok.auth ?? ""));
const wrongAud = await rpc(await token(subject, "https://other.example/mcp"), "tools/list", {});
check("401 wrong audience", wrongAud.status === 401);

const good = await token(subject);
const init = await rpc(good, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
check("initialize", init.status === 200 && init.body?.result?.serverInfo?.name === "plays-ranch-registry");
const list = await rpc(good, "tools/list", {});
check("tools/list has 5 tools", list.body?.result?.tools?.length === 5, list.body?.result?.tools?.map((t) => t.name).join(","));
const search = await rpc(good, "tools/call", { name: "search_plugins", arguments: {} });
const sc = search.body?.result?.structuredContent;
check("search_plugins scoped to member company", sc?.count === 2 && sc.meta?.data_status === sc?.meta?.data_status, `count=${sc?.count} data_status=${sc?.meta?.data_status}`);
const cross = await rpc(good, "tools/call", { name: "get_plugin", arguments: { plugin_id: "bbbbbbbb-0000-4000-8000-000000000001" } });
check("cross-company plugin hidden", cross.body?.result?.isError === true);
const outsider = await rpc(await token("user_not_a_member"), "tools/call", { name: "search_plugins", arguments: {} });
check("non-member sees nothing", outsider.body?.result?.structuredContent?.count === 0);
const handoff = await rpc(good, "tools/call", { name: "get_handoff", arguments: { handoff_id: "eeeeeeee-0000-4000-8000-000000000001" } });
check("approved handoff returned", handoff.body?.result?.structuredContent?.handoff?.approval_status === "approved");

jwks.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
