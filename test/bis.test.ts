import {afterEach,describe,expect,test} from "bun:test";
import {buildBisDataUrl,buildBisStructureUrl,formatBisDatasets,formatBisStructure,getBisDefinition,validateBisKey,formatBisCsv,requestBis} from "../src/core/bis";
import {EconStatsCoreClient} from "../src/core/client";
const params={datasetId:"WS_CBPOL",seriesKey:"M.US+GB",limit:2};
const xml=`<m:Structure xmlns:m="m" xmlns:s="s" xmlns:c="c"><m:Structures>
<s:Dataflows><s:Dataflow agencyID="BIS" id="WS_CBPOL" version="1.0"><c:Name xml:lang="fr">Taux</c:Name><c:Name xml:lang="en">Central bank policy rates</c:Name><c:Description xml:lang="en">Policy intentions</c:Description><s:Structure><Ref agencyID="BIS" id="CBPOL" version="1.0"/></s:Structure></s:Dataflow></s:Dataflows>
<s:DataStructures><s:DataStructure agencyID="BIS" id="OTHER" version="1.0"/><s:DataStructure agencyID="BIS" id="CBPOL" version="1.0"><s:DataStructureComponents><s:DimensionList>
<s:Dimension id="REF_AREA" position="2"><s:ConceptIdentity><Ref agencyID="BIS" maintainableParentID="CS" maintainableParentVersion="1.0" id="REF_AREA"/></s:ConceptIdentity></s:Dimension>
<s:Dimension id="FREQ" position="1"><s:LocalRepresentation><s:Enumeration><Ref agencyID="BIS" id="CL_FREQ" version="1.0"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
</s:DimensionList><s:AttributeList><s:Attribute id="UNIT_MEASURE"/><s:Attribute id="UNIT_MULT"/></s:AttributeList></s:DataStructureComponents></s:DataStructure></s:DataStructures>
<s:Concepts><s:ConceptScheme agencyID="BIS" id="CS" version="1.0"><s:Concept id="REF_AREA"><s:CoreRepresentation><s:Enumeration><Ref agencyID="BIS" id="CL_AREA" version="1.0"/></s:Enumeration></s:CoreRepresentation></s:Concept></s:ConceptScheme></s:Concepts>
<s:Codelists><s:Codelist agencyID="BIS" id="CL_FREQ" version="1.0"><s:Code id="M"><c:Name xml:lang="en">Monthly</c:Name></s:Code><s:Code id="D"><c:Name xml:lang="en">Daily</c:Name></s:Code></s:Codelist><s:Codelist agencyID="BIS" id="CL_AREA" version="1.0"><s:Code id="US"><c:Name xml:lang="en">United States</c:Name></s:Code><s:Code id="GB"><c:Name xml:lang="en">United Kingdom</c:Name></s:Code></s:Codelist></s:Codelists>
</m:Structures></m:Structure>`;
const def=getBisDefinition(xml,params.datasetId),url=buildBisDataUrl({...params,version:def.version});
// BIS places attributes before TIME_PERIOD; they must not become dimensions.
const csv=`FREQ,Frequency,REF_AREA,Reference area,UNIT_MEASURE,Unit of measure,UNIT_MULT,Unit Multiplier,COMPILATION,SOURCE_REF,SUPP_INFO_BREAKS,TITLE,TIME_PERIOD,OBS_VALUE,OBS_STATUS,Observation Status,OBS_PRE_BREAK
M,Monthly,US,United States,368,Per cent per year,0,Units,"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-01,0,A,Normal,
M,Monthly,GB,"United Kingdom\nincluding islands",368,Per cent per year,0,Units,Official bank rate,Bank of England,,Policy rates,2026-01,-0.5,E,Estimated,-0.6
M,Monthly,US,United States,368,Per cent per year,0,Units,"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-02,,Q,Missing,
M,Monthly,US,United States,368,Per cent per year,0,Units,"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-03,3.5,A,Normal,
`;
describe("BIS selectors and definitions",()=>{
 test("uses REST v2 paths, latest stable metadata, labels and a version-pinned citation",()=>{
  expect(buildBisStructureUrl(params.datasetId).pathname).toEndWith("/WS_CBPOL/+");
  expect(url.pathname).toContain("/data/dataflow/BIS/WS_CBPOL/1.0/M.US+GB");
  expect(url.searchParams.get("labels")).toBe("both");expect(url.searchParams.get("lastNObservations")).toBe("2");
 });
 test("time ranges use v2 component constraints and do not limit downloads to recent periods",()=>{
  const u=buildBisDataUrl({...params,startPeriod:"2024-01",endPeriod:"2024-03"});
  expect(u.searchParams.get("c[TIME_PERIOD]")).toBe("ge:2024-01+le:2024-03");
  expect(u.searchParams.has("lastNObservations")).toBe(false);expect(u.searchParams.has("startPeriod")).toBe(false);
  expect(buildBisDataUrl({...params,startPeriod:"2024-02-29",endPeriod:"2024-03-01"}).searchParams.get("c[TIME_PERIOD]")).toContain("2024-02-29");
 });
 test("rejects broad queries, unsafe paths, invalid dates and reversed ranges",()=>{
  for(const change of [{datasetId:"../evil"},{datasetId:"all"},{version:"../1"},{seriesKey:"all"},{seriesKey:"M..US"},{seriesKey:"M.US?x=y"},{limit:121},{limit:0},{startPeriod:"2026-31"},{startPeriod:"2026-02-30"},{startPeriod:"2024-Q4",endPeriod:"2024-Q1"},{seriesKey:Array(6).fill("A+B").join(".")}]) expect(()=>buildBisDataUrl({...params,...change})).toThrow();
 });
 test("catalogue filters English names, excludes non-statistical flows and paginates",()=>{
  expect(formatBisDatasets(xml,"policy")).toContain("WS_CBPOL (version 1.0): Central bank policy rates");
  expect(formatBisDatasets(xml,"credit")).toContain("0 matches");
  expect(formatBisDatasets(xml,"policy",1)).toContain("No matching");
  expect(formatBisDatasets(xml.replaceAll("WS_CBPOL","BIS_REL_CAL"))).toContain("0 matches");
 });
 test("resolves the referenced DSD and inherited codes in order",()=>{
  expect(formatBisStructure(xml,params.datasetId)).toContain("dimension order: FREQ.REF_AREA");
  const text=formatBisStructure(xml,params.datasetId,undefined,"REF_AREA","kingdom");
  expect(text).toContain("GB=United Kingdom");expect(text).not.toContain("US=United States");
  expect(()=>formatBisStructure(xml,params.datasetId,"2.0")).toThrow("requested dataset");
  expect(()=>formatBisStructure(xml,params.datasetId,undefined,"BOGUS")).toThrow("Unknown BIS dimension");
 });
 test("validates all key positions and codes before fetching data",()=>{
  validateBisKey(def,params.seriesKey);
  expect(()=>validateBisKey(def,"M.US.ZZ")).toThrow("2 dimensions");
  expect(()=>validateBisKey(def,"M.ZZ")).toThrow("Unknown BIS code ZZ for REF_AREA");
  expect(()=>getBisDefinition('<!DOCTYPE x><x/>',params.datasetId)).toThrow("document type");
  expect(()=>formatBisDatasets("<html>Error</html>")).toThrow("metadata response");
 });
});
describe("BIS observations",()=>{
 test("separates countries using DSD dimensions, preserving units, notes and status",()=>{
  const text=formatBisCsv(csv,url,params,def);
  expect(text.match(/## BIS:/g)?.length).toBe(2);
  const us=text.split("series M.US")[1].split("## BIS:")[0],gb=text.split("series M.GB")[1];
  expect(us).toContain("2026-01: 0");expect(us).not.toContain("2026-01: -0.5");
  expect(gb).toContain("2026-01: -0.5 [OBS_STATUS=E (Estimated), OBS_PRE_BREAK=-0.6]");
  for(const item of ["UNIT_MEASURE=368 (Per cent per year)","UNIT_MULT=0 (Units)","COMPILATION=Policy rate, end of month","SOURCE_REF=Federal Reserve","SUPP_INFO_BREAKS=Break in 1985","1 missing observations omitted",`URL: ${url}`,"Retrieved:"]) expect(text).toContain(item);
 });
 test("limits each country independently and handles header-only and missing data",()=>{
  const text=formatBisCsv(csv,url,{...params,limit:1},def);
  expect(text).toContain("2026-03: 3.5");expect(text).not.toContain("2026-01: 0");expect(text).toContain("2026-01: -0.5");
  expect(formatBisCsv(csv.split("\n")[0]+"\n",url,params,def)).toContain("No numeric BIS observations");
 });
 test("rejects malformed columns, unrequested countries, conflicting observations and unit changes",()=>{
  const row=csv.split("\n")[1];
  for(const sample of ["<html/>",csv.replace(",3.5,",",garbage,"),csv.replace(",US,United States,",",CA,Canada,"),csv+row.replace(",2026-01,0,",",2026-01,7,")+"\n",csv.replace(",2026-03,3.5,",",2026-03,3.5,").replace('"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-03','"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,')]) expect(()=>formatBisCsv(sample,url,params,def)).toThrow();
  expect(()=>formatBisCsv(csv.replace('US,United States,368,Per cent per year,0,Units,"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-03','US,United States,368,Per cent per year,6,Millions,"Policy rate, end of month",Federal Reserve,"Break in 1985",Policy rates,2026-03'),url,params,def)).toThrow("inconsistent UNIT_MULT");
 });
});
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
test("searches and code filters share validated metadata downloads",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(xml);}) as typeof fetch;
 const c=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await c.bisListDatasets("policy")).toContain("WS_CBPOL");await c.bisListDatasets("credit");
 await c.bisGetStructure(params.datasetId);await c.bisGetStructure(params.datasetId,undefined,"REF_AREA","kingdom");expect(calls).toBe(2);
});
test("API failures are not cached; observations pin versions and then reuse cached data",async()=>{
 let dataCalls=0;globalThis.fetch=(async(input:any)=>{
  if(String(input).includes("/structure/"))return new Response(xml);
  expect(String(input)).toContain("/WS_CBPOL/1.0/");dataCalls++;
  return dataCalls===1 ? new Response("limited",{status:429}) : new Response(csv);
 }) as typeof fetch;
 const c=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await c.bisGetData(params)).toContain("BIS error: BIS rate limit");
 expect(await c.bisGetData(params)).toContain("2026-03: 3.5");await c.bisGetData(params);expect(dataCalls).toBe(2);
});
test("invalid codes never download observations and large-query errors are actionable",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{calls++;expect(String(input)).toContain("/structure/");return new Response(xml);}) as typeof fetch;
 const c=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await c.bisGetData({...params,seriesKey:"M.ZZ"})).toContain("Unknown BIS code ZZ");expect(calls).toBe(1);
 globalThis.fetch=(async()=>new Response("queued",{status:202})) as typeof fetch;
 await expect(requestBis(url)).rejects.toThrow("too large or queued");
});
