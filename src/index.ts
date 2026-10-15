#!/usr/bin/env bun
/**
 * EconStats MCP Server v2
 *
 * Economic data tools with methodology guide.
 * FRED, BLS, BEA, IMF, OECD, Eurostat, BIS, EIA, World Bank, ECB + inflation adjustment.
 *
 * Usage:
 *   bunx econstats-mcp          (stdio, for Claude Desktop/Code)
 *   FRED_API_KEY=xxx bun src/index.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EconStatsCoreClient } from "./core/client";
import { MEASURES, SOURCES } from "./core/selection";
import {renderResult} from "./core/result";
import {AccessError} from "./core/access";

function txt(text: string) { return { content: [{ type: "text" as const, text }],...(/^(?:FRED|BLS|BEA|WORLD_BANK|ECB|IMF|OECD|Eurostat|BIS|EIA) error:/.test(text)?{isError:true}:{}) }; }
function imfTxt(text: string) { return { ...txt(text), ...(text.startsWith("IMF error:") ? { isError: true } : {}) }; }
function oecdTxt(text: string) { return { ...txt(text), ...(text.startsWith("OECD error:") ? { isError: true } : {}) }; }
function eurostatTxt(text: string) { return { ...txt(text), ...(text.startsWith("Eurostat error:") ? { isError: true } : {}) }; }
function bisTxt(text: string) { return { ...txt(text), ...(text.startsWith("BIS error:") ? { isError: true } : {}) }; }
function eiaTxt(text: string) { return { ...txt(text), ...(text.startsWith("EIA error:") ? { isError: true } : {}) }; }
const client = new EconStatsCoreClient();
async function data(tool:string,args:Record<string,any>){
 const {fresh=false,...parameters}=args;
 try{const result=await client.getStructuredData({tool,arguments:parameters},fresh);return {content:[{type:"text" as const,text:renderResult(result)}],structuredContent:result as unknown as Record<string,unknown>};}
 catch(error){return {isError:true,content:[{type:"text" as const,text:error instanceof AccessError?error.message:"Data retrieval failed validation. Check dataset metadata, parameters, credentials and provider availability; no data were inferred."}]};}
}
async function jsonResult(work:()=>Promise<any>){
 try{const result=await work();return {content:[{type:"text" as const,text:JSON.stringify(result,null,2)}],structuredContent:result};}
 catch(error){return {isError:true,content:[{type:"text" as const,text:error instanceof AccessError?error.message:"Request failed. Check metadata, parameters and local storage."}]};}
}
// ── Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "econstats",
  version: "3.0.0",
}, {
  instructions: `You are an expert economic analyst. Plain English in, cited analysis out.

HARD RULES:
- NO emojis. NO "Let me fetch..." narration. Just present results.
- Every fact needs a citation. If you can't cite it, cut it.
- Be concise: 200-300 words, lead with the answer.
- For inflation indexes (CPI, PCE, PPI), always interpret as YoY % change, not raw levels.
- Don't compute averages or trends in your head — cite specific data points.

SOURCE ROUTING:
- For source recommendations, call select_source with an exact measure and country codes. It verifies structured provider records and returns definitions, aligned observations, citations, and rejection reasons. Never treat an unverified plan as confirmed data or silently override a preferred source. If no exact match is verified, refine the definition or use provider discovery tools.
- Honor an explicitly requested source. Otherwise choose by the requested measure, geography, frequency, comparable definitions and latest usable observations; there is no universal best source.
- Prefer the original statistical producer for release-day or detailed national figures. FRED is convenient redistribution; identify the underlying producer when available. Prefer harmonised definitions for country comparisons.
- Australian data: abs_list_datasets, abs_get_structure, abs_get_data. Validate codes, adjustment, units and publication freshness.
- Direct data tools return structuredContent schemaVersion 1.0 and text rendered from the same observations. Unknown units/scaling stay null; native values are not silently transformed.
- Use fresh=true for an explicit revision check, then revision_history with the returned series_id. These are observed snapshots, not official publication vintages.
- US macro → fred_get_series (check series_id from common IDs below)
- Granular CPI/employment (metro, industry) → bls_get_series
- US NIPA GDP detail → bea_get_data. State/regional and GDP-by-industry APIs are not exposed by this tool.
- International → imf_list_datasets, imf_get_structure, then imf_get_data with current dataset codes. IFS was split into topic datasets.
- International (long-run) → worldbank_get_data
- OECD comparisons, productivity, labour markets → oecd_list_datasets, oecd_get_structure, then oecd_get_data. Always inspect dataset dimensions and definitions first.
- Detailed European statistics → eurostat_list_datasets, eurostat_get_structure, eurostat_get_data. Use current datasets and explicit non-time filters; check coverage and dataset notes for discontinued series.
- Credit, debt service, international banking, property prices and effective exchange rates across countries → bis_list_datasets, bis_get_structure, bis_get_data. Validate sector, valuation, adjustment, units, real/nominal definitions and breaks.
- Energy prices, production, stocks, electricity and other energy statistics → eia_list_routes, eia_get_metadata, eia_get_data. Requires EIA_API_KEY. Distinguish spot/futures, grade/sector, units and observed statistics versus outlook projections. Never include the API key in citations.
- ECB monetary policy, euro-area monetary aggregates and bank statistics → ecb_get_data; European inflation and national accounts → Eurostat, using comparable definitions.
- "What is $X worth today?" → inflation_adjust
- Release day (jobs, CPI, GDP) → check_release_calendar, then BLS/BEA direct
- Inspect metadata and actual coverage before settling on a source. State why it fits and flag stale or missing observations. If it fails, try an appropriate fallback and disclose the change; never silently substitute CPI/CPIH/HICP, national accounts growth conventions, borrower sectors or nominal/real series.
- For comparisons use common observation periods. Explain differences in definitions or revisions before combining sources. Include dataset/series, units, observation dates, source URL and retrieval date in citations.

METHODOLOGY (what makes this different):
- "Jobs added?" → use change, not level. "Unemployment?" → consider U-6 alongside U-3.
- "How tight is the labor market?" → prime-age EPOP (LNS12300060) + JOLTS openings + quits rate.
- CPI vs PCE: CPI for general, PCE for Fed policy. CPI shelter LAGS market rents.
- GDP: always real (GDPC1). Quarterly figures are annualized. Advance estimates get revised.
- "Real wages" has multiple measures — explain which you're using.
- BLS data values are index levels with YoY annotations. Charts plot the level.
- OECD returns exact units, adjustment and transformation labels. Do not confuse national CPI/CPIH/HICP or annual growth with period-on-period growth. Respect different country coverage and observation dates.

COMMON FRED IDS:
PAYEMS (nonfarm payrolls), UNRATE (unemployment), U6RATE (broad), LNS12300060 (prime-age EPOP),
CPIAUCSL (CPI), CPILFESL (core CPI), PCEPILFE (core PCE), GDPC1 (real GDP),
A191RL1Q225SBEA (GDP growth), FEDFUNDS (fed funds), DGS10 (10yr treasury), DGS2 (2yr),
T10Y2Y (yield curve), MORTGAGE30US (30yr mortgage), HOUST (housing starts),
CSUSHPINSA (Case-Shiller), SP500 (S&P 500), JTSJOL (job openings), JTSQUR (quits rate),
CES0500000003 (avg hourly earnings), RSAFS (retail sales), PSAVERT (savings rate).`,
});

server.tool(
  "connection_health",
  "Inspect key readiness, saved connection status, request budgets and provider cooldowns. probe=false makes no upstream requests and does not claim live connectivity. probe=true performs a live access check for up to 3 explicitly selected sources, consumes budgets and bypasses data caches. Never returns credentials. A healthy endpoint is not proof of dataset coverage or freshness.",
  {sources:z.array(z.enum(SOURCES)).min(1).max(10).optional(),probe:z.boolean().default(false)},
  async({sources,probe})=>{try{return txt(await client.connectionHealth(sources,probe));}catch{return {...txt("Connection health error: choose valid sources; live probes support at most 3 sources per call."),isError:true};}}
);

server.tool(
  "select_source",
  "Recommend economic sources for an EXACT measure and countries. Uses a curated registry and checks structured provider observations, country, units/scaling, frequency, adjustment and transformation. Returns aligned numeric observations, provenance, common periods, age, all exact-match alternatives and rejection reasons. Missing required metadata prevents verification; provider-specific caveats remain visible. No silent CPI/CPIH/HICP or GDP-growth substitutions. Honor preferred_source even if unavailable; verify=false returns explicitly unverified plans. Coverage checks are not an exhaustive catalogue or vintage audit. Some recognized measures require dataset discovery when no exact template is registered.",
  {
    measure:z.enum(MEASURES).describe("Exact statistical definition; ask the user if the requested definition is ambiguous"),
    countries:z.array(z.string()).min(1).max(5).describe("ISO2/ISO3 codes, e.g. US/USA, GB/GBR, DE/DEU; EA for euro area"),
    frequency:z.enum(["daily","weekly","monthly","quarterly","annual"]).optional(),
    purpose:z.enum(["latest","comparison","release"]).optional(),
    preferred_source:z.enum(SOURCES).optional().describe("Explicit source override; alternatives do not override it"),
    observations:z.number().int().min(1).max(120).default(12).describe("Required common observations per country; incomplete coverage is disclosed"),
    verify:z.boolean().default(true).describe("Verify structured provider records and definitions, reusing source caches"),
    max_age_days:z.number().int().min(0).optional().describe("Maximum age of latest common observation period, measured at period end"),
  },
  async ({measure,countries,frequency,purpose,preferred_source,observations,verify,max_age_days})=>{
    try{return txt(await client.selectSource({measure,countries,frequency,purpose,preferredSource:preferred_source,observations,verify,maxAgeDays:max_age_days}));}
    catch{return {...txt("Source selection error: invalid request or unavailable lookup. Check the measure, country codes and frequency."),isError:true};}
  }
);

// ── FRED ────────────────────────────────────────────────────────────────

server.tool(
  "fred_search",
  "Search for FRED economic data series by keyword. FRED has 800K+ US series covering GDP, employment, inflation, interest rates, housing, trade, and more. Use this when you don't know the series ID. Common IDs you can use directly with fred_get_series: UNRATE (unemployment), PAYEMS (nonfarm payrolls), CPIAUCSL (CPI), PCEPILFE (core PCE), GDPC1 (real GDP), FEDFUNDS (fed funds rate), DGS10 (10yr Treasury), MORTGAGE30US (30yr mortgage), HOUST (housing starts), SP500 (S&P 500).",
  { query: z.string().describe("Search terms, e.g. 'housing starts' or 'consumer sentiment'") },
  async ({ query }) => {
    return txt(await client.fredSearch(query));
  }
);

server.tool(
  "fred_get_series",
  "Fetch FRED time series data with optional transformations. CRITICAL: For inflation indexes (CPIAUCSL, PCEPILFE, PPI), use units='pc1' to get year-over-year % change — raw index levels are meaningless to users. For employment (PAYEMS), use units='chg' to get monthly change in jobs. For rates (UNRATE, FEDFUNDS, DGS10), use units='lin' (default) since they're already in useful units. GDP: always use real GDP (GDPC1), never nominal.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    series_id: z.string().describe("FRED series ID, e.g. CPIAUCSL, UNRATE, GDPC1"),
    limit: z.number().default(36).describe("Observations (default 36 = 3 years monthly)"),
    units: z.enum(["lin", "pc1", "pch", "ch1", "chg"]).default("lin").describe("lin=levels, pc1=YoY%, pch=MoM%, chg=change"),
  },
  async (args) => data("fred_get_series",args)
);

// ── BLS ─────────────────────────────────────────────────────────────────

server.tool(
  "bls_get_series",
  "Fetch data direct from Bureau of Labor Statistics. Use instead of FRED when: (1) you need data on release day (BLS publishes at 8:30am ET, FRED lags 30-60 min), (2) you need metro-area CPI or state employment detail FRED doesn't have. Returns native reported levels, footnotes and available provider calculations in structured observation attributes. Use select_source for verified CPI YoY or payroll changes. For labor market analysis, consider fetching multiple series: unemployment (LNS14000000) + prime-age EPOP (LNS12300060) + job openings (JTS000000000000000JOL) gives a much fuller picture than unemployment alone.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    series_ids: z.array(z.string()).min(1).max(50).describe("BLS series IDs, e.g. ['CUSR0000SA0', 'CES0000000001']"),
    start_year: z.string().optional().describe("Start year, e.g. '2022'"),
    end_year: z.string().optional().describe("End year, e.g. '2026'"),
  },
  async (args) => data("bls_get_series",args)
);

server.tool(
  "bls_series_lookup",
  "Find BLS series IDs by keyword. Has ~35 common series (CPI components, employment by industry, unemployment demographics, JOLTS). Also returns CPI metro area codes (S12A=NYC, S23A=Chicago, S49A=LA, etc.) for constructing regional CPI series IDs. Use this before bls_get_series when you don't know the ID.",
  { query: z.string().describe("Search terms, e.g. 'shelter CPI', 'construction employment', 'Black unemployment'") },
  async ({ query }) => {
    return txt(await client.blsSeriesLookup(query));
  }
);

// ── BEA ─────────────────────────────────────────────────────────────────

server.tool(
  "bea_get_data",
  "Fetch BEA NIPA national accounts tables with every returned line, units, scaling and notes. Regional and GDPbyIndustry are not supported by this parameter set.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    dataset: z.enum(["NIPA"]).describe("NIPA tables. Regional and GDPbyIndustry require parameters not exposed by this interface."),
    table_name: z.string().describe("e.g. T10101 (annualised real GDP growth), T10106 (real GDP level)"),
    frequency: z.enum(["A", "Q", "M"]).default("Q"),
    year: z.string().default("LAST5"),
  },
  async (args) => data("bea_get_data",args)
);

// ── IMF ─────────────────────────────────────────────────────────────────

server.tool(
  "imf_list_datasets",
  "Search the current IMF dataset catalogue by keyword or dataset code. IFS was split into topic datasets: CPI (inflation), ER (exchange rates), ANEA/QNEA (GDP), IMTS (trade), BOP, etc. Use this before guessing a dataset. No API key required.",
  { query: z.string().optional().describe("Keywords, e.g. inflation, exchange rate, GDP, trade") },
  async ({ query }) => imfTxt(await client.imfListDatasets(query))
);

server.tool(
  "imf_get_structure",
  "Get an IMF dataset's ordered series-key dimensions and valid code labels. Call again with dimension_id and query to find a specific country or indicator. Modern codes differ from legacy IFS/DOT/BOP codes; do not guess translations.",
  {
    database_id: z.string().describe("Dataset ID such as CPI, ER, BOP, or IMF.RES:WEO"),
    dimension_id: z.string().optional().describe("Optional dimension from the returned order, e.g. COUNTRY or TYPE_OF_TRANSFORMATION"),
    query: z.string().optional().describe("Filter code labels within the selected dimension"),
  },
  async ({ database_id, dimension_id, query }) => imfTxt(await client.imfGetStructure(database_id, dimension_id, query))
);

server.tool(
  "imf_get_data",
  "Fetch the current IMF SDMX API. First inspect imf_get_structure, then supply series_key in that dataset's exact dimension order (usually ISO3 countries). For CPI convenience queries, supply country_codes (ISO2/ISO3), frequency, and indicator: PCPI_PC_CP_A_PT=YoY inflation, PCPI_IX=index, PCPI_PC_PP_PT=period-over-period change. These CPI shortcuts also accept database_id=IFS for compatibility. Other legacy IFS indicators cannot be translated automatically. Results retain units, scale, reference periods, and observation-status flags. No key required.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    database_id: z.string().describe("Current dataset, e.g. CPI, ER, ANEA, QNEA, IMTS, BOP, IMF.RES:WEO. IFS supported only for the listed CPI shortcuts."),
    series_key: z.string().optional().describe("Full current key, e.g. USA+GBR.CPI._T.YOY_PCH_PA_PT.M. Use this OR country_codes/indicator."),
    frequency: z.enum(["A", "Q", "M"]).optional().describe("For CPI convenience queries only; defaults to A. A full series_key includes its own frequency."),
    country_codes: z.array(z.string()).min(1).max(20).optional().describe("For CPI convenience queries only; ISO2 or ISO3, e.g. ['US', 'GB']"),
    indicator: z.string().optional().describe("For CPI: PCPI_PC_CP_A_PT (YoY%), PCPI_IX (index), PCPI_PC_PP_PT (period-over-period%), or CPI._T.YOY_PCH_PA_PT. Defaults to YoY inflation."),
    start_period: z.string().optional(),
    end_period: z.string().optional(),
    limit: z.number().int().min(1).max(120).default(36).describe("Latest observations per series, within the requested range"),
  },
  async (args) => data("imf_get_data",args)
);

// ── OECD ────────────────────────────────────────────────────────────────

server.tool(
  "oecd_list_datasets",
  "Search OECD's current Data Explorer catalogue by topic or dataset code. Use before fetching OECD GDP, productivity, inflation, labour-market or other comparisons. Results return agency,dataset and version. No API key required; cached searches share one catalogue download.",
  {
    query: z.string().optional().describe("Keywords, e.g. inflation, unemployment, productivity, GDP"),
    offset: z.number().int().min(0).default(0).describe("Skip this many matching datasets"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, offset, limit }) => oecdTxt(await client.oecdListDatasets(query, offset, limit))
);

server.tool(
  "oecd_get_structure",
  "Inspect an OECD dataset's exact series-key dimension order and code labels. Call with dimension_id and query to find units, countries, adjustment or transformations. Structure codes do not guarantee available observations. Do not guess dimension positions or interpret CPI, CPIH and HICP as identical.",
  {
    dataset_id: z.string().describe("agency,dataset from discovery, e.g. OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL"),
    version: z.string().optional().describe("Dataset version from discovery; defaults to latest"),
    dimension_id: z.string().optional().describe("e.g. REF_AREA, UNIT_MEASURE or TRANSFORMATION"),
    query: z.string().optional().describe("Filter code labels, e.g. United Kingdom or growth rate"),
  },
  async ({ dataset_id, version, dimension_id, query }) => oecdTxt(await client.oecdGetStructure(dataset_id, version, dimension_id, query))
);

server.tool(
  "oecd_get_data",
  "Fetch OECD SDMX data after inspecting oecd_get_structure. Specify every dimension explicitly; combine codes with +. Returns latest observations per series, exact dimension labels, units, scaling, status flags, source URL and retrieval date. Missing values are not zero. For large datasets that block latest-observation queries, supply start_period and end_period. No key required. OECD limits downloads to 60/hour; repeated queries are cached and errors are not cached.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    dataset_id: z.string().describe("agency,dataset from discovery"),
    version: z.string().optional().describe("Dataset version; defaults to latest"),
    series_key: z.string().describe("Exact ordered dimensions from structure, e.g. USA+GBR.M.N.CPI.PA._T.N.GY for DSD_PRICES@DF_PRICES_ALL. No wildcard dimensions."),
    start_period: z.string().optional().describe("Inclusive start, e.g. 2025-01 or 2024-Q1"),
    end_period: z.string().optional().describe("Inclusive end, e.g. 2026-08"),
    limit: z.number().int().min(1).max(120).default(36).describe("Latest observations per series within the requested range"),
  },
  async (args) => data("oecd_get_data",args)
);

// ── Eurostat ────────────────────────────────────────────────────────────

server.tool(
  "eurostat_list_datasets",
  "Search the current Eurostat catalogue for European inflation, GDP, unemployment and other official statistics. Returns dataset codes, coverage and update dates, with pagination. Check coverage: some older datasets are discontinued or replaced. No API key required.",
  {
    query: z.string().optional().describe("Keywords or dataset code, e.g. inflation, GDP, unemployment, prc_hicp_minr"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, offset, limit }) => eurostatTxt(await client.eurostatListDatasets(query,offset,limit))
);

server.tool(
  "eurostat_get_structure",
  "Inspect a Eurostat dataset's required non-time filters and code labels, coverage, notes and update date. Use dimension_id and query to find countries, units, adjustments or components. Select annual/monthly growth rates explicitly for inflation. Do not assume old and current HICP classifications use the same component codes.",
  {
    dataset_id: z.string().describe("Dataset code from discovery, e.g. prc_hicp_minr, namq_10_gdp, une_rt_m"),
    dimension_id: z.string().optional().describe("Filter a dimension, e.g. unit, geo, coicop18 or s_adj"),
    query: z.string().optional().describe("Filter code labels, e.g. annual rate or Germany"),
  },
  async ({ dataset_id, dimension_id, query }) => eurostatTxt(await client.eurostatGetStructure(dataset_id,dimension_id,query))
);

server.tool(
  "eurostat_get_data",
  "Fetch Eurostat observations with exact series definitions, units, status flags, coverage, update/retrieval dates and citation URLs. First inspect eurostat_get_structure, then supply explicit code arrays for EVERY non-time dimension. Missing values are not zero. limit selects the latest time positions (some countries may have missing observations); period bounds are inclusive. Main Eurostat datasets only; separate DS-/Comext and asynchronous bulk downloads are not supported. No key required.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    dataset_id: z.string().describe("Eurostat dataset code, e.g. prc_hicp_minr"),
    filters: z.record(z.string(),z.array(z.string()).min(1).max(50)).describe("Every non-time dimension mapped to exact code arrays. HICP example: {freq:['M'],unit:['RCH_A'],coicop18:['TOTAL'],geo:['DE','FR']}"),
    start_period: z.string().optional().describe("Inclusive start, e.g. 2025-01, 2024-Q1 or 2020"),
    end_period: z.string().optional().describe("Inclusive end in the same frequency, e.g. 2026-08"),
    limit: z.number().int().min(1).max(120).default(36).describe("Latest time positions; at most this many numeric observations shown per series"),
  },
  async (args) => data("eurostat_get_data",args)
);

// ── BIS ─────────────────────────────────────────────────────────────────

server.tool(
  "bis_list_datasets",
  "Search BIS datasets for cross-country credit, debt service, banking, property prices, policy rates, effective exchange rates and related financial statistics. Returns current WS_ dataset IDs and versions. No API key required.",
  {
    query: z.string().optional().describe("Keywords or dataset ID, e.g. credit, debt service, housing, exchange rates, WS_TC"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, offset, limit }) => bisTxt(await client.bisListDatasets(query,offset,limit))
);

server.tool(
  "bis_get_structure",
  "Inspect a BIS dataset's ordered key dimensions, code labels and definition. Use dimension_id and query to select country, sector, valuation, unit, real/nominal or basket codes. Codelists do not guarantee observations. Inspect this before bis_get_data.",
  {
    dataset_id: z.string().describe("WS_ code from discovery, e.g. WS_TC, WS_DSR, WS_SPP, WS_EER, WS_CBPOL"),
    version: z.string().optional().describe("Discovered version, or latest (default)"),
    dimension_id: z.string().optional().describe("Exact dimension name, e.g. REF_AREA, BORROWERS_CTY, UNIT_TYPE"),
    query: z.string().optional().describe("Filter codes/labels, e.g. United Kingdom or GDP"),
  },
  async ({ dataset_id, version, dimension_id, query }) => bisTxt(await client.bisGetStructure(dataset_id,version,dimension_id,query))
);

server.tool(
  "bis_get_data",
  "Fetch BIS observations with exact dimensions, units, status flags, compilation/break notes, retrieval date and citation URL. First inspect bis_get_structure. Specify every key dimension; join alternatives with +. Maximum 50 series. Missing observations are not zero. Returns current revised data; latest dates may differ across countries. No key required.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    dataset_id: z.string().describe("BIS dataset ID, e.g. WS_CBPOL"),
    version: z.string().optional().describe("Discovered version, or latest (default); citation pins the resolved version"),
    series_key: z.string().describe("Explicit codes in metadata order, e.g. M.US+GB for monthly central-bank policy rates"),
    start_period: z.string().optional().describe("Inclusive start YYYY, YYYY-MM, YYYY-Qq, YYYY-Ss or YYYY-MM-DD"),
    end_period: z.string().optional().describe("Inclusive end period"),
    limit: z.number().int().min(1).max(120).default(36).describe("Latest observations shown per series, default 36"),
  },
  async (args) => data("bis_get_data",args)
);

// ── EIA ─────────────────────────────────────────────────────────────────
server.tool(
  "eia_list_routes",
  "Browse EIA's current API hierarchy for energy data. Search child routes within a node; this is not a global catalogue search. Start with route='' for electricity, petroleum, natural-gas, international, outlooks and other categories, then descend. Requires EIA_API_KEY.",
  {route:z.string().default(""),query:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(50).default(20)},
  async({route,query,offset,limit})=>eiaTxt(await client.eiaListRoutes(route,query,offset,limit))
);
server.tool(
  "eia_get_metadata",
  "Inspect EIA route definitions, frequency, facets, data fields/units and coverage. With facet, fetch code labels and filter the downloaded codes using query/offset/limit. Metadata coverage is not proof of selected-series observations. Requires EIA_API_KEY.",
  {route:z.string(),facet:z.string().optional(),query:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(60).default(30)},
  async({route,facet,query,offset,limit})=>eiaTxt(await client.eiaGetMetadata(route,facet,query,offset,limit))
);
server.tool(
  "eia_get_data",
  "Fetch EIA API v2 data with reported units, exact facets, dates and citation query (API key omitted). Inspect metadata first. Select every facet, or explicit series codes on routes with a series facet. length is total rows per page, not observations per series; use offset to continue. Keep states/sectors/products and spot/futures distinct. Outlook routes contain projections. Requires EIA_API_KEY.",
  {fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),route:z.string(),frequency:z.string(),data_fields:z.array(z.string()).min(1).max(5),facets:z.record(z.string(),z.array(z.string()).min(1).max(50)),start_period:z.string().optional(),end_period:z.string().optional(),length:z.number().int().min(1).max(5000).default(120),offset:z.number().int().min(0).default(0)},
  async (args) => data("eia_get_data",args)
);

// ── World Bank ──────────────────────────────────────────────────────────

server.tool(
  "worldbank_get_data",
  "Fetch World Bank development indicators. Best for long-run cross-country comparisons (annual data, may lag 1-2 years). Covers 200+ countries. Common indicators: NY.GDP.MKTP.KD.ZG (GDP growth %), FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %), SP.POP.TOTL (population). Use 'WLD' for world aggregate, 'OED' for OECD. For recent/current data, use imf_get_data instead.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    country_codes: z.array(z.string()).describe("ISO2/ISO3 codes. 'WLD'=world, 'OED'=OECD"),
    indicator: z.string().describe("e.g. NY.GDP.MKTP.KD.ZG (GDP growth), FP.CPI.TOTL.ZG (inflation)"),
    start_year: z.number().optional(),
    end_year: z.number().optional(),
  },
  async (args) => data("worldbank_get_data",args)
);

server.tool(
  "worldbank_search",
  "Search World Bank indicators by keyword.",
  { query: z.string().describe("e.g. 'GDP growth', 'poverty rate', 'CO2 emissions'") },
  async ({ query }) => {
    return txt(await client.worldBankSearch(query));
  }
);

// ── ECB ─────────────────────────────────────────────────────────────────

server.tool(
  "ecb_get_data",
  "Fetch ECB data. Euro area rates, HICP inflation, money supply, exchange rates.",
  {
    fresh:z.boolean().default(false).describe("Bypass observation cache to check revisions; budgets and cooldowns still apply."),
    flow_ref: z.string().describe("EXR (exchange rates), FM (financial), ICP (HICP), BSI (money supply)"),
    key: z.string().describe("e.g. 'M.U2.N.000000.4.ANR' for euro HICP YoY"),
    start_period: z.string().optional(),
    end_period: z.string().optional(),
  },
  async (args) => data("ecb_get_data",args)
);

// ── Inflation Adjust ────────────────────────────────────────────────────

server.tool(
  "inflation_adjust",
  "Convert dollar amounts between dates using CPI-U. Use for: 'what is $X worth today?', real wages, inflation-adjusted prices, purchasing power comparisons. Returns the adjusted amount with source CPI values so the result is fully citable. Note: 'real wages' has multiple valid measures — this tool adjusts a single dollar amount, not a time series.",
  {
    amount: z.number().describe("Dollar amount to convert"),
    from_date: z.string().describe("Original date, YYYY-MM-01"),
    to_date: z.string().describe("Target date, YYYY-MM-01"),
  },
  async ({ amount, from_date, to_date }) => {
    return txt(await client.inflationAdjust(amount, from_date, to_date));
  }
);

// ── Release Calendar ────────────────────────────────────────────────────

server.tool(
  "check_release_calendar",
  "Check if today is a major economic data release day (jobs, CPI, GDP, etc). If yes, use BLS/BEA direct instead of FRED.",
  {},
  async () => {
    return txt(await client.checkReleaseCalendar());
  }
);

// ── Start ───────────────────────────────────────────────────────────────

server.tool("abs_list_datasets","Search the ABS Data API catalogue. Free, no API key. Inspect structures and publication freshness before retrieving data.",
  {query:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(50).default(20)},
  async({query,offset,limit})=>jsonResult(()=>client.absListDatasets(query,offset,limit)));
server.tool("abs_get_structure","Inspect ABS dataset version, ordered dimensions and code labels. Paginate code lists. Codes do not guarantee observations.",
  {dataset_id:z.string(),version:z.string().optional(),dimension_id:z.string().optional(),query:z.string().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50)},
  async({dataset_id,version,dimension_id,query,offset,limit})=>jsonResult(()=>client.absGetStructure(dataset_id,version,dimension_id,query,offset,limit)));
server.tool("abs_get_data","Fetch exact ABS series after inspecting abs_get_structure. Returns common structured data, native units, flags, source query, original retrieval time and revision changes. Pin the discovered version. API freshness may lag the publication. No automatic annualisation or scaling.",
  {dataset_id:z.string(),version:z.string().optional(),series_key:z.string(),start_period:z.string().optional(),end_period:z.string().optional(),limit:z.number().int().min(1).max(120).default(36),fresh:z.boolean().default(false)},
  async(args)=>data("abs_get_data",args));
server.tool("revision_history","Read locally observed snapshots and changes for a series_id returned by a data tool. Does not fetch upstream data or reconstruct official release vintages. Retains up to 50 changed snapshots per series by default.",
  {series_id:z.string().regex(/^[a-f0-9]{64}$/),limit:z.number().int().min(1).max(50).default(10)},
  async({series_id,limit})=>jsonResult(()=>client.revisionHistory(series_id,limit)));

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "0");

if (PORT > 0) {
  // Streamable HTTP mode — for OpenBB Workspace
  // Use stateless mode so each request is independent
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`EconStats MCP v3 running on http://localhost:${PORT} (Streamable HTTP)`);
    if (process.env.PREFETCH_HOT_SERIES === "true") {
      client.prefetchReleaseDaySeries();
    }
  });
} else {
  // Stdio mode — for Claude Desktop/Code
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("EconStats MCP v3 running on stdio");
    if (process.env.PREFETCH_HOT_SERIES === "true") {
      client.prefetchReleaseDaySeries();
    }
  });
}
