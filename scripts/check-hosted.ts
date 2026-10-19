import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Read the token from an environment variable, never from CLI arguments or URLs.
// Only local protocol/health calls: no provider probes or data downloads.
const base = new URL(process.env.ECONSTATS_CHECK_URL || "http://127.0.0.1:3000");
if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("Use an origin-only ECONSTATS_CHECK_URL.");
if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Use HTTPS except for loopback tests.");
const token = process.env.ECONSTATS_CHECK_TOKEN;
if (!token) throw new Error("Set ECONSTATS_CHECK_TOKEN to a bearer secret or valid OAuth access token.");
const endpoint = new URL("/mcp", base);
let ready = false;
for (let n = 0; n < 60; n++) {
  try { if ((await fetch(new URL("/health", base), { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch {}
  await Bun.sleep(500);
}
if (!ready) throw new Error("Hosted health check did not become ready.");
const denied = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
if (denied.status !== 401) throw new Error("Unauthenticated MCP request was not rejected with 401.");
await denied.arrayBuffer();
await Promise.all(Array.from({ length: 2 }, async (_, n) => {
  const client = new Client({ name: `econstats-hosted-check-${n}`, version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    if ((await client.listTools()).tools.length !== 35) throw new Error("Expected 35 tools.");
    const result = await client.callTool({ name: "connection_health", arguments: { sources: ["FRED"], probe: false } });
    if (result.isError) throw new Error("Offline provider readiness call failed.");
    if ((await client.listTools()).tools.length !== 35) throw new Error("Repeated tool discovery failed.");
  } finally { await client.close(); }
}));
console.log("Hosted checks passed: health, authentication, concurrent clients, tool discovery and offline readiness.");
