import {describe,expect,test} from "bun:test";
import {normaliseSelection,rankSources,selectSource,observedPeriods,type SelectionParams} from "../src/core/selection";
const base:SelectionParams={measure:"headline_cpi_yoy",countries:["US","GB"],observations:2};
const probe=async(r:any)=>r.tool.endsWith("structure")?"Valid metadata":`${r.arguments.series_key?.startsWith("USA")?"REF_AREA=USA COUNTRY=USA":"REF_AREA=GBR COUNTRY=GBR"}\n2026-M07: 2\n2026-M08: 3\nURL: https://example.org/data\nRetrieved: 2026-10-12`;
describe("source-selection policy",()=>{
 test("normalises countries without inventing unknown codes",()=>{
  expect(normaliseSelection(base).countries).toEqual(["USA","GBR"]);
  expect(()=>normaliseSelection({...base,countries:["UK"]})).toThrow("Unknown country");
  expect(()=>normaliseSelection({...base,countries:[]})).toThrow();
 });
 test("matches exact definitions and frequency without substituting inflation measures",()=>{
  expect(rankSources(base).candidates[0].source).toBe("OECD");
  expect(rankSources({...base,measure:"hicp_yoy",countries:["DE","FR"]}).candidates.map(c=>c.source)).toEqual(["EUROSTAT"]);
  expect(rankSources({...base,measure:"cpih_yoy",countries:["GB"]}).candidates).toEqual([]);
  expect(rankSources({...base,frequency:"daily"}).candidates).toEqual([]);
 });
 test("US release-day CPI prioritises producer while preserving transformation and adjustment",()=>{
  const c=rankSources({...base,countries:["US"],purpose:"release"},{FRED:true}).candidates;
  expect(c[0].source).toBe("BLS");expect(c[0].requests[0].arguments.series_ids).toEqual(["CUUR0000SA0"]);
  expect(c.find(c=>c.source==="FRED")!.requests[0].arguments).toEqual({series_id:"CPIAUCNS",units:"pc1",limit:2});
 });
 test("does not equate annualized GDP, unannualized growth and level",()=>{
  expect(rankSources({...base,measure:"real_gdp_growth_qoq",countries:["US"]},{FRED:true}).candidates).toEqual([]);
  const c=rankSources({...base,measure:"real_gdp_growth_annualized",countries:["US"]},{FRED:true,BEA:true}).candidates;
  expect(c[0].source).toBe("BEA");expect(c[1].requests[0].arguments.series_id).toBe("A191RL1Q225SBEA");
 });
 test("preserves real/nominal, sector, valuation and adjustment distinctions",()=>{
  const c=rankSources({...base,measure:"private_credit_gdp"}).candidates[0];
  expect(c.requests[0].arguments.series_key).toBe("Q.US.P.A.M.770.A");
  expect(rankSources({...base,measure:"real_house_prices"}).candidates[0].requests[0].arguments.series_key).toBe("Q.US.R.628");
  expect(rankSources({...base,measure:"nominal_house_prices"}).candidates[0].requests[0].arguments.series_key).toBe("Q.US.N.628");
 });
});
describe("verification and source overrides",()=>{
 test("uses actual common periods and exposes provenance",async()=>{
  const r=await selectSource(base,{},probe,new Date("2026-10-12T00:00:00Z"));
  expect(r.status).toBe("verified_recommendation");expect(r.selected.source).toBe("OECD");
  expect(r.selected.verification.commonPeriods).toEqual(["2026-07","2026-08"]);
  expect(r.selected.verification.ageDays).toBe(42);
  expect(r.selected.verification.countries[0].urls).toEqual(["https://example.org/data"]);
 });
 test("respects explicit IMF preference even when OECD ranks higher by policy",async()=>{
  const r=await selectSource({...base,preferredSource:"IMF"},{},probe);
  expect(r.selected.source).toBe("IMF");
 });
 test("missing keys or unsupported overrides do not cause silent substitution",async()=>{
  const missing=await selectSource({...base,countries:["US"],preferredSource:"FRED"},{},probe);
  expect(missing.status).toBe("requested_source_not_verified");expect(missing.selected).toBeNull();
  const wrong=await selectSource({...base,preferredSource:"BIS"},{},probe);
  expect(wrong.selected).toBeNull();expect(wrong.explanation).toContain("not overridden");
 });
 test("metadata failures, missing countries and sparse common coverage are unverified",async()=>{
  for(const fn of [async()=>"OECD error: failed",async()=>"COUNTRY=USA REF_AREA=USA\n2026-08: 3",async()=>"REF_AREA=USA REF_AREA=GBR COUNTRY=USA COUNTRY=GBR\n2026-08: 3"]){
   expect((await selectSource(base,{},fn)).selected).toBeNull();
  }
 });
 test("stale data cannot pass a caller's freshness threshold",async()=>{
  const r=await selectSource({...base,maxAgeDays:10},{},probe,new Date("2026-10-12T00:00:00Z"));
  expect(r.selected).toBeNull();expect(r.candidates[0].verification.status).toBe("stale");
 });
 test("verification off does not make network calls or claim verification",async()=>{
  const r=await selectSource({...base,verify:false},{},async()=>{throw new Error("Must not fetch");});
  expect(r.status).toBe("unverified_recommendation");expect(r.selected.verification.status).toBe("unverified");
 });
 test("latest verified common period matters when equally defined candidates differ in freshness",async()=>{
  const r=await selectSource(base,{},async q=>q.tool.startsWith("oecd")?(q.tool.endsWith("structure")?"metadata":(await probe(q)).replaceAll("2026-M08","2026-M06")):probe(q));
  expect(r.selected.source).toBe("IMF");
 });
 test("normalises monthly IMF and BEA quarterly periods without using retrieval dates",()=>{
  expect(observedPeriods("2026-M08: 2\n2026Q2: 3\nRetrieved: 2026-10-12",12)).toEqual(["2026-08","2026-Q2"]);
  expect(observedPeriods("2026-04-01: 3\n2026Q2: 3",12,"quarterly")).toEqual(["2026-Q2"]);
 });
 test("uses older overlapping observations when countries have different latest months",async()=>{
  const r=await selectSource(base,{},async q=>q.tool.endsWith("structure")?"metadata":(await probe(q))+(q.arguments.series_key?.startsWith("USA")?"\n2026-09: 4":"\n2026-06: 1"));
  expect(r.selected.verification.commonPeriods).toEqual(["2026-07","2026-08"]);
  expect(r.selected.requests[0].arguments.limit).toBe(14);
 });
 test("raw BLS indexes cannot verify a request for annual inflation",async()=>{
  const r=await selectSource({...base,countries:["US"],preferredSource:"BLS"},{},async()=>"2026-07: 312\n2026-08: 313");
  expect(r.selected).toBeNull();
 });
});
