# Deploy EconStats from GitHub to Northflank

This prepares a single-owner hosted EconStats service. All allowed users share the
configured provider credentials, data caches, revision history and upstream request
budgets. It is not a multi-tenant service. Do not grant access to untrusted users.

The repository contains a pinned Bun Docker build and automated protocol/container
checks. No Northflank API token, GitHub Actions deployment secret or paid database
is needed for Northflank to build directly from GitHub. The container runs as the
unprivileged `bun` user and refuses to start without hosted authentication.

## 1. Choose the Sandbox and check the estimate

Use **Northflank managed cloud → Developer Sandbox**, not bring-your-own-cloud.
Northflank currently advertises two free always-on services, one database and two
jobs. It requires a payment method. Review the selected plan and resource estimate
before creating anything: do not select paid compute, volumes or addons for a $0
start. This guide does not promise that extra storage or egress is free.

Sources checked 19 October 2026:
[pricing](https://northflank.com/pricing),
[billing requirements](https://northflank.com/docs/v1/application/billing/pricing-on-northflank).

## 2. Connect GitHub and configure one combined service

Link the GitHub account and grant Northflank access to `incanberra/econstats-mcp`.
Create a project and a **combined build and deployment service**:

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/incanberra/econstats-mcp` |
| Branch | The deployment PR branch for preview; `main` once merged |
| Build | Dockerfile |
| Dockerfile | `/Dockerfile` (repository root) |
| Build context | `/` (repository root) |
| Command / entrypoint override | None; use the image default |
| Instances | 1 |
| Resources | Select the free Sandbox allocation and confirm the estimate |
| Port | `3000`, HTTP, publicly exposed |
| Health check | HTTP `GET /health`, port `3000` |
| Health timings | Start with 10-second interval, 5-second timeout, 3 failures; allow 30 seconds to start |

The image binds `0.0.0.0` and sets `PORT=3000`; keep the service port aligned.
Northflank terminates HTTPS. Clients use **`https://<assigned-host>/mcp`**;
health checks use `/health`. `/` deliberately returns 404. Health is process
liveness, not provider connectivity, credential validity or persistent-storage
readiness. Use the `connection_health` tool for provider checks.

Northflank can assign the public hostname while the first deployment is waiting
for authentication settings. A failed start without authentication is intentional.
Record the exact assigned hostname for OAuth, then add the variables and redeploy.

References: [build and deploy](https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code),
[ports](https://northflank.com/docs/v1/application/network/configure-ports),
[health checks](https://northflank.com/docs/v1/application/observe/configure-health-checks).

## 3. Configure authentication

### ChatGPT and other OAuth web clients

Set the following **runtime** variables (secret groups are suitable). Never pass
credentials as Docker build arguments or commit real `.env` files.

| Variable | Value |
| --- | --- |
| `MCP_AUTH_MODE` | `oauth` |
| `MCP_PUBLIC_URL` | `https://<assigned-host>/mcp` |
| `MCP_OAUTH_ISSUER` | The exact HTTPS issuer used in the identity provider's access tokens |
| `MCP_OAUTH_JWKS_URL` | Its HTTPS signing-key endpoint (`jwks_uri` in the provider's discovery document) |
| `MCP_OAUTH_AUDIENCE` | The resource/API identifier in its access tokens; defaults to `MCP_PUBLIC_URL` |
| `MCP_OAUTH_SCOPE` | `econstats:read`, or one configured permission scope |
| `MCP_OAUTH_SUBJECTS` | Your identity provider user ID (`sub`), or a comma-separated allowlist of trusted IDs |

**An external OAuth authorization server must be configured separately.** This
repository is the protected resource server; it does not create user accounts,
present a login form, register clients or issue access/refresh tokens. Use an
identity provider supporting the MCP authorization flow:

1. Register an EconStats API/resource with audience equal to the final `/mcp` URL
   where supported. Define the `econstats:read` scope and restrict grants to your
   trusted account(s).
2. Enable authorization-code flow with PKCE S256, HTTPS discovery and the client
   registration method your MCP client supports (CIMD/DCR or a provided registered
   client where supported). Configure the client's exact callback URI from its
   connection screen. Follow the provider's MCP integration instructions.
3. Issue asymmetrically signed **JWT access tokens** containing `iss`, `aud`, `sub`,
   `iat`, `exp` and a space-delimited `scope` claim. Supported algorithms are RS256,
   PS256, ES256 and EdDSA. Opaque tokens and ID tokens are not supported. Configure
   the API audience/scope so ID tokens cannot satisfy the access-token checks.
4. Copy only the issuer URL, JWKS URL, API audience, scope and your user ID into the
   above variables. The service does not need the OAuth client's secret. Do not
   log tokens or put them in URLs.
5. In the web app, add the public `/mcp` URL and choose OAuth. Register/enter any
   client details in that app, then complete sign-in and tool discovery.

The server advertises RFC 9728 resource metadata at both
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource`, and includes discovery in its `401`
challenge. It validates JWT signature, issuer, audience, expiration, owner
allowlist and required scope for **every** MCP request. Invalid credentials return
401; a valid token without permission returns 403. No provider calls are made
before authorization. The issuer/JWKS URLs are administrator-configured; discovery
never trusts request Host/forwarded headers.

The identity provider must advertise the relevant OAuth metadata at its own
issuer. Adding the above variables alone does not implement the sign-in flow.
Verify the complete login in the intended client before treating it as ready for
ChatGPT use. See [OpenAI's MCP authentication contract](https://developers.openai.com/plugins/build/auth).

### Simpler alternative: clients that can send an Authorization header

Use `MCP_AUTH_MODE=bearer` plus `MCP_AUTH_TOKEN` containing at least 32 random
characters. Generate a fresh 32-byte or longer random secret using your password
manager or local cryptographic tooling. Put it in a Northflank secret and the
client's `Authorization: Bearer <secret>` header. Never use example/test tokens.
This is a shared secret, not OAuth; do not select OAuth in the client or assume
ChatGPT's custom server form can accept an arbitrary fixed token. Use the OAuth
setup above for ChatGPT.

### Optional browser access

Server-to-server clients do not need CORS. For a browser frontend, set
`MCP_ALLOWED_ORIGINS` to comma-separated exact origins, for example
`https://your-web-app.example`. Wildcards are rejected. The browser still needs
authorization; do not embed a shared bearer secret or provider keys in public
frontend code. Browser requests from unlisted origins receive 403.

## 4. Add provider keys as runtime secrets

Add only the provider credentials you use: `FRED_API_KEY`, `BEA_API_KEY`,
`EIA_API_KEY`, optional `BLS_API_KEY`, and optional `COMTRADE_API_KEY`.
The other public providers require no keys through this server.
The repository's `.env.example` contains names and examples only. The Docker
build context allowlist excludes `.env`, private keys, Git history and local data.

Keep `PREFETCH_HOT_SERIES=false` (the image default) for a small personal service.
`MCP_MAX_CONCURRENT` defaults to 16; excess requests receive 429 with `Retry-After`.
Bodies are limited to 1 MiB, each request has a 90-second deadline, and each POST
gets a separate stateless MCP server/transport with shared provider caches/budgets.
GET/DELETE on `/mcp` return 405: there is no long-lived SSE/session channel. Clients
must support standard Streamable HTTP with JSON responses.

## 5. Choose storage explicitly

**No-volume / $0 starting configuration:** the image sets
`ECONSTATS_DISK_CACHE=false`. Responses, local budgets, cooldowns and observed
revision history are in memory and reset on a restart/redeploy. Existing history
on your computer is not uploaded or migrated. Do not represent this as a durable
vintage archive.

**Durable history:** first confirm the volume is available within your budget.
Mount a volume at `/data`, ensure it is writable by the image's `bun` user, and set:

```dotenv
ECONSTATS_DISK_CACHE=true
ECONSTATS_CACHE_DIR=/data/econstats
```

Keep one service instance. File budgets/history are coordinated only on shared
local storage, not across unrelated containers. Do not assume a free database
addon persists the current file-based history. An Upstash cache can persist data
responses but does not persist revision history or local request budgets.

## 6. Verify before using it

The GitHub Checks workflow runs source tests and builds the actual production
image on Linux, then tests health, denied anonymous access, concurrent real MCP
clients, all 35 tool schemas, offline readiness and a non-root runtime. It also
checks that an unconfigured production container fails and shutdown exits cleanly.

After deployment:

1. Open `https://<assigned-host>/health`; expect `ok`.
2. An unauthenticated POST to `/mcp` must return 401; an unlisted browser Origin
   must return 403. For OAuth, inspect the public resource metadata and complete
   sign-in from the intended web app.
3. With a bearer secret or freshly obtained OAuth access token in your local
   environment (never literal CLI arguments), run:

   ```text
   ECONSTATS_CHECK_URL=https://<assigned-host>
   ECONSTATS_CHECK_TOKEN=<set privately in your local environment>
   bun run check:hosted
   ```

   The first two lines describe environment settings, not shell commands. On
   Windows, set them in PowerShell or your local environment editor. This check
   makes no upstream provider probes or data requests and prints no token values.
4. Call `connection_health` in the client with `probe=false`, then explicitly test
   only the providers you use with `probe=true` (up to three per call). Probe calls
   consume provider budgets. Verify one bounded data query and its citations.
5. If using a persistent volume, fetch a series, restart the service, then verify
   its `revision_history` still exists. Memory-only history should reset.

HTTP errors and logs omit request headers, token values, provider credentials and
raw exception details. `/health` is deliberately public and returns no secrets.
Liveness is intentionally separate from external-provider availability so an
upstream outage does not cause container restart loops.

## Local development

With no port set, stdio behaves as before. Development HTTP without authentication
is allowed only on a loopback host outside `NODE_ENV=production`. For a local test,
set `MCP_PORT=3000` and leave `MCP_HOST` at its default `127.0.0.1`. Use `/mcp`.
For Docker testing, pass the same hosted auth variables as above and publish only
to loopback, for example `-p 127.0.0.1:3000:3000`. Stop with SIGTERM/SIGINT; the
server drains active requests for up to 10 seconds before closing connections.
