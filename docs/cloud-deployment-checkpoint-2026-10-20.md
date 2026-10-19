# EconStats cloud deployment checkpoint — 20 October 2026

## Goal and current state

Make the maintained EconStats MCP available from other computers and ChatGPT on
the web, using a personal Northflank deployment built directly from GitHub.
The hosted endpoint and ChatGPT OAuth tool discovery are working. Cloud provider
key validation and merging the deployment branch remain separate next steps.

## Authoritative locations

- Repository: https://github.com/incanberra/econstats-mcp
- Deployment branch: `codex/northflank-deployment`.
- Open draft PR: https://github.com/incanberra/econstats-mcp/pull/11
- Application baseline before this documentation checkpoint: `cd28a6696dea40033c7b534ed975a82f356028cf`.
- Hosting: Northflank, project `default`, service `econstatsmcp`.
- MCP: https://p01--econstatsmcp--yg9w56v8wz4m.code.run/mcp
- Health: https://p01--econstatsmcp--yg9w56v8wz4m.code.run/health
- OAuth resource metadata: https://p01--econstatsmcp--yg9w56v8wz4m.code.run/.well-known/oauth-protected-resource/mcp
- Auth0 issuer: https://dev-bgg7fp3b2l2ltjcr.us.auth0.com/
- Auth0 JWKS: https://dev-bgg7fp3b2l2ltjcr.us.auth0.com/.well-known/jwks.json
- ChatGPT app name: `EconStats`.

## Completed work

- Added a pinned Bun 1.3.10 Docker build, excluded local secrets and caches from
  its build context, and configured a non-root production container.
- Added authenticated stateless Streamable HTTP at `/mcp`, public `/health`,
  OAuth protected-resource metadata, bounded requests and graceful shutdown.
- Kept local stdio support. Provider clients, caches and budgets are shared
  inside a hosted process; each HTTP request gets a fresh MCP server/transport.
- Configured Northflank to build and deploy the GitHub deployment branch with
  continuous integration/deployment enabled, one instance and port 3000.
- Configured Auth0 API/resource and the `EconStats ChatGPT` regular web client,
  the `econstats:read` permission, user-delegated grant and exact ChatGPT callback.
  The API audience is the complete public `/mcp` URL. Auth0 resource-parameter
  compatibility was enabled during setup.
- Configured Northflank OAuth runtime variables and an explicit owner allowlist.
  The OAuth client secret belongs in the client connection settings, not the MCP
  server runtime.
- Diagnosed ChatGPT's “Authentication succeeded, action discovery failed” error.
  Safe request logs identified `subject_not_allowed`. The runtime subject value
  had been truncated to `auth0`; restoring the complete User ID fixed discovery.
- Confirmed ChatGPT listed all 35 tools after refreshing, with hosted
  `initialize` and `tools/list` requests returning HTTP 200.
- Documented how to add provider credentials as Northflank runtime variables.
  Local credentials do not automatically reach the hosted service.

## Validation and limits

- Application baseline `cd28a66`: all 213 offline tests passed locally; GitHub
  regression/typecheck and container checks passed. Container checks include
  anonymous rejection, real SDK discovery, non-root execution and shutdown.
- On 20 October 2026, `/health` returned HTTP 200 with `ok`, and the public OAuth
  resource metadata returned HTTP 200 with the correct resource, Auth0 issuer
  and `econstats:read` scope.
- OAuth sign-in and 35-tool discovery were verified in ChatGPT on 19 October.
  Those checks are not equivalent to live tests of every data provider.
- A fresh **local** MCP process loaded the newly saved BLS key and completed a
  live probe with HTTP 200 and `keyConfigured: true` on 20 October. This chat's
  already-running local MCP initially retained its old environment; saved keys
  are loaded when a process starts. Cloud BLS credentials remain unverified.
- The existing local `.env` also contained non-empty FRED, BEA, EIA and Comtrade
  entries. Their presence is not a live validity test or a cloud configuration
  check. No keys, client secrets or tokens are recorded in this checkpoint.
- Default cloud storage is memory-only. No durable volume/history migration was
  established. Keep one instance; the service is a trusted-owner deployment,
  not isolated per-user tenancy.
- The health page confirms process liveness only. Use the intended MCP client's
  `connection_health` tool with `probe: true` for live provider checks.

## Related work in this chat

- Packaged `oni-charts`, `oni-writing` and the writing QA dependency as the
  skills-only `analyst-writing-and-charts` plugin, including the font, palette,
  references and chart helper. The cloud plugin subsequently appeared in the
  installed skill catalogue. It is separate from the EconStats MCP deployment.
- Retrieved manufacturing employment from BLS through local EconStats and made
  PNG, SVG, PDF and CSV chart artefacts. The displayed comparison is September
  2016–September 2026; latest months are preliminary. Units/seasonal adjustment
  omitted by the MCP metadata were checked against the official BLS series page.
  These generated artefacts live in the chat workspace's `exports/` directory;
  they have not been added to this repository or deployed to Northflank.

## Next actions

1. In Northflank **Environment → Edit**, add or verify the provider keys needed:
   `FRED_API_KEY`, `BLS_API_KEY`, `BEA_API_KEY`, `EIA_API_KEY`, and
   `COMTRADE_API_KEY` for authenticated Comtrade. Preserve OAuth settings and the
   complete allowlisted User ID. Select **Update & restart**.
2. In the **cloud-connected** ChatGPT EconStats app, run `connection_health` with
   `probe: true` for at most three sources per call. Verify BLS reports
   `keyConfigured: true` and a healthy live result. Check remaining providers in
   further calls. Do not substitute a successful local check for this step.
3. Review PR #11. It remains an open draft; merging into `main` was not authorised
   by the checkpoint request. After a future merge, change Northflank's source
   branch to `main`, redeploy and verify OAuth discovery and provider access.
4. Add durable storage only if persistent revision history is required. Keep the
   current memory-only behaviour explicit until a writable volume is configured.

## Continuing safely

Work on the deployment checkout/branch rather than modifying the installed local
MCP or its private `.env`. Read the current Git status and PR before editing.
Runtime-variable changes require a restart; ChatGPT may also need **Refresh
tools** and a new chat. Use generic connection diagnostics, never raw tokens.
Keep the complete Auth0 User ID, including its `|`, when copying it; use a code
block or a separate value field rather than an unescaped Markdown table cell.
