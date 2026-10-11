# econstats-mcp

Economic data MCP server with an economist's methodology guide. Connects FRED, BLS, BEA, IMF, World Bank, and ECB to any MCP-compatible client.

## What makes it different

Not just data access — the server includes methodology rules that teach LLMs which series to pick:

- CPI vs PCE for inflation (and why they diverge)
- Prime-age EPOP vs headline unemployment for labor market tightness
- YoY % change for CPI/PPI indexes, monthly change for employment
- BLS direct on release day (FRED lags 30-60 minutes)
- Real wages: explains which of 4 measures it's using and why

## Quick Start

```bash
# Install Bun if needed
curl -fsSL https://bun.sh/install | bash

# Install from this fork; the npm econstats-mcp package is currently unpublished.
git clone https://github.com/incanberra/econstats-mcp.git
cd econstats-mcp
git switch fix-imf-sdmx
bun install --frozen-lockfile --ignore-scripts

# Optional: save FRED_API_KEY and BEA_API_KEY in a local .env (excluded from Git).
bun run src/index.ts
```

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "econstats": {
      "command": "bun",
      "args": ["--env-file=/absolute/path/econstats-mcp/.env", "run", "/absolute/path/econstats-mcp/src/index.ts"],
      "env": { "FRED_API_KEY": "your-key" }
    }
  }
}
```

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "econstats": {
      "type": "stdio",
      "command": "bun",
      "args": ["--env-file=/absolute/path/econstats-mcp/.env", "run", "/absolute/path/econstats-mcp/src/index.ts"],
      "env": { "FRED_API_KEY": "your-key" }
    }
  }
}
```

### Codex

Register the local source checkout (replace paths with your own):

```bash
codex mcp add econstats --env MCP_PORT=0 --env PORT=0 -- bun --env-file=/absolute/path/econstats-mcp/.env run /absolute/path/econstats-mcp/src/index.ts
```

On Windows, use absolute paths to `bun.exe`, `.env`, and `src/index.ts`. Restart Codex after registering or updating the server.

### OpenBB

Connect as an MCP server in the OpenBB workspace AI settings.

## API Keys

| Key | Required | Get it |
|-----|----------|--------|
| `FRED_API_KEY` | For FRED, inflation adjustment, and release calendar | https://fred.stlouisfed.org/docs/api/api_key.html (free) |
| `BLS_API_KEY` | Optional | https://data.bls.gov/registrationEngine/ (free, higher rate limits) |
| `BEA_API_KEY` | Optional | https://apps.bea.gov/API/signup/ (free, for GDP detail) |

IMF, World Bank, and ECB need no keys.

## Current IMF API

IMF retired the legacy `dataservices.imf.org` endpoint. IFS is no longer a single dataset: inflation, exchange rates, and national accounts now have separate topic datasets. This fork uses the public SDMX 2.1 API at `https://api.imf.org/external/sdmx/2.1`, requesting SDMX-CSV data and XML metadata.

1. Call `imf_list_datasets` with a topic (e.g. `inflation`, `GDP`, or `trade`).
2. Call `imf_get_structure` with the returned dataset ID to get the exact dimension order. Add `dimension_id` and `query` to look up country, indicator, and transformation codes.
3. Call `imf_get_data` with a fully specified `series_key`. Country/area codes in full keys are the IMF's current codes, usually ISO3. Dataset structure varies; legacy indicator codes are not interchangeable with current ones.

Examples of tool arguments:

```json
{
  "database_id": "CPI",
  "series_key": "USA+GBR.CPI._T.YOY_PCH_PA_PT.M",
  "start_period": "2024-01",
  "end_period": "2024-03",
  "limit": 3
}
```

```json
{
  "database_id": "ER",
  "series_key": "GBR.XDC_USD.PA_RT.M",
  "start_period": "2024-01",
  "end_period": "2024-03",
  "limit": 3
}
```

For CPI only, the existing `country_codes`/`indicator` interface remains supported with ISO2 or ISO3 countries. `PCPI_IX` maps to the headline index; `PCPI_PC_CP_A_PT` to year-over-year change; `PCPI_PC_PP_PT` to period-over-period change. These three shortcuts accept `database_id: "IFS"` for backward compatibility. Other legacy IFS indicators return an explicit migration error. `DOT` aliases the current `IMTS` dataset but requires a current `series_key`; BOP also requires its current key.

Results preserve reported units, powers-of-ten scales, reference periods, and observation-status flags. `limit` defaults to 36 observations per series (maximum 120); explicit period bounds also apply. Empty/wildcard key dimensions are rejected to avoid accidentally fetching every series. API failures are marked as MCP tool errors and are not cached as successful data.

Official references: [IMF API](https://data.imf.org/en/Resource-Pages/IMF-API), [IFS dataset transition](https://data.imf.org/en/news/accessing).

Run the offline regression tests with `bun test`.

## Caching

The server now uses a two-layer cache:

- L1: in-process memory cache for hot repeated queries in a single MCP process
- L2: optional shared Redis cache for cross-process or hosted deployments

If you are running a shared MCP endpoint for OpenBB users, set these optional env vars:

| Key | Required | Purpose |
|-----|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Optional | Shared cache backend URL |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Shared cache backend token |
| `CACHE_NAMESPACE` | Optional | Cache prefix, defaults to `econstats:v2` |
| `PREFETCH_HOT_SERIES` | Optional | Set to `true` only for long-lived hosted processes |

TTL policy is source-aware:

- Hot FRED series like `PAYEMS`, `UNRATE`, `CPIAUCSL`, `CPILFESL`, `PCEPILFE`: 15 minutes
- Standard FRED series: 6 hours
- BLS / BEA: 6-12 hours
- IMF / ECB: 24 hours
- World Bank and BLS lookup catalogs: days to weeks
- Release calendar: 15 minutes

The cache layer also deduplicates in-flight requests, so a burst of identical OpenBB tool calls only triggers one upstream API request.

Startup prefetch is disabled by default because short-lived stdio clients can create unnecessary upstream traffic. Turn it on only when you are running a persistent shared MCP service.

## Tools (13)

| Tool | Description |
|------|-------------|
| `fred_search` | Search FRED series by keyword |
| `fred_get_series` | Fetch FRED data with transformations (YoY%, change, etc.) |
| `bls_get_series` | Fetch BLS data with pre-computed YoY% and monthly changes |
| `bls_series_lookup` | Find BLS series IDs by keyword |
| `bea_get_data` | BEA national accounts (GDP components, state data) |
| `imf_list_datasets` | Search the current IMF dataset catalogue |
| `imf_get_structure` | Look up ordered dimensions and current codes |
| `imf_get_data` | Fetch current IMF SDMX data with source attribution |
| `worldbank_get_data` | World Bank development indicators (200+ countries) |
| `worldbank_search` | Search World Bank indicators |
| `ecb_get_data` | ECB data (euro area rates, HICP, money supply) |
| `inflation_adjust` | Convert dollar amounts between dates using CPI-U |
| `check_release_calendar` | Check if today is a data release day |

## Data Sources

All data comes from free, public government APIs. We attribute all data to its source agency (Federal Reserve, BLS, BEA, IMF, World Bank, ECB). No data is redistributed — each query fetches directly from the source.

## License

MIT
