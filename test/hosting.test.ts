import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthFailure, authConfig, createVerifier, type AuthConfig } from "../src/hosting/auth";
import { configuredPort, createHttpServer, httpConfig } from "../src/hosting/http";

const token = "test-only-" + "a".repeat(48);
let child: ReturnType<typeof Bun.spawn>;
let base: string;
let stderr: Promise<string>;

beforeAll(async () => {
  const reservation = createServer();
  const reservedUrl = await listen(reservation);
  const port = new URL(reservedUrl).port;
  await close(reservation);
  // Explicitly isolate from developer provider credentials, .env and disk history.
  child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "../src/index.ts")], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: "production", MCP_HOST: "127.0.0.1", PORT: port, MCP_AUTH_MODE: "bearer", MCP_AUTH_TOKEN: token, MCP_ALLOWED_ORIGINS: "https://allowed.example", ECONSTATS_DISK_CACHE: "false", PREFETCH_HOT_SERIES: "false" },
    stdout: "pipe", stderr: "pipe",
  });
  stderr = new Response(child.stderr).text();
  base = reservedUrl;
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error("HTTP test server exited before readiness");
    await Bun.sleep(50);
  }
  throw new Error("HTTP test server did not become ready");
});

afterAll(async () => {
  child?.kill();
  if (child) {
    await child.exited;
    const logs = await stderr;
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("private_tool_name");
    expect(logs).toContain("tool=connection_health");
    expect(logs).toContain("request_id=");
    expect(logs).toContain("version=3.2.1");
  }
});

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

test("hosted configuration fails closed; development stdio remains available", () => {
  expect(() => httpConfig({ NODE_ENV: "production", MCP_HOST: "0.0.0.0" })).toThrow("MCP_AUTH_MODE");
  expect(() => httpConfig({ NODE_ENV: "production", MCP_HOST: "0.0.0.0", MCP_AUTH_MODE: "none" })).toThrow("loopback");
  expect(() => httpConfig({ MCP_HOST: "0.0.0.0" })).toThrow("loopback");
  expect(() => httpConfig({ MCP_AUTH_MODE: "bearer", MCP_AUTH_TOKEN: "short" })).toThrow("32");
  expect(() => httpConfig({ MCP_ALLOWED_ORIGINS: "*" })).toThrow("origins");
  expect(() => configuredPort({ PORT: "3000oops" })).toThrow("integer");
  expect(() => configuredPort({ PORT: "65536" })).toThrow("integer");
  expect(() => configuredPort({ NODE_ENV: "production", PORT: "0" })).toThrow("greater than zero");
  expect(configuredPort({})).toBe(0);
  expect(configuredPort({ MCP_PORT: "0", PORT: "3000" })).toBe(0);
  expect(httpConfig({}).host).toBe("127.0.0.1");
  expect(authConfig({ MCP_AUTH_MODE: "oauth", MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_OAUTH_ISSUER: "https://identity.example", MCP_OAUTH_JWKS_URL: "https://identity.example/jwks", MCP_OAUTH_SUBJECTS: "owner" }, "0.0.0.0")).toMatchObject({ issuer: "https://identity.example" });
});

test("public health works but missing/wrong credentials cannot discover or call tools", async () => {
  const health = await fetch(`${base}/health`);
  expect(await health.text()).toBe("ok");
  expect(health.headers.get("x-econstats-version")).toBe("3.2.1");
  expect(health.headers.get("x-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  for (const path of ["/mcp", "/mcp?token=ignored"]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  }
  expect((await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, Authorization: "Bearer incorrect" }, body: "{}" })).status).toBe(401);
});

test("routing, browser origins, preflight, JSON and body limits are enforced", async () => {
  expect((await fetch(`${base}/`)).status).toBe(404);
  expect((await fetch(`${base}/.env`)).status).toBe(404);
  expect((await fetch(`${base}/mcp`, { headers })).status).toBe(405);
  const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: "{}" });
  expect(denied.status).toBe(403);
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { Origin: "https://allowed.example", "Access-Control-Request-Headers": "authorization,mcp-protocol-version" } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
  expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: "broken" })).status).toBe(400);
  expect((await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
  expect((await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(1024 * 1024) }) })).status).toBe(413);
  const invalidTool = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "private_tool_name", arguments: {} } }) });
  await invalidTool.text();
});

test("multiple real SDK clients can initialize, discover and call tools concurrently", async () => {
  await Promise.all(Array.from({ length: 4 }, async (_, n) => {
    const client = new Client({ name: `hosted-regression-${n}`, version: "1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("SOURCE ROUTING");
      const list = await client.listTools();
      expect(list.tools).toHaveLength(41);
      const result = await client.callTool({ name: "connection_health", arguments: { sources: ["FRED"], probe: false } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain(token);
      // A second call catches accidental reuse of a stateless HTTP transport.
      expect((await client.listTools()).tools).toHaveLength(41);
    } finally { await client.close(); }
  }));
}, 20000);

test("OAuth verifies signatures, issuer, audience, expiry, scope and owner allowlist", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  const config = authConfig({ MCP_AUTH_MODE: "oauth", MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_OAUTH_ISSUER: "https://identity.example/", MCP_OAUTH_JWKS_URL: "https://identity.example/jwks", MCP_OAUTH_SUBJECTS: "owner" }, "0.0.0.0") as Extract<AuthConfig, { mode: "oauth" }>;
  const verify = createVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  const sign = async (extra = {}, issuer = config.issuer, audience = config.audience, subject = "owner", expires: string | number = "5m", key = privateKey) => new SignJWT({ scope: "econstats:read", ...extra }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime(expires).sign(key);
  await expect(verify(`Bearer ${await sign()}`)).resolves.toBeUndefined();
  for (const invalid of [
    await sign({}, "https://other.example/"),
    await sign({}, config.issuer, "other-audience"),
    await sign({}, config.issuer, config.audience, "owner", Math.floor(Date.now() / 1000) - 60),
    await sign({}, config.issuer, config.audience, "owner", "5m", (await generateKeyPair("RS256")).privateKey),
  ]) await expect(verify(`Bearer ${invalid}`)).rejects.toMatchObject({ status: 401 });
  await expect(verify(`Bearer ${await sign({ scope: "other" })}`)).rejects.toMatchObject({ status: 403 });
  await expect(verify(`Bearer ${await sign({}, config.issuer, config.audience, "stranger")}`)).rejects.toMatchObject({ status: 403 });
  await expect(verify(undefined)).rejects.toBeInstanceOf(AuthFailure);
  await expect(verify("Bearer opaque-token")).rejects.toMatchObject({ status: 401 });
  expect(() => authConfig({ MCP_AUTH_MODE: "oauth", MCP_PUBLIC_URL: "http://mcp.example/mcp" }, "0.0.0.0")).toThrow("HTTPS");
});

test("OAuth resource discovery and challenges advertise the configured URL, never the Host header", async () => {
  const config = httpConfig({ MCP_AUTH_MODE: "oauth", MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_OAUTH_ISSUER: "https://identity.example/", MCP_OAUTH_JWKS_URL: "https://identity.example/jwks", MCP_OAUTH_SUBJECTS: "owner" });
  const http = createHttpServer(() => new McpServer({ name: "metadata", version: "1" }), config);
  const url = await listen(http);
  try {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const discovery = await fetch(`${url}${path}`, { headers: { Host: "spoofed.example" } });
      expect(await discovery.json()).toMatchObject({ resource: "https://mcp.example/mcp", authorization_servers: ["https://identity.example/"], scopes_supported: ["econstats:read"] });
    }
    const denied = await fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Host: "spoofed.example" }, body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain('resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"');
    expect(denied.headers.get("www-authenticate")).not.toContain("spoofed");
  } finally { await close(http); }
});

test("concurrency is bounded before authentication completes", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const http = createHttpServer(() => new McpServer({ name: "limits", version: "1" }), { ...httpConfig({}), maxConcurrent: 1 }, async () => { entered(); await pending; });
  const url = await listen(http);
  let first: Promise<Response> | undefined;
  try {
    first = fetch(`${url}/mcp`);
    await started;
    expect((await fetch(`${url}/mcp`)).status).toBe(429);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    release();
    expect((await first).status).toBe(405);
  } finally { release(); await first; await close(http); }
});

async function listen(http: Server) {
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}
async function close(http: Server) {
  await new Promise<void>((resolve, reject) => {
    http.close(error => error ? reject(error) : resolve());
    http.closeAllConnections();
  });
}
