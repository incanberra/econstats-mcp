import { afterEach, describe, expect, test } from "bun:test";
import {resetAccessState, accessGovernor} from "../src/core/access";
import { buildOecdCatalogUrl, buildOecdDataUrl, buildOecdStructureUrl, formatOecdCsv, formatOecdDatasets, formatOecdStructure, parseOecdCatalogue, formatOecdCatalogue, requestOecd } from "../src/core/oecd";
import { EconStatsCoreClient } from "../src/core/client";
import {fetchStructured} from "../src/core/structured-data";
import {LayeredCache,MemoryCacheBackend} from "../src/core/cache";

const datasetId = "OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL";
const params = {datasetId,version:"1.0",seriesKey:"USA+GBR.M.N.CPI.PA._T.N.GY",limit:2};
const url = buildOecdDataUrl(params);
const csv = `STRUCTURE,STRUCTURE_ID,STRUCTURE_NAME,ACTION,REF_AREA,Reference area,FREQ,Frequency of observation,UNIT_MEASURE,Unit of measure,ADJUSTMENT,Adjustment,TRANSFORMATION,Transformation,TIME_PERIOD,Time period,OBS_VALUE,Observation value,OBS_STATUS,Observation status,UNIT_MULT,Unit multiplier,BASE_PER,Base period
DATAFLOW,OECD.SDD.TPS:PRICES(1.0),"Prices, all items",I,USA,United States,M,Monthly,PA,Percent per annum,N,Not adjusted,GY,"Growth rate, over 1 year",2024-03,,3.4,,E,Estimated,0,Units,,
DATAFLOW,OECD.SDD.TPS:PRICES(1.0),"Prices, all items",I,GBR,"United Kingdom\nincluding housing",M,Monthly,PA,Percent per annum,N,Not adjusted,GY,"Growth rate, over 1 year",2024-01,,-0.5,,A,Normal,0,Units,,
DATAFLOW,OECD.SDD.TPS:PRICES(1.0),"Prices, all items",I,USA,United States,M,Monthly,PA,Percent per annum,N,Not adjusted,GY,"Growth rate, over 1 year",2024-01,,3.1,,A,Normal,0,Units,,
DATAFLOW,OECD.SDD.TPS:PRICES(1.0),"Prices, all items",I,USA,United States,M,Monthly,PA,Percent per annum,N,Not adjusted,GY,"Growth rate, over 1 year",2024-02,,,,Q,Missing,0,Units,,
`;
const xml = `<m:Structure xmlns:m="m" xmlns:s="s" xmlns:c="c"><m:Structures>
<s:Dataflows><s:Dataflow agencyID="OECD.SDD.TPS" id="DSD_PRICES@DF_PRICES_ALL" version="1.0"><c:Name xml:lang="fr">Prix</c:Name><c:Name xml:lang="en">Consumer price indices</c:Name><s:Structure><Ref agencyID="OECD.SDD.TPS" id="DSD_PRICES" version="1.0"/></s:Structure></s:Dataflow></s:Dataflows>
<s:DataStructures><s:DataStructure agencyID="OECD.SDD.TPS" id="OTHER" version="1.0"/><s:DataStructure agencyID="OECD.SDD.TPS" id="DSD_PRICES" version="1.0"><s:DataStructureComponents><s:DimensionList>
<s:Dimension id="FREQ" position="2"><s:LocalRepresentation><s:Enumeration><Ref agencyID="SDMX" id="CL_FREQ" version="2.1"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
<s:Dimension id="REF_AREA" position="1"><s:ConceptIdentity><Ref agencyID="OECD" maintainableParentID="CS" maintainableParentVersion="1.0" id="REF_AREA"/></s:ConceptIdentity></s:Dimension>
</s:DimensionList></s:DataStructureComponents></s:DataStructure></s:DataStructures>
<s:Concepts><s:ConceptScheme agencyID="OECD" id="CS" version="1.0"><s:Concept id="REF_AREA"><s:CoreRepresentation><s:Enumeration><Ref agencyID="OECD" id="CL_AREA" version="1.0"/></s:Enumeration></s:CoreRepresentation></s:Concept></s:ConceptScheme></s:Concepts>
<s:Codelists><s:Codelist agencyID="OECD" id="CL_AREA" version="1.0"><s:Code id="USA"><c:Name xml:lang="en">United States</c:Name></s:Code><s:Code id="GBR"><c:Name xml:lang="en">United Kingdom</c:Name></s:Code></s:Codelist><s:Codelist agencyID="SDMX" id="CL_FREQ" version="2.1"><s:Code id="M"><c:Name xml:lang="en">Monthly</c:Name></s:Code></s:Codelist></s:Codelists>
</m:Structures></m:Structure>`;

const tivaId = "OECD.STI.PIE,DSD_TIVA_MAINSH@DF_MAINSH";
const tivaParams = {datasetId:tivaId,version:"1.1",seriesKey:"AUS.A",startPeriod:"2020",endPeriod:"2021",limit:2};
// Synthetic responses exercise service routing and the shared contract; not real TiVA values.
const tivaXml = xml.replaceAll("OECD.SDD.TPS", "OECD.STI.PIE")
  .replaceAll("DSD_PRICES@DF_PRICES_ALL", "DSD_TIVA_MAINSH@DF_MAINSH")
  .replaceAll('version="1.0"', 'version="1.1"')
  .replaceAll('maintainableParentVersion="1.0"', 'maintainableParentVersion="1.1"')
  .replaceAll('id="USA"', 'id="AUS"').replaceAll('id="M"', 'id="A"');
const tivaCsv = "DATAFLOW,REF_AREA,FREQ,UNIT_MEASURE,UNIT_MULT,TIME_PERIOD,OBS_VALUE,OBS_STATUS\nOECD.STI.PIE:DSD_TIVA_MAINSH@DF_MAINSH(1.1),AUS,A,PT,0,2020,10,P\nOECD.STI.PIE:DSD_TIVA_MAINSH@DF_MAINSH(1.1),AUS,A,PT,0,2021,11,A\n";

describe("TiVA service routing", () => {
  test("uses an allowlisted space consistently and preserves public defaults", () => {
    expect(buildOecdCatalogUrl().pathname).toStartWith("/public/rest/");
    expect(buildOecdCatalogUrl().searchParams.get("detail")).toBe("allstubs");
    expect(buildOecdCatalogUrl().searchParams.get("references")).toBe("none");
    expect(buildOecdCatalogUrl("sti-public").pathname).toStartWith("/sti-public/rest/");
    expect(buildOecdStructureUrl(tivaId,"1.1").pathname).toStartWith("/sti-public/rest/");
    const u=buildOecdDataUrl(tivaParams);
    expect(u.pathname).toStartWith("/sti-public/rest/");
    expect(u.searchParams.get("startPeriod")).toBe("2020");
    expect(u.searchParams.get("endPeriod")).toBe("2021");
    expect(u.searchParams.has("lastNObservations")).toBe(false);
    expect(u.searchParams.has("firstNObservations")).toBe(false);
    expect(buildOecdStructureUrl(datasetId).pathname).toStartWith("/public/rest/");
    expect(buildOecdStructureUrl(datasetId,undefined,"sti-public").pathname).toStartWith("/sti-public/rest/");
    for(const space of ["../public","https://example.com","dcd-public"]){
      expect(()=>buildOecdCatalogUrl(space as any)).toThrow("Invalid OECD space");
      expect(()=>buildOecdDataUrl({...tivaParams,space:space as any})).toThrow("Invalid OECD space");
    }
  });
  test("rejects unbounded TiVA requests before any provider request", async () => {
    let calls=0;globalThis.fetch=(async()=>{calls++;throw Error("unexpected request");}) as typeof fetch;
    for(const range of [{startPeriod:undefined},{endPeriod:undefined},{startPeriod:undefined,endPeriod:undefined}]){
      expect(()=>buildOecdDataUrl({...tivaParams,...range})).toThrow("requires both");
      await expect(fetchStructured({tool:"oecd_get_data",arguments:{dataset_id:tivaId,series_key:"AUS.A",start_period:range.startPeriod,end_period:range.endPeriod}},{},new LayeredCache(new MemoryCacheBackend()))).rejects.toThrow("requires both");
    }
    expect(calls).toBe(0);
    expect(()=>buildOecdDataUrl({...tivaParams,space:'public',startPeriod:undefined})).toThrow('requires both');
  });
  test("catalogue and structure output identifies the retrieval space", () => {
    expect(formatOecdDatasets(tivaXml,"TiVA")).toContain("space=sti-public");
    expect(formatOecdDatasets(tivaXml,"TiVA",0,20,"sti-public")).toContain("https://sdmx.oecd.org/sti-public/rest/dataflow/");
    expect(formatOecdStructure(tivaXml,tivaId,"1.1")).toContain("Space: sti-public");
    expect(formatOecdStructure(tivaXml,tivaId,"1.1")).toContain("both start_period and end_period");
  });
});

describe("OECD selectors", () => {
  test("builds modern versioned requests with latest observations and labelled CSV", () => {
    expect(url.pathname).toContain("/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/USA+GBR.M.N.CPI.PA._T.N.GY");
    expect(url.searchParams.get("lastNObservations")).toBe("2");
    expect(url.searchParams.get("format")).toBe("csvfilewithlabels");
    expect(buildOecdStructureUrl(datasetId).pathname).toEndWith("/latest");
    expect(buildOecdDataUrl({...params,version:undefined}).pathname).toContain("DSD_PRICES@DF_PRICES_ALL/USA+GBR");
    expect(buildOecdDataUrl({...params,version:"latest"}).pathname).not.toContain(",latest/");
  });
  test("explicit ranges omit lastNObservations for restricted large datasets", () => {
    const u = buildOecdDataUrl({...params,startPeriod:"2024-Q1",endPeriod:"2025-Q4"});
    expect(u.searchParams.get("startPeriod")).toBe("2024-Q1");
    expect(u.searchParams.has("lastNObservations")).toBe(false);
  });
  test("rejects unsafe paths, wildcard downloads, invalid ranges and huge selections", () => {
    for (const change of [{datasetId:"https://example.com"},{version:"../latest"},{seriesKey:"all"},{seriesKey:"USA..M"},{seriesKey:"USA+.M"},{startPeriod:"2024-13"},{startPeriod:"2025-01",endPeriod:"2024-12"},{limit:121},{seriesKey:Array(6).fill("A+B").join(".")}]) {
      expect(()=>buildOecdDataUrl({...params,...change})).toThrow();
    }
  });
});

describe("OECD data and metadata", () => {
  test("preserves labels, growth definition, adjustment, negative values and status", () => {
    const result = formatOecdCsv(csv,url,1);
    for (const expected of ["REF_AREA=USA (United States)","REF_AREA=GBR (United Kingdom\nincluding housing)","UNIT_MEASURE=PA (Percent per annum)","TRANSFORMATION=GY (Growth rate, over 1 year)","ADJUSTMENT=N (Not adjusted)","2024-03: 3.4 [OBS_STATUS=E (Estimated), UNIT_MULT=0 (Units)]","2024-01: -0.5","1 missing observations omitted","Retrieved:",`URL: ${url}`]) expect(result).toContain(expected);
    expect(result).not.toContain("2024-01: 3.1");
    expect(result).not.toContain("2024-02:");
  });
  test("preserves an index base period and scaling without silently converting", () => {
    const sample="DATAFLOW,REF_AREA,FREQ,TIME_PERIOD,OBS_VALUE,UNIT_MULT,BASE_PER\nOECD:TEST(1.0),USA,M,2024-01,123.45,6,2015=100\n";
    expect(formatOecdCsv(sample,url)).toContain("123.45 [UNIT_MULT=6, BASE_PER=2015=100]");
  });
  test("empty and missing values are not turned into zero", () => {
    const header=csv.split("\n")[0]+"\n";
    expect(formatOecdCsv(header,url)).toContain("No numeric OECD observations");
    expect(formatOecdCsv(csv.replace(/,,(?:3\.4|-0\.5|3\.1),,/g,",,,,"),url)).toContain("No numeric OECD observations");
  });
  test("rejects malformed output and contradictory series observations", () => {
    expect(()=>formatOecdCsv("<html>Error</html>",url)).toThrow("observation columns");
    const row=csv.split("\n")[1].replace(",,3.4,,",",,9.9,,")+"\n";
    expect(()=>formatOecdCsv(csv+row,url)).toThrow("conflicting");
    expect(()=>formatOecdCsv(csv.replace(",,3.4,,",",,invalid,,"),url)).toThrow("non-numeric");
  });
  test("catalogue supports inflation synonym, English labels and pagination", () => {
    expect(formatOecdDatasets(xml,"inflation")).toContain(`${datasetId} (version 1.0): Consumer price indices`);
    expect(formatOecdDatasets(xml,"prices",1)).toContain("No matching");
    expect(formatOecdDatasets(xml,"unemployment")).toContain("0 matches");
  });
  test("resolves referenced DSD and inherited codelists in dimension order", () => {
    const result=formatOecdStructure(xml,datasetId);
    expect(result).toContain("dimension order: REF_AREA.FREQ");
    expect(result).toContain("M=Monthly");
    const filtered=formatOecdStructure(xml,datasetId,"1.0","REF_AREA","kingdom");
    expect(filtered).toContain("GBR=United Kingdom");
    expect(filtered).not.toContain("USA=United States");
    expect(()=>formatOecdStructure(xml,datasetId,"1.0","UNKNOWN")).toThrow("Unknown dimension");
    expect(()=>formatOecdStructure(xml,datasetId,"2.0")).toThrow("requested dataset");
  });
  test("rejects XML entity declarations and unexpected metadata", () => {
    expect(()=>formatOecdDatasets('<!DOCTYPE x [<!ENTITY y "z">]><x/>')).toThrow("document type");
    expect(()=>formatOecdStructure("<html/>",datasetId)).toThrow("Unexpected OECD");
  });
});

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
test("rate-limit failures are not retried or cached; successful repeated data are cached", async () => {
  let calls=0;
  globalThis.fetch=(async (input:any)=>{
    calls++;
    expect(String(input)).toStartWith("https://sdmx.oecd.org/public/rest/");
    return calls===1 ? new Response("limited",{status:429,headers:{"Retry-After":"3600"}}) : new Response(csv);
  }) as typeof fetch;
  const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
  expect(await client.oecdGetData(params)).toContain("OECD error: OECD rate limit");
  expect(calls).toBe(1);
  expect(await client.oecdGetData(params)).toContain("cooldown");expect(calls).toBe(1);resetAccessState();
  expect(await client.oecdGetData(params)).toContain("2024-03: 3.4");
  expect(await client.oecdGetData(params)).toContain("2024-03: 3.4");
  expect(calls).toBe(2);
});
test("different searches and dimension filters share metadata downloads", async () => {
  let calls=0;
  globalThis.fetch=(async ()=>{calls++;return new Response(xml);}) as typeof fetch;
  const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
  await client.oecdListDatasets("inflation"); await client.oecdListDatasets("prices");
  expect(calls).toBe(1);
  await client.oecdGetStructure(datasetId); await client.oecdGetStructure(datasetId,undefined,"REF_AREA","kingdom");
  expect(calls).toBe(2);
});

test("concurrent catalogue searches persist only validated identifiers and names, not XML", async () => {
  const catalogueXml = xml.replace('Consumer price indices', 'Education expenditure')
    .replace('</s:Dataflows>', '<s:Dataflow agencyID="OECD.ELS" id="PENSIONS" version="1.0"><c:Name xml:lang="en">Pension expenditure</c:Name><c:Description>Unneeded large description</c:Description></s:Dataflow></s:Dataflows>');
  const persisted: unknown[] = [];
  const backend = new MemoryCacheBackend();
  const cache = new LayeredCache(new MemoryCacheBackend(), {
    get: key => backend.get(key),
    set: async (key, value, ttl) => { persisted.push(value); await backend.set(key, value, ttl); },
  });
  let calls = 0;
  globalThis.fetch = (async input => {
    calls++;
    expect(new URL(String(input)).searchParams.get("detail")).toBe("allstubs");
    return new Response(catalogueXml);
  }) as typeof fetch;
  const client = new EconStatsCoreClient({}, cache);
  const [education, pensions] = await Promise.all([client.oecdListDatasets("education expenditure"), client.oecdListDatasets("pension")]);
  expect(education).toContain("Education expenditure");
  expect(education).not.toContain("Pension expenditure");
  expect(pensions).toContain("Pension expenditure");
  expect(calls).toBe(1);
  expect(persisted).toEqual([[
    { agency: "OECD.SDD.TPS", id: "DSD_PRICES@DF_PRICES_ALL", version: "1.0", name: "Education expenditure" },
    { agency: "OECD.ELS", id: "PENSIONS", version: "1.0", name: "Pension expenditure" },
  ]]);
  expect(await client.oecdListDatasets("pension")).toBe(pensions);
  expect(calls).toBe(1);
  expect(formatOecdCatalogue(parseOecdCatalogue(catalogueXml), "education", 0, 1)).toContain("Showing 1 of 1 matches");
});

test("incomplete catalogue entries fail without poisoning the shared cache", async () => {
  let calls = 0;
  globalThis.fetch = (async () => new Response(++calls === 1 ? xml.replace('version="1.0"', 'version=""') : xml)) as typeof fetch;
  const client = new EconStatsCoreClient({});
  expect(await client.oecdListDatasets("inflation")).toContain("incomplete dataset definition");
  expect(await client.oecdListDatasets("inflation")).toContain("Consumer price indices");
  expect(calls).toBe(2);
});

test("truncated catalogue XML is rejected rather than cached as partial discovery", async () => {
  let calls = 0;
  globalThis.fetch = (async () => new Response(++calls === 1 ? xml.replace('</m:Structures></m:Structure>', '') : xml)) as typeof fetch;
  const client = new EconStatsCoreClient({});
  expect(await client.oecdListDatasets("inflation")).toContain("incomplete or invalid XML");
  expect(await client.oecdListDatasets("inflation")).toContain("Consumer price indices");
  expect(calls).toBe(2);
});

test("oversized OECD bodies are cancelled during download even without Content-Length", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(20_000_001)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await expect(requestOecd(buildOecdCatalogUrl(), true)).rejects.toThrow("exceeds 20 MB");
  expect(cancelled).toBe(true);
  expect((await accessGovernor().snapshot("OECD")).status).toBe("invalid_response");
});

test("an oversized Content-Length rejects and cancels an unread body", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
    headers: { "Content-Length": "20000001" },
  })) as typeof fetch;
  await expect(requestOecd(buildOecdCatalogUrl(), true)).rejects.toThrow("exceeds 20 MB");
  expect(cancelled).toBe(true);
});
test('an incomplete identity-encoded response is rejected before parsing or caching',async()=>{
  globalThis.fetch=(async()=>new Response('short',{headers:{'Content-Length':'100'}})) as typeof fetch;
  await expect(requestOecd(buildOecdCatalogUrl(),true)).rejects.toThrow('length does not match');
});

test("a stalled body times out even if stream cancellation never finishes", async () => {
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }))) as typeof fetch;
  await expect(requestOecd(buildOecdCatalogUrl(), true, 25)).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
  expect((await accessGovernor().snapshot("OECD")).status).toBe("unavailable");
}, 1000);

test("failed OECD body reads do not expose upstream exception text", async () => {
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error("private_upstream_value")); },
  }))) as typeof fetch;
  const client = new EconStatsCoreClient({});
  const result = await client.oecdListDatasets("pension");
  expect(result).toContain("OECD unavailable");
  expect(result).not.toContain("private_upstream_value");
});
test("malformed responses and rejected query sizes are actionable errors, not cached data", async () => {
  let calls=0;
  globalThis.fetch=(async ()=>{calls++;return calls===1 ? new Response("too large",{status:413}) : calls===2 ? new Response("<html>broken</html>") : new Response(csv);}) as typeof fetch;
  const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
  expect(await client.oecdGetData(params)).toContain("Specify start_period");
  expect(await client.oecdGetData(params)).toContain("observation columns");
  expect(await client.oecdGetData(params)).toContain("2024-03: 3.4");
  expect(calls).toBe(3);
});

test("catalogue caches remain separate between public and TiVA spaces", async () => {
  const calls:string[]=[];
  globalThis.fetch=(async input=>{const u=String(input);calls.push(u);return new Response(u.includes('/sti-public/')?tivaXml:xml);}) as typeof fetch;
  const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
  expect(await client.oecdListDatasets("inflation")).toContain("Consumer price indices");
  expect(await client.oecdListDatasets("TiVA",0,20,"sti-public")).toContain(tivaId);
  await client.oecdListDatasets("prices");await client.oecdListDatasets("TiVA",0,20,"sti-public");
  expect(calls.length).toBe(2);expect(calls[0]).toContain('/public/');expect(calls[1]).toContain('/sti-public/');
});

test("structured TiVA retrieval routes metadata and observations, preserves provenance and caches results", async () => {
  const calls:string[]=[];
  globalThis.fetch=(async input=>{const u=new URL(String(input));calls.push(String(u));expect(u.pathname).toStartWith('/sti-public/rest/');return new Response(u.pathname.includes('/dataflow/')?tivaXml:tivaCsv);}) as typeof fetch;
  const cache=new LayeredCache(new MemoryCacheBackend());
  const request={tool:'oecd_get_data',arguments:{dataset_id:tivaId,version:'1.1',series_key:'AUS.A',start_period:'2020',end_period:'2021',limit:2}};
  const result=await fetchStructured(request,{},cache);
  expect(result.source).toBe('OECD');expect(result.schemaVersion).toBe('1.0');
  expect(result.series[0].dimensions).toEqual({REF_AREA:'AUS',FREQ:'A'});
  expect(result.series[0].observations.map(o=>o.value)).toEqual([10,11]);
  expect(result.series[0].observations[0].attributes.OBS_STATUS).toBe('P');
  expect(result.series[0].unitMultiplier).toBe(0);
  expect(result.series[0].urls[0]).toContain('/sti-public/rest/data/');
  expect(result.series[0].urls[0]).not.toContain('lastNObservations');
  expect(await fetchStructured(request,{},cache)).toEqual(result);expect(calls.length).toBe(2);
  await fetchStructured(request,{},cache,true);expect(calls.length).toBe(3);
});

test("explicit space reaches both structured metadata and observations without sharing another space's cache", async () => {
  const calls:string[]=[];
  globalThis.fetch=(async input=>{const u=new URL(String(input));calls.push(u.pathname);return new Response(u.pathname.includes('/dataflow/')?tivaXml:tivaCsv);}) as typeof fetch;
  const cache=new LayeredCache(new MemoryCacheBackend());
  for(const space of ['public','sti-public'])await fetchStructured({tool:'oecd_get_data',arguments:{dataset_id:tivaId,version:'1.1',space,series_key:'AUS.A',start_period:'2020',end_period:'2021'}},{},cache);
  expect(calls.length).toBe(4);expect(calls.slice(0,2).every(u=>u.startsWith('/public/'))).toBe(true);expect(calls.slice(2).every(u=>u.startsWith('/sti-public/'))).toBe(true);
});
