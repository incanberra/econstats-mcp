import {afterEach,expect,test} from "bun:test";
import {worldBankPages,worldBankUrl,ecbUrl,formatEcb} from "../src/core/legacy";
import {EconStatsCoreClient} from "../src/core/client";
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
const p={countryCodes:["US","GB"],indicator:"SP.POP.TOTL",startYear:2020,endYear:2021};
const row=(id:string,year:string,value:number|null)=>({indicator:{id:"SP.POP.TOTL",value:"Population, total"},country:{id:id==="USA"?"US":"GB",value:id},countryiso3code:id,date:year,value,unit:"",obs_status:"",decimal:0});
test("World Bank downloads every page and keeps countries, missing/zero values and provenance separate",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{const u=new URL(input);calls++;
  if(!u.pathname.includes("/country/"))return new Response(JSON.stringify([{page:1,pages:1,total:1},[{id:"SP.POP.TOTL",name:"Population, total",unit:"persons",sourceNote:"Total residents",sourceOrganization:"National authorities"}]]));
  const page=Number(u.searchParams.get("page"));return new Response(JSON.stringify([{page,pages:2,total:4,lastupdated:"2026-10-01"},page===1?[row("USA","2021",1),row("GBR","2021",0)]:[row("USA","2020",null),row("GBR","2020",2)]]));
 }) as typeof fetch;
 const c=new EconStatsCoreClient({});const text=await c.worldBankGetData(p);
 expect(text).toContain("Country=USA");expect(text).toContain("Country=GBR");expect(text).toContain("2021: 0");expect(text).toContain("1 missing observations");expect(text).toContain("All 2 pages retrieved (4 rows)");expect(text).toContain("unit=persons");expect(text).toContain("2026-10-01");expect(text).toContain("date=2020%3A2021");
 await c.worldBankGetData(p);expect(calls).toBe(3);
});
test("World Bank changed, repeated and incomplete pages fail rather than returning partial success",async()=>{
 for(const second of [[{page:2,pages:2,total:3},[row("USA","2020",1)]],[{page:2,pages:2,total:2},[row("USA","2021",1)]],[{page:2,pages:2,total:2},[]]]){
  globalThis.fetch=(async(input:any)=>new Response(JSON.stringify(new URL(input).searchParams.get("page")==="1"?[{page:1,pages:2,total:2},[row("USA","2021",1)]]:second))) as typeof fetch;
  await expect(worldBankPages(worldBankUrl(p))).rejects.toThrow();
 }
});
test("World Bank discovery searches the full catalogue rather than sending unsupported text search",async()=>{
 let calls=0;globalThis.fetch=(async(input:any)=>{calls++;const u=new URL(input);expect(u.searchParams.has("q")).toBe(false);expect(u.searchParams.get("source")).toBe("2");const page=Number(u.searchParams.get("page"));return new Response(JSON.stringify([{page,pages:2,total:2},[{id:page===1?"A":"B",name:page===1?"Employment":"Population, total"}]]));}) as typeof fetch;
 const c=new EconStatsCoreClient({});expect(await c.worldBankSearch("population")).toContain("B: Population, total");await c.worldBankSearch("employment");expect(calls).toBe(2);
});
test("legacy provider HTTP/application errors and malformed schemas are not cached",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return calls===1?new Response("private_secret",{status:400}):new Response(JSON.stringify({seriess:[{id:"UNRATE",title:"Unemployment",frequency:"Monthly",units:"Percent"}]}));}) as typeof fetch;
 const c=new EconStatsCoreClient({FRED_KEY:"private_secret"});const failure=await c.fredSearch("unemployment");expect(failure).toStartWith("FRED error:");expect(failure).not.toContain("private_secret");expect(await c.fredSearch("unemployment")).toContain("UNRATE");await c.fredSearch("unemployment");expect(calls).toBe(2);
});
test("BEA errors are not cached and success includes safe query citations",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({BEAAPI:{Results:calls===1?{Error:{APIErrorDescription:"Invalid table"}}:{Data:[{LineDescription:"Gross domestic product",TimePeriod:"2026Q2",DataValue:"3.0"}]}}}));}) as typeof fetch;
 const c=new EconStatsCoreClient({BEA_KEY:"private_secret"});expect(await c.beaGetData("NIPA","T10101","Q","2026")).toStartWith("BEA error:");const good=await c.beaGetData("NIPA","T10101","Q","2026");expect(good).toContain("2026Q2: 3.0");expect(good).toContain("TableName=T10101");expect(good).not.toContain("private_secret");expect(good).not.toContain("UserID=");await c.beaGetData("NIPA","T10101","Q","2026");expect(calls).toBe(2);
});
const ecb={structure:{dimensions:{series:[{id:"FREQ",values:[{id:"M",name:"Monthly"}]},{id:"REF_AREA",values:[{id:"US",name:"USA"},{id:"GB",name:"United Kingdom"}]}],observation:[{id:"TIME_PERIOD",values:[{id:"2026-07"},{id:"2026-08"}]}]},attributes:{series:[{id:"UNIT",values:[{id:"PC",name:"Percent"}]},{id:"UNIT_MULT",values:[{id:"0"}]}],observation:[{id:"OBS_STATUS",values:[{id:"P",name:"Provisional"}]}]}},dataSets:[{series:{"0:0":{attributes:[0,0],observations:{"0":[0,0],"1":[null,0]}},"0:1":{attributes:[0,0],observations:{"0":[-1,0]}}}}]};
test("ECB separates dimensions and retains units, scaling, flags, dates and citation",()=>{
 const url=ecbUrl({flowRef:"FM",key:"M.US+GB",startPeriod:"2026-07"});const text=formatEcb(ecb,url);
 expect(text).toContain("REF_AREA=US (USA)");expect(text).toContain("REF_AREA=GB (United Kingdom)");expect(text).toContain("UNIT=PC (Percent)");expect(text).toContain("UNIT_MULT=0");expect(text).toContain("2026-07: 0 [OBS_STATUS=P");expect(text).toContain("2026-07: -1");expect(text).toContain("1 missing observations");expect(text).toContain("startPeriod=2026-07");
});
test("ECB rejects unrequested series and malformed indices or numeric observations",()=>{
 expect(()=>formatEcb(ecb,ecbUrl({flowRef:"FM",key:"M.US"}))).toThrow("unrequested");
 for(const value of ["bad",Infinity])expect(()=>formatEcb({...ecb,dataSets:[{series:{"0:0":{attributes:[0,0],observations:{"0":[value]}}}}]},ecbUrl({flowRef:"FM",key:"M.US"}))).toThrow("Non-numeric");
 expect(()=>formatEcb({},ecbUrl({flowRef:"FM",key:"M.US"}))).toThrow("Unexpected ECB");
});
test("ECB malformed responses are not cached, and input guards prevent broad downloads",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify(calls===1?{}:ecb));}) as typeof fetch;
 const c=new EconStatsCoreClient({}),args={flowRef:"FM",key:"M.US+GB"};expect(await c.ecbGetData(args)).toStartWith("ECB error:");expect(await c.ecbGetData(args)).toContain("UNIT_MULT=0");await c.ecbGetData(args);expect(calls).toBe(2);
 for(const key of ["M.","*","../data","M.US?api_key=x"])expect(await c.ecbGetData({...args,key})).toStartWith("ECB error:");expect(calls).toBe(2);
 for(const change of [{countryCodes:["*"]},{indicator:"../x"},{startYear:2022,endYear:2021}])expect(()=>worldBankUrl({...p,...change})).toThrow();
});
