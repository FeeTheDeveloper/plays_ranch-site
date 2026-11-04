import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JwtVerifier } from "../src/auth/verifier.js";
import { createApp } from "../src/http.js";
import { silentLogger, type Logger } from "../src/log.js";
import { loadDataset, MemoryRegistryStore } from "../src/store/memory.js";
import type { RegistryStore } from "../src/store/store.js";

export const ISSUER = "https://auth.test.example";
export const SCOPE = "registry:read";
export const FIXTURE = new URL("../fixtures/demo-registry.json", import.meta.url).pathname;

export const IDS = {
  companyA: "11111111-1111-4111-8111-111111111111",
  companyB: "22222222-2222-4222-8222-222222222222",
  pluginA1: "aaaaaaaa-0000-4000-8000-000000000001",
  pluginA2: "aaaaaaaa-0000-4000-8000-000000000002",
  pluginB1: "bbbbbbbb-0000-4000-8000-000000000001",
  handoffApproved: "eeeeeeee-0000-4000-8000-000000000001",
  handoffDraft: "eeeeeeee-0000-4000-8000-000000000002",
  handoffB: "eeeeeeee-0000-4000-8000-000000000003",
};

export interface Keys {
  privateKey: CryptoKey;
  jwks: { keys: JWK[] };
}

export async function makeKeys(kid = "test-key"): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] } };
}

export async function mintToken(
  keys: Keys,
  opts: {
    sub?: string;
    aud?: string;
    iss?: string;
    scope?: string;
    expiresIn?: string | number;
    kid?: string;
  },
): Promise<string> {
  const jwt = new SignJWT({ scope: opts.scope ?? SCOPE, client_id: "test-client" })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "test-key" })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m");
  if (opts.sub !== "") jwt.setSubject(opts.sub ?? "demo-user-a");
  if (opts.aud) jwt.setAudience(opts.aud);
  return jwt.sign(keys.privateKey);
}

export interface Harness {
  baseUrl: string;
  resourceUrl: string;
  keys: Keys;
  store: RegistryStore;
  logs: { level: string; event: string; fields: Record<string, unknown> }[];
  close(): Promise<void>;
  token(opts?: Parameters<typeof mintToken>[1]): Promise<string>;
  client(token: string): Promise<Client>;
}

export async function startHarness(store?: RegistryStore): Promise<Harness> {
  const keys = await makeKeys();
  const registry = store ?? new MemoryRegistryStore(await loadDataset(FIXTURE), "fixture");
  const logs: Harness["logs"] = [];
  const logger: Logger = (level, event, fields = {}) => logs.push({ level, event, fields });

  // Bind first so the resource URL carries the real port.
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const resourceUrl = `${baseUrl}/mcp`;

  const handler = createApp({
    resourceUrl,
    issuer: ISSUER,
    requiredScope: SCOPE,
    scopesSupported: [SCOPE],
    serviceVersion: "test",
    verifier: new JwtVerifier({ issuer: ISSUER, audience: resourceUrl }, createLocalJWKSet(keys.jwks)),
    store: registry,
    logger: logger ?? silentLogger,
  });
  server.on("request", (req, res) => {
    void handler(req, res);
  });

  const clients: Client[] = [];
  return {
    baseUrl,
    resourceUrl,
    keys,
    store: registry,
    logs,
    token: (opts = {}) => mintToken(keys, { aud: resourceUrl, ...opts }),
    async client(token: string) {
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(resourceUrl), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Parse the structured payload of a successful tool call. */
export function structured<T = Record<string, any>>(result: unknown): T {
  const r = result as { isError?: boolean; structuredContent?: T; content?: { text: string }[] };
  if (r.isError) throw new Error(`Tool returned error: ${r.content?.[0]?.text}`);
  if (!r.structuredContent) throw new Error("No structuredContent");
  return r.structuredContent;
}

export function errorText(result: unknown): string {
  const r = result as { isError?: boolean; content?: { text: string }[] };
  if (!r.isError) throw new Error("Expected tool error");
  return r.content?.[0]?.text ?? "";
}
