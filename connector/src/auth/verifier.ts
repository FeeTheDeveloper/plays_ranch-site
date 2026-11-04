import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.js";

/** A validated caller. `subject` is the stable user id from the authorization server. */
export interface Principal {
  subject: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  token: string;
}

export class AuthError extends Error {
  constructor(
    readonly code: "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

/** Collects scopes from the common claim shapes: `scope` (string), `scp` / `permissions` (arrays). */
export function scopesFromClaims(claims: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (typeof claims.scope === "string") claims.scope.split(/\s+/).filter(Boolean).forEach((s) => out.add(s));
  for (const key of ["scp", "permissions"]) {
    const v = claims[key];
    if (Array.isArray(v)) v.filter((s): s is string => typeof s === "string").forEach((s) => out.add(s));
    else if (typeof v === "string") v.split(/\s+/).filter(Boolean).forEach((s) => out.add(s));
  }
  return [...out];
}

function audienceMatches(aud: unknown, expected: string): boolean {
  const norm = (s: string) => s.replace(/\/$/, "");
  if (typeof aud === "string") return norm(aud) === norm(expected);
  if (Array.isArray(aud)) return aud.some((a) => typeof a === "string" && norm(a) === norm(expected));
  return false;
}

function principalFromClaims(claims: JWTPayload & Record<string, unknown>, token: string): Principal {
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new AuthError("invalid_token", "Token has no subject");
  }
  const clientId =
    (typeof claims.client_id === "string" && claims.client_id) ||
    (typeof claims.azp === "string" && claims.azp) ||
    "unknown";
  return {
    subject: claims.sub,
    clientId,
    scopes: scopesFromClaims(claims),
    expiresAt: typeof claims.exp === "number" ? claims.exp : undefined,
    token,
  };
}

/** Verifies JWT access tokens against the authorization server's JWKS. */
export class JwtVerifier implements TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly opts: { issuer: string; audience: string; jwksUrl?: string },
    keys?: JWTVerifyGetKey,
  ) {
    if (keys) this.keys = keys;
    else if (opts.jwksUrl) this.keys = createRemoteJWKSet(new URL(opts.jwksUrl));
    else throw new Error("JwtVerifier requires a JWKS URL or key resolver");
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
        clockTolerance: 30,
      });
      return principalFromClaims(payload as JWTPayload & Record<string, unknown>, token);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError("invalid_token", "Access token failed verification");
    }
  }
}

/** Verifies opaque access tokens with RFC 7662 token introspection. */
export class IntrospectionVerifier implements TokenVerifier {
  constructor(
    private readonly opts: {
      issuer: string;
      audience: string;
      introspectionUrl: string;
      clientId: string;
      clientSecret: string;
      /** Accept tokens whose introspection response carries no aud. Off by default. */
      allowMissingAudience?: boolean;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(token: string): Promise<Principal> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.introspectionUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new AuthError("invalid_token", "Token introspection unavailable");
    }
    if (!res.ok) throw new AuthError("invalid_token", "Token introspection rejected");
    const claims = (await res.json()) as Record<string, unknown>;
    if (claims.active !== true) throw new AuthError("invalid_token", "Token is not active");
    if (claims.iss !== undefined && claims.iss !== this.opts.issuer) {
      throw new AuthError("invalid_token", "Token issuer mismatch");
    }
    if (claims.aud === undefined) {
      if (!this.opts.allowMissingAudience) throw new AuthError("invalid_token", "Token has no audience");
    } else if (!audienceMatches(claims.aud, this.opts.audience)) {
      throw new AuthError("invalid_token", "Token audience mismatch");
    }
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      throw new AuthError("invalid_token", "Token expired");
    }
    return principalFromClaims(claims as JWTPayload & Record<string, unknown>, token);
  }
}

export function createVerifier(config: Config): TokenVerifier {
  const a = config.auth;
  if (a.mode === "jwt") {
    return new JwtVerifier({ issuer: a.issuer, audience: a.audience, jwksUrl: a.jwksUrl });
  }
  return new IntrospectionVerifier({
    issuer: a.issuer,
    audience: a.audience,
    introspectionUrl: a.introspectionUrl!,
    clientId: a.introspectionClientId!,
    clientSecret: a.introspectionClientSecret!,
    allowMissingAudience: a.allowMissingAudience,
  });
}

export function requireScope(principal: Principal, scope: string): void {
  if (!principal.scopes.includes(scope)) {
    throw new AuthError("insufficient_scope", `Token is missing required scope ${scope}`);
  }
}
