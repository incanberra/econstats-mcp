# PortWatch and FAOSTAT — testing and rollback

Version 3.2 adds six tools and two providers, bringing EconStats to 41 tools and
14 providers. Existing providers and OAuth settings remain compatible.

## Try it in ChatGPT

Refresh the EconStats app's tools and start a new chat with EconStats selected.
No new API keys, passwords or paid accounts are needed for these additions.

- “Using EconStats PortWatch, find the Suez Canal and compare daily vessel
  transits in January 2023 and January 2024. Explain any missing dates and
  distinguish vessel capacity from cargo actually carried.”
- “Using EconStats FAOSTAT, show Australia's wheat production from 2015 to the
  latest year in the installed snapshot. Report tonnes, flags and the snapshot date.”
- “Using EconStats FAOSTAT, compare Australia's and Indonesia's nitrogen
  fertiliser agricultural use. Find the native codes first and use common years.”
- “List the installed FAOSTAT domains and their release and download dates.”

## PortWatch

`portwatch_list_locations` searches the complete bounded, paginated IMF catalogue
of ports or chokepoints; `portwatch_get_metadata` supplies valid fields and units;
`portwatch_get_data` requests exact IDs, fields and dates from the official
ArcGIS services. Discovery and observations share the existing request budgets,
cooldowns and caches. Successful data enter observed revision tracking.

At most five locations and five fields, a 367-day range and 2,000 location/day
rows are allowed per request. A result that reaches its row cap or reports an
upstream transfer limit is marked truncated. Narrow the dates or locations; there
is no silent automatic data pagination. Missing dates are not filled with zero.

Daily vessel calls are counts. Port imports/exports are AIS-derived estimated
shipment tonnes. Chokepoint `capacity` fields sum vessel deadweight capacity in
metric tonnes; they are not measured cargo weight. Totals overlap their component
vessel types. These are maritime estimates, not customs product-level trade.

Sources: [IMF PortWatch](https://portwatch.imf.org/),
[official methodology paper](https://www.imf.org/en/-/media/files/publications/wp/2025/english/wpiea2025093-print-pdf.pdf),
[World Bank access guide](https://worldbank.github.io/alternative-data-for-crisis/notebooks/disruptions-business-trade/maritime-port-activity.html).

## FAOSTAT

The current API requires authentication and anonymous API access was rejected
during development. Instead, the Docker build downloads official public CSV ZIPs
and converts them into read-only SQLite snapshots:

| Domain | Coverage included |
| --- | --- |
| QCL | Crop/livestock production, area and yield; 1990 onward |
| FBS | Food balances; 2010 onward |
| RFN | Fertilisers by nutrient; 1990 onward where available |
| RFB | Fertilisers by product; 1990 onward where available |

These are selected domains, not all FAOSTAT data. Actual end years and country
coverage vary and are reported by `faostat_list_domains`. Full historical data
before 1990 and the large agricultural trade domain are not included.

`faostat_list_codes` discovers domain-specific area, item and element codes.
`faostat_get_data` performs bounded indexed local queries and returns the same
structured observation contract as other providers, including units, raw flags,
notes, source URLs, download dates and observed revision tracking. Country codes
are native FAOSTAT codes, not ISO or Comtrade codes. Units are retained verbatim:
`t`, `1000 t`, nutrient mass, product mass and yield units must not be confused.
Food balances estimate availability and uses, not current inventories.

Snapshots contain about 7.8 million observations in the initial build. Large CSVs
are streamed during the **build**, not loaded into the 256 MB runtime. Hosted
queries open SQLite read-only, use indexed bounds, and close the database after
each call. Source archives, partial files and local data are excluded from Git
and the Docker context; the final image contains only completed snapshots.

### Updating snapshots

Docker caches the snapshot build layer. A normal code-only rebuild can therefore
reuse existing snapshots. **Redeploying does not guarantee a data refresh.** To
download newer FAOSTAT releases, use Northflank's build-without-cache option and
deploy the resulting image. This build takes longer than a code-only update.
The live `connection_health` probe for FAOSTAT compares installed release dates
with the upstream catalogue and reports newer releases when present.

For local stdio use, run `bun run build:faostat` once. Optionally set
`ECONSTATS_FAOSTAT_DIR` to a directory containing the generated files. `fresh=true`
bypasses the observation-result cache; it does **not** download new snapshots.

Build records include source update/download dates and archive SHA-256 hashes.
Unexpected schemas, duplicate observations or incomplete downloads fail the
build. A failed build cannot replace the currently running image.

Sources: [FAOSTAT](https://www.fao.org/faostat/en/),
[official public download catalogue](https://bulks-faostat.fao.org/production/datasets_E.json),
[FAOSTAT licensing](https://www.fao.org/contact-us/terms/en/).
FAOSTAT data attribution must be retained when sharing results.

## Revert to the previous working version

The previous working source is saved on GitHub as both:

- Branch: `backup/working-before-portwatch-faostat-2026-10-20`
- Tag: `working-before-portwatch-faostat-2026-10-20`
- Commit: `af2c77b5b50789fb2bb9829612746db704112873` (35 tools).

In Northflank, either redeploy the previous successful image or change this
service's GitHub source branch to the backup branch above, then build and deploy.
Keep the existing runtime variables and OAuth settings. Refresh ChatGPT's tools
after the old version is running. Reverting code does not restore or change
Northflank environment variables; none are changed by this feature addition.

## Developer verification

- `bun run typecheck` and `bun test` cover schemas, exact selections, missing
  values, units, flags, truncation, safe queries and hosting/authentication.
- `bun run scripts/check-security-data.ts` explicitly runs live PortWatch
  retrieval and real local snapshot queries; it is not an offline regression.
- GitHub's container check builds the snapshots and verifies discovery and
  installed FAOSTAT domains in the production image as a non-root user.
