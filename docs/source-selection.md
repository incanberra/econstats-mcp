# Source selection and catalogue discovery (3.3.0)

`select_source` distinguishes a verified series recommendation from a source routing plan. It never establishes country or date coverage from catalogue titles alone.

## Ranking

All verified candidates must first pass the existing country, measure, frequency, adjustment, transformation, units/scaling, common-coverage and optional age checks.

| Purpose | Order among valid candidates |
|---|---|
| `latest` | Latest common observation, then source suitability |
| `comparison` | Source suitability for comparison, then latest common observation |
| `release` | Original-producer suitability, then latest common observation |

An explicit `preferred_source` is binding. A failed preferred source is not silently replaced. `verify:false` returns unverified plans without contacting providers; it cannot rank actual freshness.

## Historical requests

```json
{"measure":"headline_cpi_yoy","countries":["US","GB"],"purpose":"comparison","start_period":"2020-01","end_period":"2020-12"}
```

Omitting `observations` requires all 12 months. Missing months are reported in `missingPeriods`. With `observations:6`, six latest common observations inside that date range are required. Whole years expand to monthly or quarterly bounds as appropriate. At most 120 monthly/quarterly/annual periods can be verified at once; split longer ranges. Daily/weekly series use observation counts because weekends, holidays and reporting calendars differ.

Dates reach each provider in its native parameter convention. BLS requests include baseline levels for changes, and filtering occurs before trimming. FRED direct retrieval accepts full-date `start_period` and `end_period`. Future observations remain invalid. Historical requests use current revised observations, not historical vintages.

## Additional source routes

| Measures | Source | Frequency |
|---|---|---|
| `merchandise_exports_value`, `merchandise_imports_value`, `merchandise_exports_net_weight`, `merchandise_imports_net_weight` | Comtrade | Annual or monthly |
| `foreign_value_added_in_final_demand`, `domestic_value_added_in_exports` | OECD TiVA, `sti-public` | Annual |
| `agricultural_production`, `food_supply`, `fertiliser_nutrient_use`, `fertiliser_product_use` | FAOSTAT installed snapshots | Annual |
| `port_import_volume`, `port_export_volume`, `chokepoint_capacity`, `vessel_transits` | PortWatch | Daily |

These return `status: discovery_required`, `recommendedSource`, discovery calls and requirements. They do not invoke an evidence adapter or claim verified observations. The calling assistant executes the returned discovery steps, resolves native codes and uses the existing data tools. Automatically executing and validating arbitrary newly discovered datasets is a separate capability.

### Chinese vehicle exports to the US

```json
{"measure":"merchandise_exports_value","countries":["CN"],"partner_countries":["US"],"product_codes":["8703"],"classification":"H6","start_period":"2022","end_period":"2025"}
```

Resolve native reporter/partner codes, confirm the HS definition, check availability and retrieve authenticated observations in batches of at most 12 periods. Inspect truncation and classification flags. Public preview cannot establish completeness. A missing authenticated key is reported as `source_unavailable`; public reference discovery can still proceed.

### Chinese value added in Australian final demand

```json
{"measure":"foreign_value_added_in_final_demand","countries":["AU"],"partner_countries":["CN"],"industry_query":"manufacturing","start_period":"2000","end_period":"2022"}
```

For this measure, Australia is the final-demand destination and China the origin. For `domestic_value_added_in_exports`, countries identify exporters and partners identify destinations. Discover TiVA in `sti-public`, inspect ordered dimensions and units, resolve the industry and requested level/share, and fetch with both date bounds. No current dataset ID, industry code or historical availability is assumed.

### Agricultural production and shipping

```json
{"measure":"agricultural_production","countries":["AU"],"product_query":"wheat","start_period":"2000","end_period":"2025"}
```

```json
{"measure":"chokepoint_capacity","countries":[],"location_query":"Suez","start_period":"2025-01-01","end_period":"2025-12-31"}
```

FAOSTAT plans check installed snapshots and native area/item/element codes. Food supply is not inventory; nutrient tonnes and product tonnes are different measures. PortWatch plans inspect fields and resolve native location IDs. Chokepoint capacity is vessel deadweight capacity, not actual cargo tonnage. Country-free selection is allowed only for shipping. Use `location_type` to specify ports or chokepoints for vessel transits.

## Catalogue search

The shared relevance matcher serves OECD, IMF, ABS, BIS, Eurostat, World Bank and EIA. It recognises economic synonyms, separates topic matching from contextual terms, preserves exact identifiers, and gives deterministic pagination. `real GDP growth qoq Australia US France` finds national accounts instead of failing because all words are absent from a title. Regional GDP and household-distribution datasets rank below national GDP unless requested. Exact statistical validation remains the responsibility of structure inspection and observation checks.

No new search service, API key or vector database is required. Existing provider caching and request budgets remain in use. EIA discovery still searches only children of the supplied route. Comtrade product/code and FAOSTAT native-code tools keep their existing search behaviour.

## Activation

Merge into `codex/northflank-deployment`, let Northflank deploy version 3.3.0, then refresh the custom MCP's tools in ChatGPT and start a new conversation. Confirm that `select_source` exposes the new measures and date/dimension fields. Refreshing tool metadata is separate from resetting OAuth authentication.
