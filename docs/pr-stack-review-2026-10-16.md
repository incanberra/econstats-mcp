# Review of EconStats draft PRs 1–8

Reviewed 16 October 2026 (Australia/Sydney). This is the implementing agent's
code review, not an independent reviewer approval. No GitHub review, merge,
retargeting, release tag or package publication was submitted by this review.

## Scope and evidence

Inspected the eight commit boundaries, the cumulative implementation at
`74f29342f8a8000db206ddb180be403895c47b36`, provider request/formatting code,
structured verification, persistence/access controls and associated tests.
Checked each PR's current GitHub record: all eight remain open drafts, with
the expected heads and bases; GitHub reported each individually mergeable.
Mergeability is not a correctness or approval finding.

Baseline: 123 offline tests and 566 assertions passed. New changes add production
TypeScript checking, SDK initialisation/schema checks, official ABS fixtures,
common-output tests and revision tests. Live checks exercise the new public
structured path for all eleven providers. They do not test every dataset or
force-refresh every cached response. The final validation summary is recorded
in the follow-on PR; live data captures remain outside Git.

## Findings and repairs in the follow-on branch

| Priority | Finding | Affected area | Repair and evidence |
| --- | --- | --- | --- |
| P1 | Methodology instructions were passed as server identity metadata rather than the SDK's server options. The intended source-selection guidance was not delivered through the protocol instructions field. | Inherited server setup, edited throughout the stack | Move `instructions` to the second `McpServer` argument. SDK regression and live initialisation confirm delivery. |
| P2 | IMF explicit keys could expand beyond the intended 50-series bound before a response was downloaded; reversed time ranges were not rejected locally. | PR 1, `imf.ts` | Bound Cartesian key combinations and reject reversed ranges before network access; add regression coverage. |
| P2 | The legacy IMF formatter silently skipped a nonnumeric observation as if it were absent. | PR 1, `imf.ts` | Reject malformed numeric data; the structured parser also preserves explicit missing values as null. |
| P2 | The BEA interface advertised Regional/GDPbyIndustry while sending NIPA-style parameters. Those datasets require different query parameters. | Public contract inherited by PR 7's legacy hardening | Expose NIPA only, reject unsupported dataset requests locally, correct GDP table descriptions and document the limitation. No claim of a new Regional/GDPbyIndustry integration. |
| P2 | The shared retry wrapper cleared its timeout at response headers and replaced a caller's cancellation signal. A response body could outlive that timeout. | PR 7, `http.ts` | Compose caller cancellation with a timeout that remains active through body consumption. JSON body failures become safe `unavailable` errors with no partial data. Regressions verify cancellation after headers and sanitised body failures. |
| P2 | Direct provider tools returned incompatible text-only representations, and BEA's direct text view capped displayed table lines. This limited reliable downstream use and revision comparison. | All provider additions; PR 7 | Introduce a common structured public data path and render text from the same records. Keep legacy TypeScript text helpers for compatibility. BEA's public result includes all returned lines within explicit size bounds. |
| P2 | No local revision archive distinguished newly available observations, changed historical values, flags and metadata. | Operational gap after PR 8 | Add bounded, atomic, locally locked history with stale-cache protection, null transitions and definition-aware comparison baselines. Persistent/concurrent/restart tests cover behaviour. |
| P2 | No explicit static type-check/CI pipeline verified production TypeScript and SDK setup. | Cumulative stack | Add strict production type checking and an offline Bun test workflow. Test fixture mocks are exercised by Bun and are outside the production TypeScript check. |

The first five rows are concrete correctness issues. The remaining rows are
requested improvements and validation gaps, not claims that the existing data
were necessarily wrong. Repairs are in the new dependent branch; the original
eight draft PR heads have deliberately not been rewritten.

## Per-PR assessment

| PR | Head → base | Review conclusion |
| --- | --- | --- |
| [1](https://github.com/incanberra/econstats-mcp/pull/1) | fix-imf-sdmx → main | Current IMF discovery/DSD migration is appropriate. Preserve the refusal to guess old IFS codes. Apply the query-bound/range/numeric repairs above with the cumulative release. Current IMF CPI direct access works; missing adjustment metadata still prevents strict inflation verification. |
| [2](https://github.com/incanberra/econstats-mcp/pull/2) | add-oecd → fix-imf-sdmx | Ordered metadata lookup, explicit selections, cache and rate-limit behaviour are supported by tests. Keep large-dataset restrictions visible. The new structured path validates returned dimensions against the DSD. TiVA's separate dissemination space remains out of scope. |
| [3](https://github.com/incanberra/econstats-mcp/pull/3) | add-eurostat → add-oecd | Sparse JSON-stat coordinate handling, all-dimension filters and missingness guards are covered. Later fixes use the current HICP and total-age unemployment codes. The common output preserves missing cells/status flags; Comext and async bulk downloads remain unsupported. |
| [4](https://github.com/incanberra/econstats-mcp/pull/4) | add-bis → add-eurostat | Version-pinned REST v2 requests, DSD key validation and component time constraints are appropriate. Preserve the distinction between dimensions and pre-time attributes. The new result retains compilation descriptions and observation attributes. |
| [5](https://github.com/incanberra/econstats-mcp/pull/5) | source-selector → add-bis | Review only as part of the complete stack: its original coverage/text verification was superseded by PR 8. Do not release PR 5's intermediate selector as the final implementation. |
| [6](https://github.com/incanberra/econstats-mcp/pull/6) | add-eia → source-selector | Exact route/facet distinctions, units, credential redaction and row pagination are supported by fixtures/tests. Current EIA access passes the new common public path. Page truncation remains explicit; a short page is not a claim about all series history. |
| [7](https://github.com/incanberra/econstats-mcp/pull/7) | improve-data-access → add-eia | Complete World Bank pagination, cache expiry preservation, local budgets/cooldowns and private request stripping are well covered. Apply the BEA interface and shared timeout fixes above. Budgets coordinate only processes sharing a local directory; Redis/distributed operation remains a separate validation task. |
| [8](https://github.com/incanberra/econstats-mcp/pull/8) | strengthen-source-selection → improve-data-access | Structured evidence, all-candidate fallback, exact definitions and common-period values materially improve selection. Preserve expected IMF refusals, GDP growth conventions and original retrieval timestamps. Additions do not relax these checks; ABS uses separately tested exact mappings. |

## Release recommendation

The stack should be reviewed/merged as a dependency chain, oldest first. Do not
retarget all eight directly to main or merge an intermediate selector as a final
release. The new branch targets PR 8's branch, and carries the repairs plus ABS,
structured output and revisions. After all intended commits reach main, rerun
the cumulative checks and verify the installed server commit/tool inventory.
Version 3.0.0 identifies the changed public result presentation and BEA/BLS
contract; no release tag or npm publication is implied by that version number.

## Remaining limits

- No independent reviewer approval was obtained and no formal approval review
  was posted. The eight original heads are unchanged.
- The HTTP transport inherited from main has not been authenticated or hardened
  for public hosting. This review does not approve exposing it through a tunnel.
- Direct metadata can remain unknown. For example, the ABS chain-volume GDP
  reference year is not supplied by the selected response, so no verified
  real-GDP-level mapping is invented. Original producer figures can still be
  retrieved with this limitation disclosed.
- History begins with this installation's observations. It cannot reconstruct
  earlier official publication vintages, monitor without being invoked, or
  resolve API-versus-publication/cross-source discrepancies automatically.
- Live Redis, cross-host budget coordination and complete cache/history directory
  eviction remain outside this change. Revision retention is bounded per series,
  not by a global disk budget. Large SDMX responses are checked after buffering.
- Live source coverage is sampled, not exhaustive. API schemas, publication
  freshness and results can change independently of this code.
