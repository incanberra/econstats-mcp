import {afterEach,describe,expect,test} from "bun:test";
import {buildEiaDataUrl,buildEiaMetadataUrl,validateEiaSelection,formatEiaRoutes,formatEiaMetadata,formatEiaFacets,formatEiaData,requestEia} from "../src/core/eia";
import {EconStatsCoreClient} from "../src/core/client";
import {rankSources} from "../src/core/selection";
import {resetAccessState} from "../src/core/access";
const p={route:"electricity/retail-sales",frequency:"monthly",fields:["price"],facets:{stateid:["US","CO"],sectorid:["RES"]},length:3};
const meta={id:"retail-sales",name:"Electricity retail sales",frequency:[{id:"monthly",format:"YYYY-MM"}],facets:[{id:"stateid"},{id:"sectorid"}],data:{price:{units:"cents per kilowatt-hour"}},startPeriod:"2001-01",endPeriod:"2026-07"};
const data={total:"50",frequency:"monthly",data:[{period:"2026-07",stateid:"US",sectorid:"RES",stateDescription:"U.S. Total",price:"0","price-units":"cents per kilowatt-hour"},{period:"2026-07",stateid:"CO",sectorid:"RES",stateDescription:"Colorado",price:"-0.2","price-units":"cents per kilowatt-hour"},{period:"2026-06",stateid:"CO",sectorid:"RES",stateDescription:"Colorado",price:null,"price-units":"cents per kilowatt-hour"}]};
const url=buildEiaDataUrl(p);
describe("EIA selectors and metadata",()=>{
 test("encodes exact facets and sorted pages, never adding a key to citation URLs",()=>{
  expect(url.searchParams.get("facets[stateid][0]")).toBe("CO");expect(url.searchParams.get("sort[0][direction]")).toBe("desc");
  expect(url.searchParams.has("api_key")).toBe(false);expect(url.searchParams.get("length")).toBe("3");
  expect(buildEiaMetadataUrl(p.route,"stateid").pathname).toBe("/v2/electricity/retail-sales/facet/stateid/");
 });
 test("rejects URL injection, broad combinations and invalid periods/page sizes",()=>{
  for(const change of [{route:"https://evil.org"},{route:"../petroleum"},{route:"electricity/data"},{facets:{stateid:["*"]}},{length:5001},{offset:-1},{startPeriod:"2026-02-30"},{startPeriod:"2026-12",endPeriod:"2026-01"},{fields:["price?api_key=x"]},{facets:{a:Array.from({length:10},(_,i)=>String(i)),b:Array.from({length:10},(_,i)=>String(i))}}])expect(()=>buildEiaDataUrl({...p,...change})).toThrow();
 });
 test("checks frequency, fields and facets against metadata before download",()=>{
  validateEiaSelection(meta,p);
  for(const change of [{frequency:"daily"},{fields:["garbage"]},{facets:{stateid:["US"]}},{facets:{bogus:["US"]}}])expect(()=>validateEiaSelection(meta,{...p,...change})).toThrow();
  validateEiaSelection({...meta,facets:[{id:"series"},{id:"product"}]},{...p,facets:{series:["RWTC"]}});
 });
 test("hierarchical discovery and facet lookup disclose scope and coverage",()=>{
  expect(formatEiaRoutes({routes:[{id:"electricity",name:"Electricity"},{id:"petroleum",name:"Oil"}]},"","electricity")).toContain("1 of 1 child routes");
  expect(formatEiaMetadata(meta,p.route)).toContain("2001-01 to 2026-07");
  expect(formatEiaFacets({facets:[{id:"US",name:"U.S. Total"},{id:"CO",name:"Colorado"}],totalFacets:100},url,"colorado")).toContain("CO: Colorado");
  expect(()=>formatEiaMetadata({},p.route)).toThrow();
 });
 test("energy selection uses explicit sector/grade/location and exposes missing-key readiness",()=>{
  const c=rankSources({measure:"residential_electricity_price",countries:["US"]}).candidates[0];
  expect(c.source).toBe("EIA");expect(c.ready).toBe(false);expect(c.requests[0].arguments.facets.sectorid).toEqual(["RES"]);
  expect(rankSources({measure:"gasoline_price",countries:["US"]},{EIA:true}).candidates).toEqual([]);
  expect(rankSources({measure:"henry_hub_spot_price",countries:["US"]},{EIA:true}).candidates[0].requests[0].arguments.facets.series).toEqual(["RNGWHHD"]);
 });
});
describe("EIA observations",()=>{
 test("preserves zero/negative values and units while separating states and counting missing",()=>{
  const text=formatEiaData(data,url,p,meta);
  expect(text.match(/## EIA:/g)?.length).toBe(2);expect(text).toContain("2026-07: 0");expect(text).toContain("2026-07: -0.2");
  expect(text).toContain("1 missing values omitted");expect(text).toContain("units=cents per kilowatt-hour");
  expect(text).toContain("use offset=3");expect(text).toContain("rows per query page, not observations per series");expect(text).toContain("API key omitted");
 });
 test("rejects unexpected facets/frequency, nonnumeric values, changed units and conflicting rows",()=>{
  for(const change of [{frequency:"annual"},{data:[{...data.data[0],stateid:"XX"}]},{data:[{...data.data[0],price:"invalid"}]},{data:[data.data[0],{...data.data[0],price:"9"}]},{data:[data.data[0],{...data.data[0],period:"2026-06","price-units":"dollars"}]}])expect(()=>formatEiaData({...data,...change},url,p,meta)).toThrow();
 });
 test("empty data are explicit and outlooks are labelled projections",()=>{
  expect(formatEiaData({...data,data:[]},url,p,meta)).toContain("No numeric EIA observations");
  expect(formatEiaData(data,url,{...p,route:"steo"},meta)).toContain("contains projections/estimates");
 });
});
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
test("authenticates privately and strips API request echoes and reflected keys",async()=>{
 globalThis.fetch=(async(input:any)=>{expect(new URL(input).searchParams.get("api_key")).toBe("secret_test_key");return new Response(JSON.stringify({response:{...data,description:"secret_test_key"},request:{api_key:"secret_test_key"}}));}) as typeof fetch;
 const response=await requestEia(url,"secret_test_key");expect(response.request).toBeUndefined();expect(JSON.stringify(response)).not.toContain("secret_test_key");expect(url.searchParams.has("api_key")).toBe(false);
});
test("missing/invalid keys and network errors do not expose credentials",async()=>{
 await expect(requestEia(url)).rejects.toThrow("not configured");
 globalThis.fetch=(async()=>{throw new Error("URL api_key=secret_test_key");}) as typeof fetch;
 await expect(requestEia(url,"secret_test_key")).rejects.toThrow("EIA request failed or timed out");
 globalThis.fetch=(async()=>new Response("secret_test_key",{status:403})) as typeof fetch;
 await expect(requestEia(url,"secret_test_key")).rejects.toThrow("rejected the API key");
});
test("API failures are not cached; successful public data and metadata are shared",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{if(!String(input).includes("/data/"))return new Response(JSON.stringify({response:meta}));calls++;return calls===1?new Response("limited",{status:429}):new Response(JSON.stringify({response:data,request:{api_key:"secret_test_key"}}));}) as typeof fetch;
 const c=new EconStatsCoreClient({EIA_KEY:"secret_test_key"});
 expect(await c.eiaGetData(p)).toContain("EIA error: EIA rate limit");
 expect(await c.eiaGetData(p)).toContain("cooldown");expect(calls).toBe(1);
 resetAccessState(); // Simulate a new request window, preserving the data cache.
 expect(await c.eiaGetData(p)).toContain("2026-07: 0");
 expect(await c.eiaGetData(p)).not.toContain("secret_test_key");expect(calls).toBe(2);
});
test("invalid selectors never download observations and malformed payloads are not cached",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{calls++;expect(String(input)).not.toContain("/data/");return new Response(JSON.stringify({response:meta}));}) as typeof fetch;
 const c=new EconStatsCoreClient({EIA_KEY:"test_key"});
 expect(await c.eiaGetData({...p,frequency:"daily"})).toContain("frequency is not available");expect(calls).toBe(1);
 globalThis.fetch=(async()=>new Response(JSON.stringify({response:{bad:true}}))) as typeof fetch;
 expect(await new EconStatsCoreClient({EIA_KEY:"test_key"}).eiaGetMetadata(p.route)).toContain("Unexpected EIA route metadata");
});

// Official API response snapshots captured 2026-10-12, excluding request/key echoes.
// Replay checks the provider's actual schema without consuming its rate limit.
for(const [fixture,measure,route,field,facets,units] of [
 ["electricity","residential_electricity_price","electricity/retail-sales","price",{stateid:["US"],sectorid:["RES"]},"cents per kilowatt-hour"],
 ["wti","wti_spot_price","petroleum/pri/spt","value",{series:["RWTC"]},"$/BBL"],
] as const){
 test(`recorded official ${fixture} schema supports data retrieval and source verification`,async()=>{
  const metadata=await Bun.file(new URL(`./fixtures/eia/${fixture}-metadata.json`,import.meta.url)).json();
  const observations=await Bun.file(new URL(`./fixtures/eia/${fixture}-data.json`,import.meta.url)).json();
  let calls=0;globalThis.fetch=(async(input:any)=>{calls++;return new Response(JSON.stringify({response:String(input).includes("/data/")?observations:metadata}));}) as typeof fetch;
  const c=new EconStatsCoreClient({EIA_KEY:"fixture_key"});
  const text=await c.eiaGetData({route,frequency:"monthly",fields:[field],facets:facets as any,length:2});
  expect(text).toContain(`units=${units}`);expect(text.match(/^\d{4}-\d{2}:/gm)?.length).toBe(2);
  const selection=JSON.parse(await c.selectSource({measure,countries:["US"],observations:2}));
  expect(selection.status).toBe("verified_recommendation");expect(selection.selected.source).toBe("EIA");expect(selection.selected.verification.commonPeriods.length).toBe(2);
  expect(calls).toBe(2);expect(JSON.stringify({metadata,observations})).not.toContain("api_key");
 });
}
