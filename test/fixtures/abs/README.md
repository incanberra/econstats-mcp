# Official ABS fixtures

Retrieved on 16 October 2026 (Australia/Sydney), using the public ABS Data API.
No authentication or credentials were used. These are recorded API responses,
not fabricated examples or evidence of ongoing freshness.

Metadata request pattern:

`https://data.api.abs.gov.au/rest/dataflow/ABS/{dataset}/latest?references=all`

Data request pattern:

`https://data.api.abs.gov.au/rest/data/ABS,{dataset}/{key}?lastNObservations=4&dimensionAtObservation=AllDimensions`

Data Accept header: `application/vnd.sdmx.data+csv;file=true;labels=id`.

| Dataset | Resolved version | Recorded keys |
| --- | --- | --- |
| ANA_AGG | 1.0.0 | M1.GPM.20.AUS.Q; M2.GPM.20.AUS.Q |
| CPI | 2.0.0 | 3.10001.10.50.M |
| LF | 1.0.0 | M13.3.1599.20.AUS.M |
| ITGS | 1.2.0 | M1.1000+2000.20.AUS.M |

The quarterly CPI query `3.10001.10.50.Q` returned no records in the current
dataset; it is deliberately not registered as a working template. ITGS goods
debits remain negative as reported. CPI has no UNIT_MULT attribute in its DSD;
the direct structured result retains a null multiplier. Its verified selector
explains why the explicit PCT unit is treated as percent without rescaling.
