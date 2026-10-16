# econstats-mcp

Economic data MCP server with an economist's methodology guide. Connects FRED, BLS, BEA, IMF, OECD, Eurostat, BIS, World Bank, and ECB to any MCP-compatible client.

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
git switch source-selector
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

IMF, OECD, Eurostat, BIS, World Bank, and ECB need no keys.

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

## OECD Data Explorer

OECD uses the current public SDMX API at `https://sdmx.oecd.org/public/rest`. No API key is required. The integration provides dataset discovery, dimension/code lookup, and data retrieval with English labels and source URLs.

1. Call `oecd_list_datasets` with a topic such as `inflation`, `GDP`, `unemployment`, or `productivity`. Results contain the exact `agency,dataset` identifier and version. Use `offset` and `limit` to page through matches.
2. Call `oecd_get_structure` with that `dataset_id`. It returns the ordered dimensions; use `dimension_id` and `query` to find country, measure, units, methodology, adjustment, or transformation codes. Codes in a codelist do not guarantee observations exist for every combination.
3. Call `oecd_get_data` with an explicit `series_key` in the returned dimension order. `+` combines codes in one dimension; wildcard/whole-dataset queries are rejected. The maximum selection is 50 series and 120 observations per series (default 36).

Verified inflation example:

```json
{
  "dataset_id": "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL",
  "version": "1.0",
  "series_key": "USA+GBR.M.N.CPI.PA._T.N.GY",
  "limit": 12
}
```

This dataset's order is `REF_AREA.FREQ.METHODOLOGY.MEASURE.UNIT_MEASURE.EXPENDITURE.ADJUSTMENT.TRANSFORMATION`: the example requests monthly national all-items consumer-price inflation, percent per annum, neither seasonally nor calendar adjusted, growth over one year. National CPI definitions can differ, including treatment of housing; do not assume the UK's national series is its inflation-target CPI. Preserve the specific series definition and country coverage in comparisons.

Responses retain dimension labels, observation dates, status flags, `UNIT_MULT` scaling, base periods, and retrieval timestamps. Missing observations are omitted and counted, never treated as zero. The returned URL identifies the exact query for citation. Dataset discovery and structure filters share cached metadata downloads; data responses are cached, while HTTP/rate-limit/malformed-response errors are not.

OECD currently limits downloads to 60 per hour. The connector does not immediately retry rate-limit errors. Some very large datasets block `lastNObservations`; supply `start_period` and preferably `end_period` to use a bounded request instead (the tool still returns only the latest `limit` observations from that range). This connector covers the `public` dissemination space; separate TiVA/CRS spaces are not included.

References: [OECD API](https://www.oecd.org/en/data/insights/data-explainers/2024/09/api.html), [API best practices](https://www.oecd.org/en/data/insights/data-explainers/2024/11/Api-best-practices-and-recommendations.html), [Restricted query parameters](https://www.oecd.org/en/data/insights/data-explainers/2026/03/Restricted-API-parameter.html).

## Eurostat

Eurostat provides current European economic statistics through public APIs. The integration uses its English catalogue, compressed SDMX metadata, and JSON-stat 2.0 observations. No API key or new dependency is required.

1. Call `eurostat_list_datasets` with a keyword or code. Results include coverage and update dates; use `offset`/`limit` for pagination. Older datasets can be discontinued or replaced, so check their coverage.
2. Call `eurostat_get_structure` with the selected `dataset_id`. It returns required non-time dimensions, code labels, dataset notes and coverage. Use `dimension_id` and `query` to find units, countries, adjustment or components.
3. Call `eurostat_get_data` with `filters` mapping **every non-time dimension** to an array of exact codes. Filters are checked against metadata before observations are downloaded. Maximum 50 series and 120 time positions (default 36). Broad/wildcard queries are rejected.

Current HICP inflation example:

```json
{
  "dataset_id": "prc_hicp_minr",
  "filters": {
    "freq": ["M"],
    "unit": ["RCH_A"],
    "coicop18": ["TOTAL"],
    "geo": ["DE", "FR"]
  },
  "limit": 12
}
```

This requests monthly all-items HICP annual inflation for Germany and France. Eurostat's old `prc_hicp_manr` dataset covers 1997–2025 and is replaced by `prc_hicp_minr`; the current classification uses `coicop18=TOTAL` rather than the old `coicop=CP00`. Inspect metadata instead of translating codes by guesswork.

Quarterly real GDP growth example:

```json
{
  "dataset_id": "namq_10_gdp",
  "filters": {
    "freq": ["Q"],
    "unit": ["CLV_PCH_PRE"],
    "s_adj": ["SCA"],
    "na_item": ["B1GQ"],
    "geo": ["DE", "FR"]
  },
  "limit": 4
}
```

`start_period` and `end_period` are inclusive. Without bounds, `limit` selects the latest **time positions in the dataset**, not a guaranteed number of non-missing values for each country. Numeric results retain exact units, rate/index definitions, adjustments and status flags; missing values are omitted and counted rather than replaced with zero. Each response includes dataset notes, an exact query URL, a Data Browser link, dataset update date and retrieval timestamp. Eurostat publishes revised current data; this integration is not a historical-vintage archive.

The first catalogue search can take tens of seconds while the complete English catalogue downloads. Catalogue and structures are cached across searches/filters; observations are cached separately. Malformed responses, HTTP failures, rate limits and queued asynchronous responses are marked as MCP errors and are not cached as observations. Main Eurostat datasets are supported; separate `DS-`/Comext endpoints and bulk asynchronous downloads are outside this integration.

References: [Eurostat API introduction](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction), [Statistics API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/api), [SDMX metadata](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/sdmx2.1), [Catalogue](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started/catalogue-api).

## BIS

BIS coverage uses the current public SDMX REST v2 API, with SDMX 2.1 metadata and labelled CSV observations. No API key or additional dependency is required. Dataset discovery covers credit, debt service, international banking, property prices, exchange rates, policy rates, derivatives and other published `WS_` statistical dataflows.

1. Use `bis_list_datasets` to search dataset IDs and current versions, with `query`, `offset` and `limit`.
2. Inspect `bis_get_structure` for ordered key dimensions and definitions. Use `dimension_id` and `query` to look up codes. Available codelists do not guarantee available observations.
3. Use `bis_get_data` with every dimension explicitly selected in `series_key`; join alternatives using `+`. Codes and key positions are checked before download. Maximum 50 series and 120 observations per series, default 36.

Examples (inspect metadata first):

| Dataset | Key | Definition |
|---|---|---|
| `WS_CBPOL` | `M.US+GB` | Monthly central-bank policy rates, end of period |
| `WS_TC` | `Q.US+GB.P.A.M.770.A` | Private non-financial credit from all lenders, market value, percentage of GDP, adjusted for breaks |
| `WS_DSR` | `Q.US+GB.P` | Quarterly private non-financial debt service ratios |
| `WS_SPP` | `Q.US+GB.R.628` | Real residential property prices, index 2010=100 |
| `WS_EER` | `M.R.B.US+GB` | Real effective exchange rates, broad basket |

For example, request `{"dataset_id":"WS_TC","series_key":"Q.US+GB.P.A.M.770.A","limit":4}`. The current credit dataflow version is 2.0; citations pin the version resolved from metadata. Specify `start_period`/`end_period` for an inclusive historical range (annual, monthly, quarterly, half-yearly or daily). The connector uses REST v2 time component constraints and displays the latest `limit` observations within the range for each series.

Responses retain unit/scaling/base definitions, observation status, source and compilation notes, and break information. Dataset and series attributes are distinguished from key dimensions even when CSV puts attributes before time. Missing values are omitted and counted; country series are kept separate. HTTP failures, malformed CSV, conflicting observations and incompatible units are reported as MCP errors rather than cached observations. Each response includes the exact versioned API query, retrieval timestamp and BIS attribution. Latest periods and country coverage can differ; data are current revised observations rather than historical vintages.

References: [BIS API documentation](https://stats.bis.org/api-doc/v2/), [BIS statistics](https://data.bis.org/topics), [Terms of permitted use](https://data.bis.org/help/legal).

## Choosing a source

Call `select_source` before choosing between overlapping providers. It uses a deterministic, curated registry of exact statistical definitions and geography/frequency rules, then optionally checks current metadata and observations. It returns ranked candidates, reasons, key readiness, concrete retrieval calls, checked country periods, latest common period, observation counts, age and provenance links. It recommends only a candidate meeting the requested coverage; failed, sparse, missing-key and stale candidates remain visible.

Example: `{"measure":"headline_cpi_yoy","countries":["US","GB"],"observations":12}` checks national CPI year-on-year definitions through OECD and IMF. `hicp_yoy` is a separate measure. `real_gdp_growth_qoq`, `real_gdp_growth_annualized` and `real_gdp_level` are distinct. Use `preferred_source` to preserve an explicit source override, `max_age_days` to require a freshness threshold, and `verify:false` for an explicitly unverified plan without network requests.

For comparisons the selector requests extra history to accommodate country publication lags, finds common periods and instructs the caller to restrict its analysis to those periods. FRED period-start dates, BEA quarter labels and IMF monthly labels are normalised before alignment. BLS indexes or payroll levels without the requested calculations cannot verify inflation or monthly job-change requests. The calling assistant should extract the exact measure from the user's question and clarify ambiguous definitions before invoking the tool.

- Honor the user's requested source and measure definition.
- Choose by topic, geography, frequency, comparable definitions and actual usable coverage. Prefer original producers for release-day national statistics; FRED remains a convenient redistribution service.
- Use BIS for harmonised credit and financial statistics; Eurostat for European inflation/national accounts; ECB for its monetary policy and banking statistics; OECD/IMF for suitable international comparisons; World Bank for long-run development indicators.
- Inspect definitions and observation dates, use common periods for comparisons, and disclose stale data, definition differences and any fallback. Never silently switch CPI/CPIH/HICP, nominal/real series, growth conventions or sectors.
- Explain why the source fits and cite the series, units, period, URL and retrieval date.

The registry is not an exhaustive catalogue search. Some recognised measures/geographies still require provider discovery; the selector declines an exact recommendation rather than inventing a mapping. Checks sample available observations, not all historical vintages. Provider caches may be reused; retrieval/check timestamps do not guarantee that a release page has already propagated to its API. A preferred source is never silently replaced. Source recommendations are not evidence for economic figures: retrieve and cite the actual data using the returned plan.

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
- IMF / OECD data / ECB: 24 hours
- OECD catalogue and structures: 7 days
- Eurostat data: 6 hours; catalogue and structures: 24 hours
- BIS data: 6 hours; catalogue and structures: 7 days
- World Bank and BLS lookup catalogs: days to weeks
- Release calendar: 15 minutes

The cache layer also deduplicates in-flight requests, so a burst of identical OpenBB tool calls only triggers one upstream API request.

Startup prefetch is disabled by default because short-lived stdio clients can create unnecessary upstream traffic. Turn it on only when you are running a persistent shared MCP service.

## Tools (23)

| Tool | Description |
|------|-------------|
| `select_source` | Recommend exact-measure sources with reasons, retrieval plans and optional verified coverage |
| `fred_search` | Search FRED series by keyword |
| `fred_get_series` | Fetch FRED data with transformations (YoY%, change, etc.) |
| `bls_get_series` | Fetch BLS data with pre-computed YoY% and monthly changes |
| `bls_series_lookup` | Find BLS series IDs by keyword |
| `bea_get_data` | BEA national accounts (GDP components, state data) |
| `imf_list_datasets` | Search the current IMF dataset catalogue |
| `imf_get_structure` | Look up ordered dimensions and current codes |
| `imf_get_data` | Fetch current IMF SDMX data with source attribution |
| `oecd_list_datasets` | Search and page through the current OECD catalogue |
| `oecd_get_structure` | Look up ordered dimensions and code labels |
| `oecd_get_data` | Fetch OECD observations with labels, units, status and citations |
| `eurostat_list_datasets` | Search Eurostat datasets with coverage and update dates |
| `eurostat_get_structure` | Inspect required filters, code labels, coverage and dataset notes |
| `eurostat_get_data` | Fetch Eurostat observations with units, flags and citation URLs |
| `bis_list_datasets` | Discover BIS credit, banking, property-price, rate and other statistical datasets |
| `bis_get_structure` | Inspect ordered BIS dimensions, definitions and code labels |
| `bis_get_data` | Fetch BIS observations with units, compilation notes, flags and citation URLs |
| `worldbank_get_data` | World Bank development indicators (200+ countries) |
| `worldbank_search` | Search World Bank indicators |
| `ecb_get_data` | ECB data (euro area rates, HICP, money supply) |
| `inflation_adjust` | Convert dollar amounts between dates using CPI-U |
| `check_release_calendar` | Check if today is a data release day |

## Data Sources

All data comes from public official statistical APIs. We attribute data to its source agency (Federal Reserve, BLS, BEA, IMF, OECD, Eurostat, BIS, World Bank, ECB). Queries fetch from the source or reuse a cached source response.

## License

MIT
