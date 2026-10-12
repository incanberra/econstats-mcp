import { afterEach, describe, expect, test } from "bun:test";
import {resetAccessState} from "../src/core/access";
import { gzipSync } from "node:zlib";
import { buildEurostatDataUrl, buildEurostatStructureUrl, formatEurostatDatasets, formatEurostatStructure, formatEurostatJson, validateEurostatFilters, requestEurostat } from "../src/core/eurostat";
import { EconStatsCoreClient } from "../src/core/client";

const params={datasetId:"prc_hicp_minr",filters:{freq:["M"],unit:["RCH_A"],coicop18:["TOTAL"],geo:["DE","FR"]},limit:2};
const url=buildEurostatDataUrl(params);
const xml=`<m:Structure xmlns:m="m" xmlns:s="s" xmlns:c="c"><m:Structures>
<s:Dataflows><s:Dataflow id="PRC_HICP_MINR" agencyID="ESTAT" version="1.0"><c:Name xml:lang="en">HICP current classification</c:Name><c:Description xml:lang="en">Annual inflation rates, not index levels.</c:Description><c:Annotations><c:Annotation><c:AnnotationType>OBS_PERIOD_OVERALL_LATEST</c:AnnotationType><c:AnnotationTitle>2026-09</c:AnnotationTitle></c:Annotation></c:Annotations><s:Structure><Ref id="PRICES" agencyID="ESTAT" version="2.0"/></s:Structure></s:Dataflow></s:Dataflows>
<s:DataStructures><s:DataStructure id="OTHER" agencyID="ESTAT" version="1.0"/><s:DataStructure id="PRICES" agencyID="ESTAT" version="2.0"><s:DataStructureComponents><s:DimensionList>
${["geo","coicop18","unit","freq"].map((id,i)=>`<s:Dimension id="${id}" position="${4-i}"><s:LocalRepresentation><s:Enumeration><Ref id="${id}" agencyID="ESTAT" version="1.0"/></s:Enumeration></s:LocalRepresentation></s:Dimension>`).join("")}
</s:DimensionList></s:DataStructureComponents></s:DataStructure></s:DataStructures>
<s:Codelists>${Object.entries({geo:{DE:"Germany",FR:"France"},coicop18:{TOTAL:"All-items HICP"},unit:{RCH_A:"Annual rate of change"},freq:{M:"Monthly"}}).map(([id,codes])=>`<s:Codelist id="${id}" agencyID="ESTAT" version="1.0">${Object.entries(codes).map(([code,label])=>`<s:Code id="${code}"><c:Name xml:lang="en">${label}</c:Name></s:Code>`).join("")}</s:Codelist>`).join("")}</s:Codelists>
</m:Structures></m:Structure>`;
// Time is FIRST, not last: flat indices 0=DE Jan, 1=FR Jan, 2=DE Feb, 3=FR Feb.
const data={class:"dataset",version:"2.0",label:"HICP",updated:"2026-03-01",source:"ESTAT",id:["time","freq","unit","coicop18","geo"],size:[2,1,1,1,2],dimension:{
 time:{category:{index:{"2026-01":0,"2026-02":1}}},
 freq:{category:{index:{M:0},label:{M:"Monthly"}}},
 unit:{category:{index:{RCH_A:0},label:{RCH_A:"Annual rate of change"}}},
 coicop18:{category:{index:{TOTAL:0},label:{TOTAL:"All-items HICP"}}},
 geo:{category:{index:{DE:0,FR:1},label:{DE:"Germany",FR:"France"}}},
},value:{"0":0,"1":-0.2,"3":1.8},status:{"3":"p"},extension:{id:"PRC_HICP_MINR",description:"<p>Annual inflation is a percentage rate.</p>"}};
const tsv='"title"\t"code"\t"type"\t"last update of data"\t"last table structure change"\t"data start"\t"data end"\t"values"\n'+
 '"Prices"\t"prices"\t"folder"\t" "\t" "\t" "\t" "\t\n'+
 '"    HICP old"\t"prc_hicp_manr"\t"dataset"\t"01.01.2026"\t"01.01.2026"\t"1997-01"\t"2025-12"\t100\n'+
 '"    HICP current"\t"prc_hicp_minr"\t"dataset"\t"02.10.2026"\t"02.10.2026"\t"1996-01"\t"2026-09"\t200\n'+
 '"    HICP current"\t"prc_hicp_minr"\t"dataset"\t"02.10.2026"\t"02.10.2026"\t"1996-01"\t"2026-09"\t200\n';

describe("Eurostat query and discovery",()=>{
 test("encodes repeated filters and limits latest time positions",()=>{
  expect(url.searchParams.getAll("geo")).toEqual(["DE","FR"]);
  expect(url.searchParams.get("lastTimePeriod")).toBe("2");
  expect(buildEurostatStructureUrl("PRC_HICP_MINR").searchParams.get("compressed")).toBe("true");
  const bounded=buildEurostatDataUrl({...params,startPeriod:"2025-01",endPeriod:"2025-12"});
  expect(bounded.searchParams.get("sinceTimePeriod")).toBe("2025-01");
  expect(bounded.searchParams.has("lastTimePeriod")).toBe(false);
 });
 test("rejects unsafe IDs, injected params, broad filters and invalid periods",()=>{
  for(const change of [{datasetId:"../secret"},{datasetId:"DS-123456"},{filters:{}},{filters:{lang:["EN"]}},{filters:{geo:["*"]}},{filters:{geo:["DE"],Geo:["FR"]}},{startPeriod:"2026-13"},{startPeriod:"2026-Q4",endPeriod:"2026-Q1"},{limit:121},{filters:{a:Array.from({length:10},(_,i)=>String(i)),b:Array.from({length:10},(_,i)=>String(i))}}]) expect(()=>buildEurostatDataUrl({...params,...change})).toThrow();
 });
 test("catalogue deduplicates repeated tree entries and reports current coverage first",()=>{
  const text=formatEurostatDatasets(tsv,"inflation");
  expect(text).toContain("2 matches");expect(text.indexOf("prc_hicp_minr")).toBeLessThan(text.indexOf("prc_hicp_manr"));
  expect(text).toContain("1996-01 to 2026-09");
  expect(formatEurostatDatasets(tsv,"inflation",1,1)).toContain("prc_hicp_manr");
  expect(()=>formatEurostatDatasets("<html>Error</html>")).toThrow("catalogue");
 });
 test("resolves the correct structure, sorts dimensions and filters labels",()=>{
  expect(formatEurostatStructure(xml,params.datasetId)).toContain("Required non-time filters: freq, unit, coicop18, geo");
  expect(formatEurostatStructure(xml,params.datasetId,"geo","France")).toContain("FR=France");
  expect(formatEurostatStructure(xml,params.datasetId,"geo","France")).not.toContain("DE=Germany");
  expect(()=>formatEurostatStructure(xml,params.datasetId,"bad")).toThrow("Unknown dimension");
  expect(()=>formatEurostatStructure('<!DOCTYPE x><x/>',params.datasetId)).toThrow("document type");
 });
 test("requires every dimension and validates codes before downloading data",()=>{
  validateEurostatFilters(xml,params);
  expect(()=>validateEurostatFilters(xml,{...params,filters:{freq:["M"],geo:["DE"]}})).toThrow("Missing filter unit");
  expect(()=>validateEurostatFilters(xml,{...params,filters:{...params.filters,geo:["ZZ"]}})).toThrow("Unknown code ZZ");
  expect(()=>validateEurostatFilters(xml,{...params,filters:{...params.filters,bogus:["A"]}})).toThrow("Unknown filter bogus");
 });
});
describe("JSON-stat observations",()=>{
 test("decodes sparse row-major coordinates with time first without mixing countries",()=>{
  const text=formatEurostatJson(data,url,params);
  const germany=text.split("geo=DE (Germany)")[1].split("## Eurostat:")[0];
  const france=text.split("geo=FR (France)")[1];
  expect(germany).toContain("2026-01: 0");expect(germany).not.toContain("2026-02: 1.8");
  expect(france).toContain("2026-01: -0.2");expect(france).toContain("2026-02: 1.8 [STATUS=p]");
  expect(text).toContain("1 missing cells omitted");expect(text).toContain("unit=RCH_A (Annual rate of change)");
  expect(text).toContain("Dataset updated: 2026-03-01");expect(text).toContain(`URL: ${url}`);
 });
 test("supports dense values, category-code arrays and per-series output limits",()=>{
  const copy=structuredClone(data) as any;copy.value=[0,-0.2,2.1,null];copy.dimension.geo.category.index=["DE","FR"];
  const text=formatEurostatJson(copy,url,{...params,limit:1});
  expect(text).toContain("2026-02: 2.1");expect(text).toContain("2026-01: -0.2");expect(text).not.toContain("2026-01: 0");
 });
 test("all missing cells produce a clear result and never fabricated zeros",()=>{
  const text=formatEurostatJson({...data,value:{}},url,params);
  expect(text).toContain("No numeric Eurostat observations");expect(text).toContain("4 missing cells omitted");
 });
 test("rejects malformed grids, unexpected datasets, unrequested countries and nonnumeric values",()=>{
  for(const change of [{class:"error"},{size:[2,1]},{value:{"4":99}},{value:{"00":99}},{value:{"0":"99"}},{extension:{id:"OTHER"}},{dimension:{...data.dimension,geo:{category:{index:{DE:0,IT:1}}}}},{dimension:{...data.dimension,geo:{category:{index:{DE:0,FR:0}}}}}]) expect(()=>formatEurostatJson({...data,...change},url,params)).toThrow();
 });
 test("surfaces discontinuation notes alongside data",()=>{
  expect(formatEurostatJson({...data,extension:{...data.extension,description:"&lt;p&gt;Discontinued&amp;nbsp;and replaced by prc_hicp_minr.&lt;/p&gt;"}},url,params)).toContain("Dataset notes: Discontinued and replaced by prc_hicp_minr.");
 });
});
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
test("catalogue failures are not cached, and searches share a successful download",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return calls===1 ? new Response("limited",{status:429}) : new Response(tsv);}) as typeof fetch;
 const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await client.eurostatListDatasets("inflation")).toContain("Eurostat error: Eurostat rate limit");
 expect(await client.eurostatListDatasets("inflation")).toContain("cooldown");expect(calls).toBe(1);resetAccessState();
 expect(await client.eurostatListDatasets("inflation")).toContain("2 matches");
 expect(await client.eurostatListDatasets("prc_hicp_minr")).toContain("1 matches");expect(calls).toBe(2);
});
test("metadata supports gzip payloads, and filters reuse one download",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(gzipSync(xml));}) as typeof fetch;
 const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await client.eurostatGetStructure(params.datasetId)).toContain("HICP current");
 expect(await client.eurostatGetStructure(params.datasetId,"geo","France")).toContain("FR=France");expect(calls).toBe(1);
});
test("successful data are cached; API failures are not",async()=>{
 let dataCalls=0;globalThis.fetch=(async(input:any)=>{
  if(String(input).includes("/dataflow/"))return new Response(xml);
  dataCalls++;return dataCalls===1 ? new Response("limited",{status:429}) : new Response(JSON.stringify(data));
 }) as typeof fetch;
 const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await client.eurostatGetData(params)).toContain("Eurostat error: Eurostat rate limit");
 expect(await client.eurostatGetData(params)).toContain("cooldown");expect(dataCalls).toBe(1);resetAccessState();
 expect(await client.eurostatGetData(params)).toContain("2026-02: 1.8");
 expect(await client.eurostatGetData(params)).toContain("2026-02: 1.8");expect(dataCalls).toBe(2);
});
test("invalid filters never request observations; queued queries are clear errors",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{calls++;expect(String(input)).toContain("/dataflow/");return new Response(xml);}) as typeof fetch;
 const client=new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
 expect(await client.eurostatGetData({...params,filters:{geo:["DE"]}})).toContain("Missing filter freq");expect(calls).toBe(1);
 globalThis.fetch=(async()=>new Response("queued",{status:202})) as typeof fetch;
 await expect(requestEurostat(url)).rejects.toThrow("queued");
});
