# UN Comtrade (v3.1)

Four tools add official final merchandise trade in annual or monthly frequency:

1. `comtrade_list_reference`: reporters, partners, HS classifications, flows, quantity units, customs and transport codes. Native numeric area codes differ from ISO codes. Historical dates and group flags remain visible.
2. `comtrade_search_products`: keyword/code search with pagination and hierarchy. HS combines editions; H0-H6 pin an edition. Preserve leading zeroes in product codes.
3. `comtrade_get_availability`: reporter/period availability and returned publication metadata. This does not establish product/partner coverage.
4. `comtrade_get_data`: exact reporter, partner, products, flow and periods. Returns the shared `schemaVersion: "1.0"` contract and participates in `revision_history`.

Discovery requires no key. Data and availability default to explicit `access_mode: "preview"`. Public preview is **always marked truncated/unverified**, even if fewer rows than requested are returned. Set `COMTRADE_API_KEY` (or `COMTRADE_SUBSCRIPTION_KEY`) in the private local `.env` and select `access_mode: "authenticated"` for registered access. Missing or rejected keys fail without substituting public previews. Keys travel in `Ocp-Apim-Subscription-Key` headers and are excluded from cache keys, citations, snapshots and output. No key was provisioned by this change.

Example: discover Australia and HS code 8703, check annual 2023 availability, then retrieve exports to World:

```json
{
  "reporter_code": 36,
  "partner_code": 0,
  "periods": ["2023"],
  "frequency": "A",
  "classification": "HS",
  "product_codes": ["8703"],
  "flow_code": "X",
  "fields": ["primaryValue", "netWgt", "qty"],
  "access_mode": "preview",
  "max_records": 500,
  "fresh": true
}
```

Annual periods use YYYY; monthly periods use YYYYMM. One reporter, one partner, one flow and up to ten exact HS products are accepted. A call makes one request for each of at most twelve periods. Each response is capped at 500 rows in both modes. Wildcards, AG selectors, full bulk extraction, async jobs, services and tariff-line data are unsupported. No pagination, retries, aggregation, trade matrix estimates or mirror substitutions are performed. Local request budgets and provider cooldowns apply. Authentication does not imply an entitlement to unlimited extraction.

`primaryValue` retains reported USD values; `netWgt` retains kg; `qty` uses the returned quantity unit. Unknown quantity units remain null. Missing fields stay null; absent records are missing coverage, never zero trade. Native reporting, aggregation, estimation and original-classification flags are observation attributes. Each returned HS edition and quantity-unit code has its own series identity. Classic mode fixes secondary partner=0, customs=C00 and transport=0; other breakdowns are rejected. Parent/child products, World/bilateral trade, exports/re-exports and mirror flows must not be summed indiscriminately. Imports and exports can use different valuation bases.

Data caches retain the original retrieval timestamp for an hour; discovery caches last a day. `fresh=true` bypasses the observation cache without bypassing budgets. Revision snapshots compare observations and flags within the same series definition; they are local observations, not official release vintages. A change in HS edition starts a separate series. Source publication time remains null for observations unless it is supplied with those observations; availability publication dates do not silently become observation vintage dates.

`connection_health` accepts `COMTRADE`. A public availability probe does not validate authenticated access. An authenticated availability probe checks the configured key at that endpoint, not every product or subscription entitlement. `select_source` remains limited to its existing exact macroeconomic definitions; use Comtrade discovery for merchandise trade.

Official implementation references (checked 16 October 2026):

- https://uncomtrade.org/docs/un-comtrade-api/
- https://uncomtrade.org/docs/subscriptions/
- https://github.com/uncomtrade/comtradeapicall/blob/main/src/comtradeapicall/PreviewGet.py
- https://github.com/uncomtrade/comtradeapicall/blob/main/src/comtradeapicall/DataAvailability.py
- https://comtradeapi.un.org/files/v1/app/reference/ListofReferences.json

Validation: offline fixtures are synthetic, schema-based regression inputs rather than economic observations. The separate public live check exercises the MCP discovery, availability and data tools without credentials. Authenticated live retrieval requires a locally configured key and is not covered by the public check.
