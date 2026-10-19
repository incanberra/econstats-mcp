import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthFailure, authConfig, challenge, createVerifier, resourceMetadata, type AuthConfig } from "./auth";

export type HttpConfig = { host: string; auth: AuthConfig; origins: Set<string>; maxConcurrent: number };
const MAX_BODY = 1024 * 1024;

export function configuredPort(env: NodeJS.ProcessEnv): number {
  const raw = env.MCP_PORT || env.PORT || "0";
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error("MCP_PORT/PORT must be an integer from 0 to 65535.");
  if (Number(raw) === 0 && env.NODE_ENV === "production") throw new Error("Production requires an HTTP port greater than zero.");
  return Number(raw);
}

export function httpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const host = env.MCP_HOST || "127.0.0.1";
  const auth = authConfig(env, host);
  const origins = new Set<string>();
  for (const value of (env.MCP_ALLOWED_ORIGINS || "").split(",").filter(Boolean)) {
    const origin = value.trim();
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins."); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins.");
    origins.add(origin);
  }
  if (auth.mode === "oauth") origins.add(new URL(auth.publicUrl).origin);
  const maxConcurrent = Number(env.MCP_MAX_CONCURRENT || "16");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error("MCP_MAX_CONCURRENT must be an integer from 1 to 128.");
  return { host, auth, origins, maxConcurrent };
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY) throw 413;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw 413;
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw 400; }
}

export function createHttpServer(factory: () => McpServer, config: HttpConfig, verify = createVerifier(config.auth)): Server {
  let active = 0;
  let draining = false;
  const http = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const pathname = (req.url ?? "/").split("?", 1)[0];
    if (pathname === "/health" && ["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(draining ? 503 : 200, { "Content-Type": "text/plain" });
      res.end(draining ? "draining" : "ok"); return;
    }
    const origin = req.headers.origin;
    if (origin && !config.origins.has(origin)) { reply(res, 403, "Origin not allowed"); return; }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
    }
    if (config.auth.mode === "oauth" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(pathname)) {
      if (req.method !== "GET") { res.setHeader("Allow", "GET"); reply(res, 405, "Method not allowed"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resourceMetadata(config.auth))); return;
    }
    if (pathname !== "/mcp") { reply(res, 404, "Not found; use /mcp"); return; }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        "Access-Control-Max-Age": "600",
      }); res.end(); return;
    }
    if (draining) { reply(res, 503, "Server is restarting"); return; }
    if (active >= config.maxConcurrent) { res.setHeader("Retry-After", "1"); reply(res, 429, "Server is busy; retry later"); return; }
    // Count token verification and slow request bodies as well as MCP execution.
    active++;
    let released = false;
    let mcp: McpServer | undefined;
    const finish = () => {
      if (released) return;
      released = true; active--; clearTimeout(deadline);
      void mcp?.close().catch(() => {});
    };
    const deadline = setTimeout(() => {
      if (!res.headersSent) reply(res, 504, "Request timed out");
      else res.destroy();
    }, 90000);
    deadline.unref();
    res.once("close", finish);
    try {
      await verify(req.headers.authorization);
      if (res.destroyed || res.writableEnded) return;
      if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); reply(res, 405, "Use POST for stateless MCP"); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) { reply(res, 415, "Use application/json"); return; }
      const parsed = await body(req);
      if (res.destroyed || res.writableEnded) return;
      // A fresh transport AND server per request avoid reused-transport initialization
      // failures and cross-client response mixups. Data caches/budgets remain shared.
      mcp = factory();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof AuthFailure) {
        res.setHeader("WWW-Authenticate", challenge(config.auth, error.status));
        reply(res, error.status, error.status === 403 ? "Access denied" : "Authentication required");
      } else if (error === 413 || error === 400) reply(res, error, error === 413 ? "Request too large" : "Invalid JSON");
      else { console.error("[http] MCP request failed."); reply(res, 500, "MCP request failed"); }
    } finally {
      if (res.writableEnded || res.destroyed) finish();
    }
  });
  http.requestTimeout = 30000;
  http.headersTimeout = 10000;
  http.keepAliveTimeout = 5000;
  // Keep health checks useful during graceful shutdown.
  http.on("close", () => { draining = true; });
  Object.defineProperty(http, "econstatsDrain", { value: () => { draining = true; } });
  return http;
}

export function installShutdownHandlers(http: Server) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    (http as Server & { econstatsDrain: () => void }).econstatsDrain();
    console.error("[http] Draining requests before shutdown.");
    const deadline = setTimeout(() => { http.closeAllConnections(); process.exit(0); }, 10000);
    deadline.unref();
    http.close(() => { clearTimeout(deadline); process.exit(0); });
    http.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
