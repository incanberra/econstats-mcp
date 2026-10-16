# EconStats: a practical guide to available data

Coverage checked 16 October 2026 UTC • EconStats v3.1

## What EconStats gives you

EconStats connects natural-language requests to economic and statistical databases. The installed interface exposes **12 providers**: ABS, FRED, BLS, BEA, IMF, World Bank, OECD, Eurostat, BIS, ECB, EIA and UN Comtrade. It is particularly useful for official economic time series, country comparisons, commodity prices, international financial exposures and selected trade queries.

This guide describes the **installed connection**, rather than everything each organisation publishes. A dataset appearing in a catalogue does not establish that every country, variable or observation can be retrieved. Exact coverage, definitions and freshness need checking for each substantive request. [1–13]

**Verification in this guide:** live catalogue or reference calls succeeded for ABS, IMF, OECD, Eurostat, BIS, EIA, FRED, World Bank and Comtrade. BLS, BEA and ECB coverage below is based on their exposed EconStats tools and official documentation; new observation queries were not tested for those three providers. Catalogue checks are not observation-level tests.

## 1. Choose a source by the research question

| Research need | Start with | Data you can seek | Principal qualification |
|---|---|---|---|
| Australian economy and population | ABS | GDP and its components, industry value added, CPI, employment, hours, underutilisation, population and regional aggregates | Use the API catalogue; it includes historical and superseded datasets. |
| US economic and financial conditions | FRED | Employment, prices, output, rates, yields, housing, spending, financial indicators and redistributed international series | FRED often redistributes another producer's statistics; retain that attribution. |
| Detailed US labour market and consumer prices | BLS | Payrolls, unemployment, participation, earnings, JOLTS and CPI components; selected regional and demographic series | The built-in series lookup is a small reference list, not the full BLS catalogue. |
| US national accounts | BEA | GDP, consumption, investment, income, saving, government spending and price measures in NIPA tables | This interface supports NIPA, not BEA's Regional or GDPbyIndustry API datasets. |
| International macroeconomics, external positions and forecasts | IMF | Inflation, GDP, exchange rates, trade, balance of payments, reserves, debt, investment positions and WEO projections | Current topic-specific datasets replace much legacy IFS usage; inspect current structures. |
| Long-run development and structural change | World Bank | GDP, population, manufacturing, poverty, health, education, energy and environmental indicators | Annual data dominate; observation dates and country coverage vary. |
| Comparable productivity and labour markets | OECD | Productivity, national accounts, prices and labour statistics in the public dissemination space | Separate TiVA/CRS retrieval spaces are outside this connector; catalogue hits do not establish access. |
| Detailed European economic statistics | Eurostat | GDP and components, HICP, labour markets and other main-database statistics | The adapter excludes separate DS-/Comext and asynchronous bulk downloads. |
| Financial interdependence and vulnerabilities | BIS | International banking, foreign-currency credit, debt securities, debt service, property prices, policy rates and exchange rates | Distinguish residence from bank nationality, borrower sectors, stocks and flows. |
| Euro-area monetary and banking conditions | ECB | Policy/financial rates, exchange rates, monetary aggregates and bank balance-sheet statistics | Requires an exact dataflow and series key; no dedicated catalogue-discovery tool is exposed. |
| Energy markets and security | EIA | Petroleum, gas, electricity, coal, production, consumption, stocks, trade, prices and outlooks | An EIA key is required; US detail is generally greater than international detail. |
| Bilateral product-level merchandise trade | UN Comtrade | Import/export values, net weight and reported quantities, by reporter, partner, HS product and period | Authenticated access requires a Comtrade key. Public preview is explicitly incomplete/unverified. |

Sources: installed tool contracts and provider documentation/catalogues. [1–13]

## 2. Key datasets worth knowing

The following identifiers were returned by EconStats catalogue/search calls during preparation. They are useful starting points, **not prevalidated series keys**. [1, 2, 5–10]

### Australia: ABS

| Dataset identifier | Contents | Typical analytical use |
|---|---|---|
| `ANA_AGG` | Australian National Accounts Key Aggregates | Output, income and macroeconomic performance. |
| `ANA_EXP` | Expenditure on GDP | Consumption, investment, government spending and trade contributions. |
| `ANA_INC` | Income from GDP | Composition of national income. |
| `ANA_IND_GVA` | Production of GDP | Industry structure and industry value added. |
| `ANA_SFD` | State final demand | Comparing domestic expenditure across states. |
| `LF`, `LF_AGES`, `LF_HOURS`, `LF_UNDER` | Labour force, age groups, hours and underutilisation | Workforce capacity and labour-market pressure. |
| `CPI`, `CPI_M`, `CPI_Q`, `CPI_WEIGHTS` | CPI-related datasets and weights | Inflation and expenditure patterns; inspect frequency, coverage and release notes before choosing. |
| `ABS_ANNUAL_ERP_ASGS2021` | Estimated resident population by SA2 and larger areas | Regional population change; use a consistent geography edition. |

The live ABS catalogue returned 1,227 dataflows. This includes old Census tables, projections and historical geography editions; it is not a count of current independent indicators. The free Data API needs no key. Restricted unit-record microdata is outside this interface. [1]

### IMF: macroeconomics, finance and external dependence

| Dataset identifier | Type of data | Why it is useful |
|---|---|---|
| `IMF.RES:WEO` | World Economic Outlook | Historical macro series, estimates and projections; separate their status and identify the edition. |
| `CPI`, `PPI` | Consumer and producer prices | Comparing price pressures, with consistent transformations. |
| `ANEA`, `QNEA` | Annual and quarterly national accounts | Output levels, growth and economic composition. |
| `ER`, `EER` | Bilateral and effective exchange rates | Currency movements and competitiveness. |
| `IMTS` | International trade in goods by partner country | Aggregate bilateral trading relationships; use Comtrade for detailed HS products. |
| `BOP`, `IIP` | Balance of payments and international investment positions | External flows versus accumulated asset/liability stocks. |
| `COFER` | Currency composition of official foreign-exchange reserves | Reserve-currency composition; not a complete map of all financial use of currencies. |
| `DIP` | Direct investment positions by counterpart economy | Investment relationships; formerly CDIS. |
| `PIP` | Portfolio investment positions by counterpart economy | Securities investment relationships; formerly CPIS. |
| `IRFCL` | International reserves and foreign-currency liquidity | External liquidity and reserve buffers. |
| `IMF.FAD:GDD`, `IMF.FAD:FM` | Global Debt Database and Fiscal Monitor | Debt and fiscal comparisons. |
| `IMF.RES:PCPS` | Primary Commodity Price System | Commodity benchmarks; the exact commodity and definition matter. |
| `PI`, `ITG`, `IMF.RES:ITS` | Production indexes; trade in goods; trade in services | Industrial activity and trade structure. |

These appeared in the current IMF catalogue. Retrieve each dataset's structure before building a query; legacy abbreviations and codes cannot be assumed to map directly to current datasets. Forecasts are available in selected datasets, not across all IMF series. [5]

### BIS: financial networks and exposure

| Dataset identifier | Contents | Important distinction |
|---|---|---|
| `WS_LBS_D_PUB` | Locational banking | Banking office residence. |
| `WS_CBS_PUB` | Consolidated banking | Consolidated banking-group exposures. |
| `WS_GLI` | Global liquidity indicators | Foreign-currency credit; examine borrower and instrument coverage. |
| `WS_DEBT_SEC2_PUB` | International debt securities | Securities issued internationally; not all corporate debt. |
| `WS_TC` | Total credit | Specify government, households, corporations or other available sectors. |
| `WS_CREDIT_GAP` | Credit-to-GDP gaps | Deviation from a statistical trend; not the credit-to-GDP ratio itself. |
| `WS_DSR` | Debt service ratios | Income used for interest and principal payments. |
| `WS_SPP`, `WS_DPP`, `WS_CPP` | Selected/detailed residential and commercial property prices | Real/nominal, property type and geography. |
| `WS_EER`, `WS_XRU`, `WS_CBPOL` | Effective exchange rates, USD exchange rates and policy rates | Index versus currency level; real versus nominal. |
| `WS_OTC_DERIV2`, `WS_DER_OTC_TOV` | OTC derivatives outstanding and turnover | Notional amounts, market values and trading activity differ. |

The live catalogue returned 28 datasets. This is a strong starting point for research on dollar dependence, cross-border finance and debt vulnerabilities. It does not identify every institution's bilateral exposure. [9]

### OECD, World Bank and Eurostat

**OECD:** catalogue results confirmed the Productivity database (`OECD.SDD.TPS,DSD_PDB@DF_PDB`), productivity levels, growth rates and industry breakdowns. The catalogue also includes the **TiVA 2025 edition**, including origin of value added in gross exports, imports and final demand. For example, `OECD.STI.PIE,DSD_TIVA_EXGRVA@DF_EXGRVA` addresses value added embodied in exports. TiVA supports analysis of production dependence and indirect exposure, but the historical estimates should not be presented as current monthly trade. However, this connector hardcodes OECD's `public` dissemination space; separate `sti-public` TiVA and `dcd-public` CRS retrieval spaces are outside its scope. A TiVA catalogue hit must not be presented as working retrieval through the current connector. Use the OECD website or another authorised source for these data until support is added. [7, 15]

**World Bank:** search confirmed manufacturing value added in current US dollars (`NV.IND.MANF.CD`), constant 2015 US dollars (`NV.IND.MANF.KD`), share of GDP (`NV.IND.MANF.ZS`) and growth (`NV.IND.MANF.KD.ZG`). These answer different questions. A country's share of world manufacturing requires a compatible world denominator; manufacturing as a share of its own GDP is a different measure. Other familiar indicators include population (`SP.POP.TOTL`) and real GDP growth (`NY.GDP.MKTP.KD.ZG`). The EconStats search inspected the WDI catalogue; do not assume access to every World Bank platform or microdataset. [6]

**Eurostat:** `namq_10_gdp` covers quarterly GDP and its main components. Its catalogue entry reported overall coverage from 1975-Q1 to 2026-Q2, updated 15 October 2026; this does not imply every country/component has that full history. Eurostat is also a source for harmonised consumer prices and European labour-market comparisons. [8]

### FRED, BLS and BEA: practical US access

Useful FRED identifiers exposed in EconStats guidance include `PAYEMS` (payroll employment), `UNRATE` (unemployment), `CPIAUCSL` (CPI), `PCEPILFE` (core PCE prices), `GDPC1` (real GDP level), `FEDFUNDS` (policy rate), `DGS10` (10-year Treasury yield), `T10Y2Y` (yield spread), `HOUST` (housing starts) and `JTSJOL` (job openings). Confirm units and current metadata before use. [2]

Live FRED searches also confirmed:

- `PWHEAMTUSDM`: Global price of Wheat, monthly, US dollars per metric ton.
- `PRICENPQUSDM`: Global price of Rice, Thailand, monthly, US dollars per metric ton.

These are specific commodity benchmark series. They should not be described as Australian farmgate prices, retail food prices or all rice grades. [2, 13]

Use **BLS directly** for supported detailed labour/CPI series and release-sensitive work. Its lookup covers roughly 35 common series plus selected metro codes; an unlisted series may still be retrievable with a valid BLS identifier. Use **BEA NIPA tables** for national-accounts detail: `T10101` is an example table for annualised real GDP growth and `T10106` for real GDP levels. State/regional datasets and the dedicated GDP-by-industry API are not exposed by this BEA tool. [3, 4]

### Energy and merchandise trade

**EIA:** live route discovery confirmed electricity, petroleum, natural gas, coal, international energy, State Energy Data System, total energy and outlooks. Possible measures include output, consumption, prices, inventories, capacity and energy trade. The route search works within a selected node, so discovery proceeds through the hierarchy. Historical observations and STEO/AEO/IEO projections must be labelled separately. Route discovery succeeded in the reference installation; a configured key and individual series checks are required for another installation. EIA is distinct from the IEA: access to EIA does not establish access to IEA's critical-minerals datasets. [11]

**UN Comtrade:** the current adapter supports final **merchandise** data in HS classifications, annually or monthly, for exact reporter, partner, products and periods. Fields include US-dollar trade value, net weight in kilograms and quantity in the reported quantity unit. Imports, exports, re-imports and re-exports have separate codes. China is reporter `156`; World is partner `0`. [12]

The current limits are material: authenticated access requires a configured key; public preview is incomplete/unverified; calls are bounded to up to 12 requests and 500 rows per period; automatic pagination and wildcard bulk downloads are absent. The adapter fixes secondary partner/customs/transport settings to its classic mode. Availability checks do not prove product/partner completeness. This is useful for narrow research queries, but not yet a verified basis for a comprehensive China trade database. [12]

## 3. Types of data and what the numbers mean

| Data type | Examples | Interpretation to preserve |
|---|---|---|
| Time-series levels | GDP, payroll employment, production | Units, scale, nominal/real basis and observation period. |
| Indexes | CPI, effective exchange rates, property prices | Reference base; an index level is not a percentage change. |
| Rates and ratios | Unemployment, policy rates, debt/GDP | Denominator and whether differences are percentages or percentage points. |
| Growth and changes | Annual inflation, quarterly GDP growth, payroll changes | Annual versus period-on-period change; annualised versus unannualised growth. |
| Physical quantities | Energy output, electricity sales, trade net weight | Physical unit, conversions and estimated/missing quantities. |
| Bilateral or multidimensional tables | Trade, banking claims, investment positions | Reporter, counterpart, sector, industry/product, valuation and classification. |
| Cross-country panels | Productivity, manufacturing, population | Comparable definitions and shared observation periods. |
| Estimates, projections and forecasts | WEO, energy outlooks, population projections | Status, forecast edition, assumptions and the boundary with observed history. |
| Metadata and quality flags | Seasonal adjustment, provisional values, breaks | Retain flags; missing values are not zero. |

Direct retrieval tools are designed to return structured observations with provenance, metadata and a text rendering. Unknown units or scaling can remain unspecified; this is a reason to investigate, not to infer them. Charts, indexed series, shares and growth calculations are analytical outputs created from retrieved data, rather than additional datasets. [14]

## 4. Useful research requests

These are example requests, not claims that every proposed output has already been validated.

1. **Manufacturing power:** “Using World Bank data, compare China's, the US's, Japan's and Germany's shares of world manufacturing value added since 2000. Use current US dollars and a compatible world total. Explain the exchange-rate effect and show the latest common year.”
2. **Productivity:** “Use the OECD Productivity database to compare labour-productivity levels or growth for Australia, the US, Japan and Germany. Specify the measure, price/PPP basis, units and latest common year. Do not substitute levels for growth.”
3. **Dollar dependence:** “Use BIS global liquidity data to compare US-dollar credit to non-bank borrowers outside the US with euro and yen credit outside their currency areas. Preserve sector and instrument definitions.”
4. **External investment:** “Use IMF DIP and PIP to map Australia's largest counterpart economies. Keep direct and portfolio positions separate and explain immediate-counterpart limitations.”
5. **Product trade:** “First check authenticated Comtrade access and data availability. Then examine China's exports of a precisely defined HS product to Australia, the US and World. Flag incomplete results and do not substitute mirror trade.”
6. **Food-price shocks:** “Retrieve the monthly wheat and Thai rice benchmarks through FRED from January 2021. Index both to 100 in that month, identify the original producer and use their latest common month.”
7. **Energy security:** “Use EIA international data to compare oil production and consumption for selected countries. Check the units and common years, and distinguish historical statistics from outlooks.”
8. **Australian capacity:** “Use ABS industry value added and labour-force data to assess manufacturing trends. Keep industry scope, prices, adjustment and periods explicit.”

For any request, add: **“Return the underlying observations, exact dataset/series identifiers, definitions, units, transformations, latest observation dates, source URLs and retrieval date. Explain missing coverage and any source substitution.”**

## 5. Access, revisions and practical limits

Access depends on each installation's configuration. **FRED and BEA retrieval require their provider keys; EIA requires an EIA key. BLS registration is optional for higher limits. Comtrade authenticated requests require a Comtrade key; public discovery and preview do not.** IMF, OECD, Eurostat, BIS, World Bank, ECB and ABS require no keys through these tools. Use `connection_health` to inspect the current installation rather than treating this guide as evidence of its credential readiness. Saved connection status is historical evidence, not a fresh connectivity test. No new observation downloads or comprehensive end-to-end provider tests were performed for this guide. [14, 15]

EconStats offers source selection, connection checks and revision tracking:

- **Source selection:** verifies registered definitions against provider records and can compare coverage, common periods and freshness. Its curated registry is not an exhaustive catalogue.
- **Freshness checks:** supported retrievals accept a fresh request to bypass observation caches. This does not eliminate upstream publication delays.
- **Revision history:** records snapshots and changes observed by this installation. It does not reconstruct all official historical publication vintages. The stated default is up to 50 changed snapshots per series.
- **US-dollar inflation adjustment:** the built-in adjustment uses US CPI-U. For Australian purchasing power, obtain an appropriate ABS measure and calculate explicitly.
- **Release calendar:** assists with major economic-release timing; do not treat it as an exhaustive global release schedule.

The current local request budget defaults to 60 upstream requests/hour for OECD and 300/hour for other providers. These are connector operating limits, not guarantees about upstream quotas. Keep queries bounded and reuse results. [14]

## 6. What needs another source or a separate access check

The exposed provider list does not establish direct access to company filings, proprietary financial terminals, vessel AIS, satellite imagery, geospatial population rasters, sanctions lists, export-control rules, mineral project engineering studies or restricted microdata. Some providers contain related aggregates, but those are not substitutes for the underlying specialised sources. Likewise, published critical-minerals production and refining data should not be assumed available merely because an energy provider is connected. [14]

For economic-security work, EconStats supplies quantitative evidence on exposure, concentration and economic conditions. Legal restrictions, corporate ownership, project readiness and the causes of economic changes usually require additional documentary evidence.

## Sources and verification record

All links accessed or catalogues queried on 16 October 2026 UTC. Scope restrictions above come from the installed tool definitions; provider websites describe their broader services and do not override those restrictions.

1. **ABS:** live `abs_list_datasets` calls, including national accounts, labour force, CPI and population; [Data API user guide](https://www.abs.gov.au/statistics/application-programming-interfaces-apis/data-api-user-guide); [catalogue](https://data.api.abs.gov.au/rest/dataflow/ABS/all/latest?references=none).
2. **FRED:** installed search/retrieval contracts and live commodity searches; [FRED API documentation](https://fred.stlouisfed.org/docs/api/fred/).
3. **BLS:** installed retrieval/lookup contracts; [BLS developer documentation](https://www.bls.gov/developers/).
4. **BEA:** installed NIPA-only retrieval contract; [BEA API documentation](https://apps.bea.gov/API/docs/index.htm); [NIPA contents](https://www.bea.gov/open-data).
5. **IMF:** live `imf_list_datasets` catalogue; [IMF API information](https://data.imf.org/en/Resource-Pages/IMF-API); [WEO](https://data.imf.org/Datasets/WEO); [current catalogue](https://api.imf.org/external/sdmx/2.1/dataflow/all/all/latest?references=none).
6. **World Bank:** live search of WDI manufacturing indicators; [Indicators API documentation](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392); [WDI resources](https://datatopics.worldbank.org/world-development-indicators/user-guide.html).
7. **OECD:** live productivity and TiVA catalogue searches; [API documentation](https://www.oecd.org/en/data/insights/data-explainers/2024/09/api.html); [ICIO explanation](https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html); [catalogue](https://sdmx.oecd.org/public/rest/dataflow/all/all/latest?references=none).
8. **Eurostat:** live GDP catalogue search and installed adapter contract; [API introduction](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction); [catalogue](https://ec.europa.eu/eurostat/api/dissemination/catalogue/toc/txt?lang=en).
9. **BIS:** live catalogue pages covering all 28 returned dataflows; [statistics topics](https://data.bis.org/topics); [API documentation](https://stats.bis.org/api-doc/v2/).
10. **ECB:** installed retrieval contract; [web-services documentation](https://data.ecb.europa.eu/help/getting-data-web-services-sdmx-0); [query examples](https://data.ecb.europa.eu/help/api/data-examples).
11. **EIA:** successful live root-route discovery; [Open Data](https://www.eia.gov/opendata/). API-key-bearing URLs are deliberately excluded.
12. **UN Comtrade:** installed bounded-query contracts and successful live reporter-reference lookup; [Comtrade](https://comtradeplus.un.org/); [provider access tiers](https://comtradeplus.un.org/Subscriptions); [reporter reference](https://comtradeapi.un.org/files/v1/app/reference/Reporters.json).
13. **Commodity series:** FRED [wheat](https://fred.stlouisfed.org/series/PWHEAMTUSDM) and [Thai rice](https://fred.stlouisfed.org/series/PRICENPQUSDM).
14. **Installed EconStats interface:** inspected 35 exposed tool definitions; `connection_health(probe=false)` was inspected during preparation; credential readiness is installation-specific and is not published in this guide. Source-selection, structured-output, budget, revision and access limitations reflect that interface, not assumptions about the providers' full APIs.
15. **Repository scope check:** [README](../README.md), [OECD implementation](../src/core/oecd.ts) and [Comtrade guide](comtrade.md), inspected at commit `d197c752cfaf9950e8312b49c90017f48e332a09`. OECD retrieval uses `https://sdmx.oecd.org/public/rest`; separate dissemination spaces are not implemented.
