# econstats-mcp

Economic data MCP server with an economist's methodology guide. Connects FRED, BLS, BEA, IMF, OECD, Eurostat, BIS, EIA, World Bank, ECB, ABS, UN Comtrade, IMF PortWatch and FAOSTAT to any MCP-compatible client.

## Version 3.2: shipping, food and fertiliser security

Adds **six tools**, bringing the server to **41 tools across 14 providers**:

- **IMF PortWatch:** search ports/chokepoints, inspect fields and retrieve daily
  vessel calls, estimated port shipment volumes and chokepoint vessel capacity.
- **FAOSTAT:** discover installed domains/codes and query official public-data
  snapshots for crop/livestock production, food balances and fertilisers by
  nutrient/product. Annual data from 1990 onward where available; FBS from 2010.

Neither addition needs an API key. Docker prepares FAOSTAT's searchable snapshots
at build time so hosted queries fit the small Northflank runtime. Snapshots
retain release/download dates and do not update during a tool call. A build
without cache downloads newer releases; `fresh=true` only bypasses result caches.
For local stdio, run `bun run build:faostat` once before using the FAOSTAT tools.

See [testing prompts, access details and rollback instructions](docs/security-data.md).
The previous working 35-tool source is saved as GitHub branch
`backup/working-before-portwatch-faostat-2026-10-20` and tag
`working-before-portwatch-faostat-2026-10-20` at commit `af2c77b`.

## Cloud deployment: Northflank and ChatGPT

EconStats is deployed from this GitHub repository to a Northflank combined build
and deployment service. ChatGPT connects to the hosted `/mcp` endpoint using
Auth0 OAuth. Sign-in and discovery of all **35 tools** were verified on
19 October 2026; public health and OAuth resource metadata were checked again
on 20 October 2026 and returned HTTP 200.

| Setting | Current deployment |
| --- | --- |
| Northflank project / service | `default` / `econstatsmcp` |
| MCP endpoint | https://p01--econstatsmcp--yg9w56v8wz4m.code.run/mcp |
| Public liveness check | https://p01--econstatsmcp--yg9w56v8wz4m.code.run/health |
| GitHub deployment branch | `codex/northflank-deployment` |
| Pull request | [#11](https://github.com/incanberra/econstats-mcp/pull/11), open draft at this checkpoint |
| Build / port | Root `Dockerfile`; container port `3000`; HTTPS provided by Northflank |
| Authentication | `MCP_AUTH_MODE=oauth`; Auth0 JWT access tokens; scope `econstats:read`; explicit user allowlist |
| Storage | Memory-only by default; cache, budgets and observed revision history reset on restart |

The deployment branch remains the live source until PR #11 is merged. The
deployment changes are not yet on `main`. The container uses pinned Bun 1.3.10,
runs as a non-root user and creates a separate stateless MCP server/transport per
request. It also provides request limits, graceful shutdown and connection logs
that omit credentials. GitHub checks cover regressions and the production image.
Local stdio clients remain available independently of the cloud service.

### Add or update cloud API keys

Open the Northflank service's **Environment** page, choose **Continue → Edit →
Add variable**, then enter each provider key you use:

`FRED_API_KEY`, `BEA_API_KEY`, `EIA_API_KEY`, optional `BLS_API_KEY`, and
`COMTRADE_API_KEY` for authenticated Comtrade access.

Use the key itself as the value, without surrounding quotes. Preserve the existing
OAuth settings, select **Update & restart**, and wait for **Running**. Provider
keys belong in runtime variables, not build arguments, the repository or ChatGPT
messages. A local `.env` file is excluded from the Docker build and is **not
automatically copied to Northflank**.

Check providers through the **cloud-connected** EconStats app, for example:

```json
{"sources":["FRED","BLS","BEA"],"probe":true}
```

Use that object with `connection_health`; check EIA and Comtrade separately if
configured. A fresh local MCP process successfully loaded a BLS key and completed
a live BLS probe on 20 October 2026. That does **not** verify the cloud BLS key or
other cloud provider credentials. Public `/health` only confirms process liveness.

### If ChatGPT authentication succeeds but discovery fails

The deployed service initially returned HTTP 403 with diagnostic reason
`subject_not_allowed`: `MCP_OAUTH_SUBJECTS` contained only `auth0`. Saving the
**complete Auth0 User ID**, including the `|` and everything after it, fixed the
problem. Restart the service after changing runtime variables, then use
ChatGPT's **Refresh tools**. Confirm successful `initialize` and `tools/list`
responses in Northflank logs before starting a new chat. Do not remove the
allowlist or disable authentication to bypass this error.

See the [short Northflank setup guide](docs/northflank.md),
[full hosting and OAuth reference](docs/northflank-reference.md), and
[deployment checkpoint](docs/cloud-deployment-checkpoint-2026-10-20.md).

## Data guide

See the [EconStats data guide](docs/data-guide.md) for provider coverage, key datasets and identifiers, data types, example research requests, and access and revision limits. It distinguishes catalogue discovery from working data retrieval and explains the TiVA service and date-range requirements.

## Version 3: ABS, structured data and observed revisions

Version 3.1 added [UN Comtrade discovery, availability and bounded merchandise trade retrieval](docs/comtrade.md). Preview access requires no key and always reports unverified completeness; authenticated retrieval uses an optional local `COMTRADE_API_KEY`. The cloud service follows `codex/northflank-deployment` as described above; local installations may follow `main`.

All fourteen direct observation tools return MCP `structuredContent` using the same
`schemaVersion: "1.0"` contract. The accompanying text is rendered from those exact
records. Search/catalogue tools keep their existing interfaces unless noted.
This is a major version because direct text formatting and BLS presentation changed.

- Result: `source`, original `retrievedAt`, nullable `sourceUpdatedAt`, public query,
  `series`, coverage counts/truncation and notes.
- Series: stable `id`, dataset/version, dimensions and labels, frequency, unit,
  nullable power-of-ten multiplier, adjustment, transformation, attributes,
  observations, citation URLs and revision status.
- Observation: period, numeric value or explicit `null`, and provider flags/footnotes.
- Unknown metadata remain null or `not_reported`. No numeric scaling or harmonisation
  is inferred. A literal unit label can itself contain scaling: retain that label.
- BLS direct results contain reported native levels with available calculations in
  attributes. They are not silently relabelled as YoY inflation/payroll changes.
  Use `select_source` for those verified transformations. Monthly rows are supported;
  M13 annual averages are excluded and disclosed. Unsupported frequencies fail safely.
- BEA's exposed parameter set supports NIPA only. Regional/GDPbyIndustry need separate
  parameters and are no longer advertised as supported by this interface.
- Old text-only TypeScript core methods remain compatibility entry points. MCP data
  handlers use the new structured pipeline; their text is not reparsed into data.

### ABS

Use `abs_list_datasets` → `abs_get_structure` → `abs_get_data`. No key is required.
The structure tool returns exact dimension order, code labels, a resolved version
and paginated code lists (`dimension_id`, `query`, `offset`, `limit`). Each data
key must explicitly specify every dimension, with at most 50 selected series and
1–120 observations per series. Data queries pin the resolved version in citations.

Recorded live examples, checked 16 October 2026:

| Measure | Dataset/version | Series key |
| --- | --- | --- |
| GDP, chain-volume level, SA | ANA_AGG / 1.0.0 | M1.GPM.20.AUS.Q |
| GDP growth from previous quarter, SA, not annualised | ANA_AGG / 1.0.0 | M2.GPM.20.AUS.Q |
| All-groups CPI, change from previous year, original | CPI / 2.0.0 | 3.10001.10.50.M |
| Unemployment rate, persons, total age, SA | LF / 1.0.0 | M13.3.1599.20.AUS.M |
| Goods credits/debits, current prices, SA | ITGS / 1.2.0 | M1.1000+2000.20.AUS.M |

Goods debits remain negative. These balance-of-payments trade series must not be
silently substituted for customs merchandise exports/imports. GDP chain-volume
levels retain native AUD units and available notes; an absent reference year is
not invented, and no ABS real-GDP-level selector template is registered yet.
The selector verifies Australian monthly headline CPI, monthly unemployment and
quarterly unannualised GDP growth. Australian SA GDP is distinct from European
SCA GDP; the check explicitly preserves this difference. For CPI, the current DSD
contains no UNIT_MULT: direct output leaves it null; selector evidence explicitly
explains the basis for using the PCT unit as reported percentage units.

The ABS Data API remains a beta service and may lag published releases. Always
check returned coverage against the relevant publication when release freshness
matters. Metadata codes alone do not establish data availability. In the current
CPI version the monthly key worked; the analogous quarterly key returned no data.

Official references: [ABS API guide](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide),
[request examples](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide/worked-examples).

### Revision tracking

Every public data retrieval records a baseline or checks against the latest
locally observed snapshot. Returned `series[].revision` distinguishes baseline,
unchanged, changes detected, cached/older replay and unavailable storage.
Changes distinguish newly available observations, changed historical values,
missing-to-value/value-to-missing transitions, flags and metadata changes.
Changes to definition/units start a new comparison baseline; they are not
misreported as directly comparable numeric revisions.

Use `fresh:true` on a data call to bypass and replace its observation cache, then
`revision_history` with the returned 64-character series `id`. Normal budgets and
cooldowns still apply. Cached results retain their original retrieval time and
never create a new vintage or roll a newer baseline backwards. Narrow query-window
omissions are not interpreted as withdrawals. Explicit nulls remain observable.

History defaults to `<ECONSTATS_CACHE_DIR>/revisions-v1`, or the default local cache
root. `ECONSTATS_REVISION_DIR` can choose an explicit history directory independently
of the data cache. With disk persistence disabled and no explicit revision directory,
history is in-memory only. Up to 50 changed snapshots per series are retained;
oldest snapshots are discarded and the count is reported. Historical comparison
coverage is limited to periods in retained snapshots. File updates are atomic and
locked across local processes. Storage errors are disclosed without suppressing
valid retrieved observations or overwriting corrupt history.

This is an archive of what this installation retrieved from now on. It is not an
official historical release-vintage database, a background monitor or a cross-source
discrepancy resolver. Verified-selector snapshots use separate derived-series
identities (`verified:<measure>`) and do not share an identity with native data.

### Validation and review

`bun run typecheck` checks production TypeScript source; `bun test` runs offline
regressions, official-response fixtures and an SDK tool-schema/initialisation check.
CI runs both. Live requests are opt-in: after loading your private provider keys,
run `bun run scripts/check-live.ts <report-directory>`. The report directory must be
outside the repository. The script creates a persistent runtime cache there, respects
normal request budgets and never writes keys into reports. Set
`ECONSTATS_LIVE_TOOLS` to comma-separated tool names for a narrowed rerun.
The three ABS selector checks also run, using normal evidence caches.

See [the review of PRs 1–8](docs/pr-stack-review-2026-10-16.md) for findings,
repairs and the merge order. PRs 1-9 are now merged into the maintained `main` branch. Installation is from source; no npm publication is implied.

## What makes it different

Not just data access — the server includes methodology rules that teach LLMs which series to pick:

- CPI vs PCE for inflation (and why they diverge)
- Prime-age EPOP vs headline unemployment for labor market tightness
- Explicit price-index levels or inflation transformations, and employment levels or changes, according to the requested measure
- BLS direct on release day (FRED lags 30-60 minutes)
- Real wages: explains which of 4 measures it's using and why

## Quick Start

```bash
# Install Bun if needed
curl -fsSL https://bun.sh/install | bash

# Install from this fork; the npm econstats-mcp package is currently unpublished.
git clone https://github.com/incanberra/econstats-mcp.git
cd econstats-mcp
git switch main
bun install --frozen-lockfile --ignore-scripts

# Save keys for the providers you use in a local .env (excluded from Git).
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

For the existing default Windows installation, run `powershell -ExecutionPolicy Bypass -File scripts/update-installed.ps1` from this branch. The updater checks the expected fork and tracked working-tree changes, uses a fast-forward update, installs locked dependencies, runs type checking/tests and verifies that `.env` was unchanged without displaying it. It stops instead of resetting divergent local work. This helper was syntax-checked; it was not run against the protected installation during this task. The live checks exercised the development checkout.

### OpenBB

Connect as an MCP server in the OpenBB workspace AI settings.

## API Keys

| Key | Required | Get it |
|-----|----------|--------|
| `FRED_API_KEY` | For FRED, inflation adjustment, and release calendar | https://fred.stlouisfed.org/docs/api/api_key.html (free) |
| `BLS_API_KEY` | Optional | https://data.bls.gov/registrationEngine/ (free, higher rate limits) |
| `BEA_API_KEY` | Optional | https://apps.bea.gov/API/signup/ (free, for GDP detail) |
| `EIA_API_KEY` | For EIA | https://www.eia.gov/opendata/register.php (free) |
| `COMTRADE_API_KEY` | For authenticated Comtrade retrieval; public previews need no key | https://comtradedeveloper.un.org/ |

IMF, OECD, Eurostat, BIS, World Bank, ECB, and ABS need no keys.

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

OECD uses the current SDMX APIs at `https://sdmx.oecd.org/public/rest` and `https://sdmx.oecd.org/sti-public/rest` (TiVA). No API key is required. The integration provides dataset discovery, dimension/code lookup, and data retrieval with English labels and source URLs.

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

OECD currently limits downloads to 60 per hour. The connector does not immediately retry rate-limit errors. Some very large datasets block `lastNObservations`; supply `start_period` and preferably `end_period` to use a bounded request instead (the tool still returns only the latest `limit` observations from that range). This connector supports `public` and `sti-public` (TiVA). The separate `dcd-public` CRS service is not included.

References: [OECD API](https://www.oecd.org/en/data/insights/data-explainers/2024/09/api.html), [API best practices](https://www.oecd.org/en/data/insights/data-explainers/2024/11/Api-best-practices-and-recommendations.html), [Restricted query parameters](https://www.oecd.org/en/data/insights/data-explainers/2026/03/Restricted-API-parameter.html).

### Trade in Value Added (TiVA)

Use `space: "sti-public"` on `oecd_list_datasets` for the TiVA catalogue. All three OECD tools accept optional `space: "public" | "sti-public"`. For structure and data, datasets whose identifier starts with `DSD_TIVA_` automatically select `sti-public` when space is omitted; other datasets retain `public`. Explicit overrides are honoured. The selected service is part of request URLs and cache keys; citations identify the actual endpoint. No key is needed.

TiVA blocks `lastNObservations` and `firstNObservations` throughout its service. Supply **both** `start_period` and `end_period`; the connector rejects missing bounds locally and sends neither blocked parameter. `limit` selects the latest returned observations per series within those bounds; it does not constrain the upstream download. Existing limits of 50 explicitly selected series, 120 output observations per series and a 20 MB response guard remain in place. Do not use wildcards or infer availability from codelists.

Discover and inspect first:

```json
{"query":"TiVA","space":"sti-public","limit":10}
```

```json
{"dataset_id":"OECD.STI.PIE,DSD_TIVA_MAINSH@DF_MAINSH","version":"1.1"}
```

Then request Australia's domestic value added in gross exports, all activities, World counterpart, percentage of gross exports:

```json
{
  "dataset_id": "OECD.STI.PIE,DSD_TIVA_MAINSH@DF_MAINSH",
  "version": "1.1",
  "series_key": "EXGR_DVA.AUS._T.W.PT_EXGR.A",
  "start_period": "2020",
  "end_period": "2022",
  "limit": 3
}
```

This dataset's dimension order is `MEASURE.REF_AREA.ACTIVITY.COUNTERPART_AREA.UNIT_MEASURE.FREQ`. TiVA represents historical value-added estimates, not current monthly customs trade. Treat its units, edition, classifications, flags and revision status explicitly.

For an opt-in MCP end-to-end check of TiVA discovery/structure/data, public OECD data and missing-bound rejection, run `bun run scripts/check-tiva-live.ts <report-directory-outside-repository>`. It requires no credentials and writes source-backed results outside the checkout. Use the existing updater and restart/reconnect the server to load the new tool schemas.

Official reference: [OECD restricted API parameters](https://www.oecd.org/en/data/insights/data-explainers/2026/03/Restricted-API-parameter.html).

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

## EIA energy statistics

EIA coverage uses the official API v2 hierarchy. Save your registered key as `EIA_API_KEY` in the local `.env` loaded by your MCP configuration, then restart your client. The server requires a key and does not silently substitute a demonstration key. Existing FRED/BEA credentials can remain in the same file.

1. Start with `eia_list_routes` and `route:""`, then descend into a returned route. `query` searches the current node's children, not the entire catalogue.
2. Inspect `eia_get_metadata` for supported frequencies, data fields, units, required facets and coverage. Supply `facet` to look up code labels; `query`, `offset` and `limit` filter/page through downloaded codes. Large code catalogues may be capped by the API.
3. Call `eia_get_data` with exact `data_fields` and `facets`. Select every facet, or explicit `series` codes on routes supporting a series facet. Broad/wildcard downloads are rejected. Metadata coverage is a hint, not proof that your selected series has observations.

US residential electricity-price example:

```json
{
  "route": "electricity/retail-sales",
  "frequency": "monthly",
  "data_fields": ["price"],
  "facets": { "stateid": ["US"], "sectorid": ["RES"] },
  "length": 12
}
```

Other exact series include Cushing WTI spot (`petroleum/pri/spt`, `series=RWTC`), Henry Hub spot (`natural-gas/pri/fut`, `series=RNGWHHD`), and US regular gasoline, all formulations (`petroleum/pri/gnd`, `series=EMM_EPMR_PTE_NUS_DPG`); each uses the `value` field. Inspect metadata for frequencies and retain reported units. The natural-gas route contains both spot and futures series; the selected code defines the measure.

`start_period`/`end_period` are inclusive; `length` is the total rows per page (1–5000, default 120), **not observations per series**. Use the returned next `offset` to continue; a multi-series page can have different coverage per series. Rows are requested newest first and presented chronologically within each separate series. Reported units, additional labels/status attributes and API warnings are retained. Missing values are retained as null in the structured output and counted; they are never treated as zero. Conflicting observations, unexpected facets/frequencies and inconsistent units return MCP errors. Outlook routes (`aeo`, `steo`, `ieo`) are explicitly identified as containing projections/estimates.

Each result cites the exact route, facets, field, frequency, dates and public query URL. API keys are used only in the authenticated request: the API's request echo is discarded, keys are redacted from returned data, and citation/cache URLs omit the key. Errors are not cached. EIA's rate limits return an actionable tool error; no immediate retry is attempted.

The source selector supports `residential_electricity_price`, `residential_electricity_sales`, `wti_spot_price`, `regular_gasoline_price` and `henry_hub_spot_price` for the US. Generic energy labels require clarification/discovery; it does not guess sectors, grades or spot/futures definitions.

References: [EIA API documentation](https://www.eia.gov/opendata/documentation.php), [API browser](https://www.eia.gov/opendata/browser/), [Key registration](https://www.eia.gov/opendata/register.php).

## Choosing a source

Call `select_source` before choosing between overlapping providers. It uses a curated registry of exact statistical definitions and geography/frequency rules, then validates structured provider records. It checks country, frequency, units and scaling, the requested transformation, required adjustment metadata and actual common observations. Display text is not used to establish coverage. All exact-match candidates are evaluated, including a fourth-ranked FRED fallback; provider request budgets still apply. Candidates with missing keys, failed access, uncertain definitions, incompatible units, sparse coverage or stale data remain visible with a specific rejection reason.

Example: `{"measure":"headline_cpi_yoy","countries":["US","GB"],"observations":12}` checks national CPI year-on-year definitions through OECD and IMF. `hicp_yoy` is a separate measure. `real_gdp_growth_qoq`, `real_gdp_growth_annualized` and `real_gdp_level` are distinct. Use `preferred_source` to preserve an explicit source override, `max_age_days` to require a freshness threshold, and `verify:false` for an explicitly unverified plan without network requests.

For comparisons the selector requests extra history to accommodate publication lags, finds actual common periods, and returns the matched values and observation flags in `verification.countries[].alignedObservations`. Each country includes its checked definition, source URLs and original `retrievedAt` timestamp. Use these values for the verified comparison; another retrieval may contain revisions. `purpose="latest"` prioritises the latest common period, then source suitability. `purpose="comparison"` prioritises suitability for comparable definitions, then freshness. `purpose="release"` prioritises original-producer suitability, then freshness. Definition, coverage and `max_age_days` checks apply before ranking for every purpose. Explicit source preferences are never silently replaced. Common observations need not be consecutive: the exact periods are listed.

Supply `start_period` and `end_period` for historical requests. Whole-year bounds expand to the requested frequency (for example, quarterly `2020`–`2021` means `2020-Q1`–`2021-Q4`). If both bounds are supplied and `observations` is omitted, all monthly, quarterly or annual periods in the range are required, up to 120; split longer verification requests. An explicit `observations` count requests that many latest common observations inside the range. Daily/weekly requests retain an observation-count requirement rather than assuming every calendar day has a value. Requested dates are propagated to the provider and out-of-range observations cannot verify the request. FRED also accepts `start_period`/`end_period` as full dates in its direct data tool. Historical checks return current revised data, not vintage data.

The selector now routes merchandise trade to Comtrade, value-added questions to OECD TiVA, agricultural production/food/fertiliser questions to FAOSTAT, and shipping questions to PortWatch. These routes return `discovery_required`, a `recommendedSource`, callable discovery steps and requirements for exact codes, units, dates and coverage. `selected` remains null until a registered evidence adapter can verify an exact series; a discovery plan is never labelled verified. A missing Comtrade key returns `source_unavailable`, with public discovery still available. Explicit source preferences remain binding. Unsupported cross-country GDP templates also return OECD/IMF discovery routes rather than pretending that no data exists.

Use `partner_countries`, `product_query`, `product_codes`, `classification`, `industry_query`, `location_query` and `location_type` where appropriate. For foreign value added in final demand, `countries` are final-demand destinations and `partner_countries` are origins; for domestic value added in exports, they are exporters and destinations respectively. Native codes must be resolved through provider discovery. See [source selection examples and limits](docs/source-selection.md).

OECD, IMF, ABS, BIS, Eurostat, World Bank and EIA catalogue searches rank economic concepts and synonyms while treating geography, frequency and transformation words as ranking context. Exact dataset identifiers stay exact. National GDP searches penalise regional and household-distribution tables unless requested. Equal-relevance Eurostat results retain preference for current coverage. These are discovery rankings, not proof of matching statistical definitions. EIA search remains confined to the selected route's children.

Real GDP levels and GDP growth default to quarterly frequency. Explicit incompatible frequencies are declined. FRED period-start dates are interpreted using the returned frequency metadata; daily data cannot pass as monthly data just by truncating dates. BLS inflation and payroll changes use reported calculations where supplied, or an explicitly labelled calculation from the exact prior-year/prior-month observation in the same series. Missing or conflicting baselines cannot verify a change. BEA GDP keeps the API row's unit multiplier, which may differ from the display scale in a published table heading, and obtains the chained-dollar reference year from the table notes.

Required missing metadata prevents strict verification. In particular, the current IMF CPI response supplies the annual transformation but no seasonal-adjustment field, so it receives `definition_unconfirmed` for this inflation definition. Direct IMF data tools remain available. For measures whose registered definition does not require seasonal adjustment, such as reported energy prices and BIS financial series, an absent field is explicitly labelled `not_reported`, with a caveat; it is never claimed to be confirmed. BLS series IDs and the registered BEA tables establish some definitions where the API supplies no separate field. Matching national CPI dimensions does not harmonise country baskets or methodology.

Eurostat monthly unemployment uses the current `age=TOTAL` code, whose unemployment population is ages 15–74; see the [official dataset methodology](https://ec.europa.eu/eurostat/cache/metadata/EN/une_rt_m_esms.htm). The calling assistant should extract the exact measure from the user's question and clarify ambiguous definitions before invoking the tool.

- Honor the user's requested source and measure definition.
- Choose by topic, geography, frequency, comparable definitions and actual usable coverage. Prefer original producers for release-day national statistics; FRED remains a convenient redistribution service.
- Use BIS for harmonised credit and financial statistics; Eurostat for European inflation/national accounts; ECB for its monetary policy and banking statistics; OECD/IMF for suitable international comparisons; World Bank for long-run development indicators.
- Inspect definitions and observation dates, use common periods for comparisons, and disclose stale data, definition differences and any fallback. Never silently switch CPI/CPIH/HICP, nominal/real series, growth conventions or sectors.
- Explain why the source fits and cite the series, units, period, URL and retrieval date.

The registry is not an exhaustive catalogue search. Some recognised measures/geographies still require discovery; the selector declines a recommendation rather than inventing a mapping. Structured evidence is cached for up to one hour (15 minutes for FRED); metadata caches have their provider-specific lifetimes. EIA retrieval and verification share validated observation responses. Cached evidence preserves its original retrieval time. Checks do not establish historical vintages or guarantee release-page freshness. Cite the underlying provider URLs and observation periods attached to the aligned values, rather than the selector as the statistical source.

## Connection health and request budgets

`connection_health` reports credential readiness, last observed access status, HTTP status, hourly request usage/remaining budget and any provider cooldown. Default `probe:false` makes no network requests and does not imply a live connection test. With `probe:true`, specify up to three sources per call, for example `{"sources":["FRED","BEA","EIA"],"probe":true}`. Probes bypass data caches and consume the normal request budget. They test an endpoint and credentials, not every dataset's definition, freshness or coverage.

Missing keys, rejected keys, rate limits, local budget exhaustion, outages/timeouts, rejected requests and malformed responses are separate statuses. Keys and authenticated URLs are never included in health output. HTTP 429 starts a provider cooldown using `Retry-After` (seconds or an HTTP date), defaulting to one minute; further uncached calls are stopped locally during that cooldown. Application-level errors such as BLS daily thresholds and BEA credential rejection are also diagnosed. Temporary network/5xx failures in older adapters can be retried at most twice; each attempt consumes budget, while 429/authentication/parameter failures are not immediately retried.

Every provider has a configurable **local hourly request budget**, defaulting to 60 for OECD and 300 for other providers. These are local operational caps, not promises about provider quotas: other applications/IP users and upstream daily limits are not counted. OECD metadata and probes count too, making its cap conservative relative to [OECD's published download limit](https://www.oecd.org/en/data/insights/data-explainers/2024/11/Api-best-practices-and-recommendations.html). Set `ECONSTATS_BUDGET_<PROVIDER>_PER_HOUR` to a nonnegative integer; zero disables that provider's local cap. Provider names are `FRED`, `BLS`, `BEA`, `IMF`, `OECD`, `EUROSTAT`, `BIS`, `EIA`, `WORLD_BANK` `ECB` and `ABS`.

Budgets and cooldowns persist under the local cache directory with atomic updates and cross-process locks. They are shared by MCP processes using that directory. A budget-storage failure stops an upstream call rather than allowing untracked requests. Remote hosts/other cache directories have separate budgets; Redis shares data caching, not budget counters. With disk caching disabled, budgets/cooldowns exist only in the current process. Cached valid data remain available during a cooldown and do not consume requests.

## World Bank, ECB and legacy adapter reliability

`worldbank_get_data` retrieves all pages for a bounded range, checks page totals/updates and rejects changing, duplicated or incomplete pagination instead of returning partial success. Default range is the current year and preceding 59 years; explicit bounds allow up to 150 years and 50 exact country/aggregate codes. Results retain country IDs/names, indicator definitions, reported units/status, missing-value counts, source update date, all-page totals and exact query citations. Coverage is World Development Indicators (`source=2`); missing units are disclosed rather than guessed.

`worldbank_search` downloads/caches the complete WDI indicator catalogue and searches it locally, prioritising indicator names/codes over description matches. It does not send an unsupported text-search parameter to the API. Up to 30 matches are shown.

`ecb_get_data` accepts fully specified keys (up to 50 combinations), rejects wildcards, decodes SDMX-JSON dimension/attribute indices, keeps country/series results separate and retains units, power-of-ten scales, observation flags, dates and exact citations. It makes no automatic unit conversion. The supported JSON media header and `format=jsondata` are used together.

FRED/BLS/BEA, World Bank and ECB return MCP tool errors for failed requests or invalid responses. HTTP/application errors are rejected before writing successful-data caches. BLS and BEA citations include retrieval dates; BEA's public structured output preserves row units/scales and every returned line, subject to bounded result-size guards. The old text-only core helper retains its historical display cap for compatibility. BEA's default `LAST5` is resolved to five explicit years. Provider request echoes/private credential fields are removed before legacy JSON is cached.

References: [World Bank pagination and call structures](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures), [World Bank indicator queries](https://datahelpdesk.worldbank.org/knowledgebase/articles/898599-indicator-api-queries), [ECB API overview](https://data.ecb.europa.eu/help/api/overview).

## Caching

The server now uses a two-layer cache:

- L1: in-process memory cache for hot repeated queries in a single MCP process
- L2: a persistent disk cache by default, or shared Redis when configured

The default disk directory is `~/.cache/econstats` (on Windows, under the user's home directory). Set `ECONSTATS_CACHE_DIR` to choose another directory, or `ECONSTATS_DISK_CACHE=false` to disable local persistence. Public validated responses/metadata use hashed filenames, atomic writes and source TTLs; expired/corrupt entries are ignored. Data retrieval timestamps stay with cached results, so a cache hit does not claim a new source download. The cache is not a revision/vintage archive. Local persistence shares responses across MCP restarts; simultaneous cache misses in separate processes can still each download data, while budget reservations remain shared/locked.

If you are running a shared MCP endpoint for OpenBB users, set these optional env vars:

| Key | Required | Purpose |
|-----|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Optional | Shared cache backend URL |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Shared cache backend token |
| `CACHE_NAMESPACE` | Optional | Redis cache prefix, defaults to `econstats:v3` |
| `ECONSTATS_CACHE_DIR` | Optional | Local disk-cache and request-budget directory |
| `ECONSTATS_DISK_CACHE` | Optional | Set `false` to disable local persistence |
| `PREFETCH_HOT_SERIES` | Optional | Set to `true` only for long-lived hosted processes |

The new public structured observation pipeline caches FRED results for 15 minutes and other providers for one hour. Explicit refresh replaces that entry. ABS catalogue/structures are cached for 24 hours. Selector evidence has its own original retrieval timestamp. The following TTLs apply to the retained legacy helpers and provider metadata:

- Hot FRED series like `PAYEMS`, `UNRATE`, `CPIAUCSL`, `CPILFESL`, `PCEPILFE`: 15 minutes
- Standard FRED series: 6 hours
- BLS / BEA: 6-12 hours
- IMF / OECD data / ECB: 24 hours
- OECD catalogue and structures: 7 days
- Eurostat data: 6 hours; catalogue and structures: 24 hours
- BIS data: 6 hours; catalogue and structures: 7 days
- EIA data: 1 hour; route metadata and facet codes: 24 hours
- World Bank and BLS lookup catalogs: days to weeks
- Release calendar: 15 minutes

The cache layer also deduplicates in-flight requests, so a burst of identical OpenBB tool calls only triggers one upstream API request.

Startup prefetch is disabled by default because short-lived stdio clients can create unnecessary upstream traffic. Turn it on only when you are running a persistent shared MCP service.

## Tools (41)

| Tool | Description |
|------|-------------|
| `select_source` | Verify structured definitions and common observations; return aligned values, citations, alternatives and rejection reasons |
| `connection_health` | Inspect credentials, access status, budgets/cooldowns; optionally probe live endpoints |
| `fred_search` | Search FRED series by keyword |
| `fred_get_series` | Fetch FRED data with transformations (YoY%, change, etc.) |
| `bls_get_series` | Fetch native BLS levels, available calculations and flags |
| `bls_series_lookup` | Find BLS series IDs by keyword |
| `bea_get_data` | BEA NIPA national accounts; regional/state API not exposed |
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
| `eia_list_routes` | Browse and search children in EIA's energy-data hierarchy |
| `eia_get_metadata` | Inspect EIA definitions, frequencies, fields and facet codes |
| `eia_get_data` | Fetch selected EIA energy observations with reported units and safe citations |
| `worldbank_get_data` | World Bank development indicators (200+ countries) |
| `worldbank_search` | Search World Bank indicators |
| `ecb_get_data` | ECB data (euro area rates, HICP, money supply) |
| `inflation_adjust` | Convert dollar amounts between dates using CPI-U |
| `check_release_calendar` | Check if today is a data release day |
| `abs_list_datasets` | Search ABS datasets |
| `abs_get_structure` | Inspect ABS dimensions, versions and codes |
| `abs_get_data` | Fetch exact ABS observations with native units and flags |
| `revision_history` | Inspect locally observed revisions and snapshots |
| `comtrade_list_reference` | Discover native trade area, flow and unit codes |
| `comtrade_search_products` | Search HS products and hierarchy |
| `comtrade_get_availability` | Check reporter/period publication availability |
| `comtrade_get_data` | Retrieve bounded merchandise trade with completeness caveats |
| `portwatch_list_locations` | Search ports and maritime chokepoints |
| `portwatch_get_metadata` | Inspect shipping fields, units and edit dates |
| `portwatch_get_data` | Retrieve daily AIS-derived shipping estimates |
| `faostat_list_domains` | Inspect installed public snapshots and their dates |
| `faostat_list_codes` | Discover native agricultural area/item/element codes |
| `faostat_get_data` | Query annual food, crop and fertiliser snapshots |

## Data Sources

Data comes from official statistical APIs and public data releases. Queries
fetch from the provider, reuse a cached source response or query an explicitly
dated FAOSTAT snapshot. Results retain provider attribution, units and source
URLs. The server's MIT licence does not replace the providers' data-use terms.

## License

MIT
