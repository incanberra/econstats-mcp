import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "oauth"; issuer: string; audience: string; jwksUrl: string; publicUrl: string; scope: string; subjects: string[] };

export class AuthFailure extends Error {
  constructor(public status: 401 | 403, public reason: string = "invalid_token") { super("Access denied"); }
}

export function httpsUrl(value: string | undefined, name: string): string {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error(`${name} must be an absolute HTTPS URL without credentials, query or fragment.`); }
}

export function authConfig(env: NodeJS.ProcessEnv, host: string): AuthConfig {
  const mode = env.MCP_AUTH_MODE ?? (env.NODE_ENV === "production" ? "" : "none");
  if (mode === "none") {
    if (env.NODE_ENV === "production" || !["127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error("Unauthenticated HTTP is allowed only on loopback outside production.");
    }
    return { mode };
  }
  if (mode === "bearer") {
    const token = env.MCP_AUTH_TOKEN ?? "";
    if (token.length < 32 || /\s/.test(token)) throw new Error("Set MCP_AUTH_TOKEN to a random secret of at least 32 characters without whitespace.");
    return { mode, token };
  }
  if (mode === "oauth") {
    httpsUrl(env.MCP_OAUTH_ISSUER, "MCP_OAUTH_ISSUER");
    // JWT issuer comparison is exact; a root issuer need not have a trailing slash.
    const issuer = env.MCP_OAUTH_ISSUER!;
    const publicUrl = httpsUrl(env.MCP_PUBLIC_URL, "MCP_PUBLIC_URL");
    if (new URL(publicUrl).pathname !== "/mcp") throw new Error("MCP_PUBLIC_URL must end with /mcp.");
    const audience = env.MCP_OAUTH_AUDIENCE || publicUrl;
    const scope = env.MCP_OAUTH_SCOPE || "econstats:read";
    if (!/^[A-Za-z0-9:_./-]+$/.test(scope)) throw new Error("MCP_OAUTH_SCOPE must be one scope without spaces.");
    const subjects = (env.MCP_OAUTH_SUBJECTS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!subjects.length) throw new Error("MCP_OAUTH_SUBJECTS must allowlist at least one identity-provider user ID.");
    return { mode, issuer, publicUrl, audience, scope, subjects, jwksUrl: httpsUrl(env.MCP_OAUTH_JWKS_URL, "MCP_OAUTH_JWKS_URL") };
  }
  throw new Error("Set MCP_AUTH_MODE to oauth or bearer for hosted HTTP.");
}

export function resourceMetadata(config: Extract<AuthConfig, { mode: "oauth" }>) {
  return { resource: config.publicUrl, authorization_servers: [config.issuer], scopes_supported: [config.scope], bearer_methods_supported: ["header"], resource_name: "EconStats" };
}

export function challenge(config: AuthConfig, status: 401 | 403): string {
  if (config.mode !== "oauth") return 'Bearer realm="econstats"';
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).href;
  return `Bearer resource_metadata="${metadataUrl}", scope="${config.scope}", error="${status === 403 ? "insufficient_scope" : "invalid_token"}"`;
}

// The external authorization server handles sign-in, consent, PKCE and token issuance.
// Only asymmetric access tokens for this issuer/audience are accepted here.
export function createVerifier(config: AuthConfig, keys?: JWTVerifyGetKey) {
  const jwks = config.mode === "oauth" ? keys ?? createRemoteJWKSet(new URL(config.jwksUrl), { timeoutDuration: 5000 }) : undefined;
  const expected = config.mode === "bearer" ? createHash("sha256").update(config.token).digest() : undefined;
  return async (authorization: string | undefined): Promise<void> => {
    if (config.mode === "none") return;
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
    if (!match || match[1].length > 16384) throw new AuthFailure(401, "missing_or_malformed_authorization");
    if (config.mode === "bearer") {
      const actual = createHash("sha256").update(match[1]).digest();
      if (!timingSafeEqual(actual, expected!)) throw new AuthFailure(401);
      return;
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], jwks!, {
        issuer: config.issuer, audience: config.audience,
        algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "sub", "iat"], clockTolerance: 5,
      }));
    } catch (error) {
      // Log only fixed diagnostic categories, never tokens or claim values.
      const code = (error as { code?: string }).code;
      const claim = (error as { claim?: string }).claim;
      const reason = code === "ERR_JWT_CLAIM_VALIDATION_FAILED" && ["iss", "aud", "exp", "sub", "iat"].includes(claim ?? "")
        ? `invalid_claim_${claim}`
        : code === "ERR_JWT_EXPIRED" ? "expired_token"
        : code === "ERR_JWKS_TIMEOUT" ? "jwks_timeout"
        : "invalid_token";
      throw new AuthFailure(401, reason);
    }
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (!config.subjects.includes(payload.sub!)) throw new AuthFailure(403, "subject_not_allowed");
    if (!scopes.includes(config.scope)) throw new AuthFailure(403, "required_scope_missing");
  };
}
