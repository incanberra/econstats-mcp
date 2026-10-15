import {afterEach,expect,test} from "bun:test";
import {mkdtemp,readdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {RequestGovernor,providerFetch,accessGovernor,AccessError} from "../src/core/access";
import {FileCacheBackend,LayeredCache,MemoryCacheBackend} from "../src/core/cache";
import {connectionHealth} from "../src/core/health";
import {checkedJson} from "../src/core/legacy";
import {fetchRetry} from '../src/core/http';
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});

test('shared fetch preserves caller cancellation after response headers arrive',async()=>{
 const controller=new AbortController();let requestSignal:AbortSignal|undefined;
 globalThis.fetch=(async(_input:any,init:any)=>{requestSignal=init.signal;return new Response('ok');}) as typeof fetch;
 await fetchRetry('https://api.worldbank.org/v2/country/US',{signal:controller.signal});expect(requestSignal!.aborted).toBe(false);controller.abort();expect(requestSignal!.aborted).toBe(true);
});
test('failed response bodies return an unavailable error without partial data or raw messages',async()=>{
 globalThis.fetch=(async()=>({ok:true,status:200,text:async()=>{throw Error('private_secret');}} as unknown as Response)) as unknown as typeof fetch;
 try{await checkedJson('https://api.worldbank.org/v2/country/US');throw Error('expected failure');}catch(e){expect(e).toBeInstanceOf(AccessError);expect((e as AccessError).kind).toBe('unavailable');expect(String(e)).not.toContain('private_secret');}
});
test("request budget survives new instances and concurrent reservations cannot overspend",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"econstats-budget-")),a=new RequestGovernor(dir,{EIA:2}),b=new RequestGovernor(dir,{EIA:2});
 const results=await Promise.allSettled([a.reserve("EIA"),b.reserve("EIA"),a.reserve("EIA"),b.reserve("EIA")]);
 expect(results.filter(r=>r.status==="fulfilled").length).toBe(2);
 expect((await new RequestGovernor(dir,{EIA:2}).snapshot("EIA")).budget.used).toBe(2);
 expect((await b.snapshot("EIA")).status).toBe("budget_exhausted");
});
test("budget windows and provider cooldown expire without sleeping",async()=>{
 let now=Date.parse("2026-10-12T00:00:00Z");const g=new RequestGovernor(undefined,{EIA:1},()=>now);
 await g.reserve("EIA");await expect(g.reserve("EIA")).rejects.toThrow("budget exhausted");
 now+=3600001;expect((await g.snapshot("EIA")).status).toBe("not_checked");await g.reserve("EIA");
 await g.record("EIA","rate_limited",429,3600000);await expect(g.reserve("EIA")).rejects.toThrow("cooldown");
 now+=3600001;await g.reserve("EIA");expect((await g.snapshot("EIA")).budget.used).toBe(1);
});
test("429 persists cooldown and does not immediately send another request",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response("secret",{status:429,headers:{"Retry-After":"3600"}});}) as typeof fetch;
 await expect(providerFetch("https://api.eia.gov/v2/?api_key=secret")).rejects.toThrow("HTTP 429");
 await expect(providerFetch("https://api.eia.gov/v2/?api_key=secret")).rejects.toThrow("cooldown");expect(calls).toBe(1);
 const s=await accessGovernor().snapshot("EIA");expect(s.status).toBe("rate_limited");expect(s.budget.used).toBe(1);expect(s.cooldownUntil).not.toBeNull();expect(JSON.stringify(s)).not.toContain("secret");
});
test("auth errors and network failures remain distinct and never expose credentials",async()=>{
 globalThis.fetch=(async()=>new Response("private",{status:403})) as typeof fetch;
 try{await providerFetch("https://api.eia.gov/v2/?api_key=private");}catch(e){expect((e as AccessError).kind).toBe("rejected_key");expect(String(e)).not.toContain("private");}
 globalThis.fetch=(async()=>{throw new Error("https://api.eia.gov/?api_key=private");}) as typeof fetch;
 await expect(providerFetch("https://api.eia.gov/v2/?api_key=private")).rejects.toThrow("unavailable");
 expect((await accessGovernor().snapshot("EIA")).status).toBe("unavailable");
});
test("disk cache stores object metadata and strings, survives new instances, expires and ignores corruption",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"econstats-cache-"));let now=1000;
 const a=new FileCacheBackend(dir,()=>now);await a.set("metadata",{routes:["electricity"]},2);await a.set("data","2026-07: 18.31",2);
 const b=new FileCacheBackend(dir,()=>now);expect(await b.get("metadata")).toEqual({routes:["electricity"]});expect(await b.get("data")).toContain("18.31");
 now=4000;expect(await b.get("data")).toBeNull();
 const files=await readdir(dir);await Promise.all(files.map(f=>writeFile(join(dir,f),"broken")));expect(await b.get("metadata")).toBeNull();
});
test("persistent cache avoids recomputation and failed upstream work is not stored",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"econstats-layered-"));let calls=0;
 const first=new LayeredCache(new MemoryCacheBackend(),new FileCacheBackend(dir));
 await expect(first.getOrCompute("data",100,async()=>{calls++;throw new Error("failed");})).rejects.toThrow("failed");expect((await readdir(dir)).length).toBe(0);
 expect(await first.getOrCompute("data",100,async()=>{calls++;return "valid";})).toBe("valid");
 const second=new LayeredCache(new MemoryCacheBackend(),new FileCacheBackend(dir));expect(await second.getOrCompute("data",100,async()=>{calls++;return "wrong";})).toBe("valid");expect(calls).toBe(2);
});
test("cached tool calls do not spend request budget",async()=>{
 const cache=new LayeredCache(new MemoryCacheBackend());let calls=0;
 globalThis.fetch=(async()=>{calls++;return new Response("ok");}) as typeof fetch;
 const compute=async()=>await(await providerFetch("https://api.eia.gov/v2/")).text();
 await cache.getOrCompute("same",100,compute);await cache.getOrCompute("same",100,compute);
 expect(calls).toBe(1);expect((await accessGovernor().snapshot("EIA")).budget.used).toBe(1);
});
test("health reports missing versus unchecked keys and makes no network calls by default",async()=>{
 globalThis.fetch=(async()=>{throw new Error("Must not fetch");}) as typeof fetch;
 const result=await connectionHealth({EIA_KEY:"private"},["EIA","BEA"]);
 expect(result.providers[0].status).toBe("not_checked");expect(result.providers[0].keyConfigured).toBe(true);expect(result.providers[0].budget.used).toBe(0);
 expect(result.providers[1].status).toBe("missing_key");expect(JSON.stringify(result)).not.toContain("private");
 await expect(connectionHealth({},["IMF","OECD","BIS","ECB"],true)).rejects.toThrow("at most 3");
});
test("live health bypasses data caches and detects successful and rejected-key responses",async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({response:{routes:[]},request:{api_key:"private"}}));}) as typeof fetch;
 const good=await connectionHealth({EIA_KEY:"private"},["EIA"],true);expect(good.providers[0].status).toBe("healthy");expect(good.providers[0].probed).toBe(true);expect(JSON.stringify(good)).not.toContain("private");expect(calls).toBe(1);
 globalThis.fetch=(async()=>new Response("private",{status:403})) as typeof fetch;
 expect((await connectionHealth({EIA_KEY:"private"},["EIA"],true)).providers[0].status).toBe("rejected_key");
});
test("HTTP 200 application failures are diagnosed, including daily BLS quotas",async()=>{
 globalThis.fetch=(async()=>new Response(JSON.stringify({BEAAPI:{Results:{Error:{APIErrorDescription:"UserID is not active: private"}}}}))) as typeof fetch;
 await expect(checkedJson("https://apps.bea.gov/api/data/?UserID=private")).rejects.toThrow("rejected key");
 globalThis.fetch=(async()=>new Response(JSON.stringify({status:"REQUEST_NOT_PROCESSED",message:["daily threshold reached"]}))) as typeof fetch;
 await expect(checkedJson("https://api.bls.gov/publicAPI/v2/timeseries/data/")).rejects.toThrow("rate limit");expect((await accessGovernor().snapshot("BLS")).status).toBe("rate_limited");
});
test("successful JSON strips request echoes and reflected credentials before caching",async()=>{
 globalThis.fetch=(async()=>new Response(JSON.stringify({seriess:[{id:"UNRATE",title:"private_secret"}],request:{api_key:"private_secret"}}))) as typeof fetch;
 const data=await checkedJson("https://api.stlouisfed.org/fred/series?api_key=private_secret");expect(data.request).toBeUndefined();expect(JSON.stringify(data)).not.toContain("private_secret");
});
test("HTTP 400 invalid FRED keys are recognised without exposing the error body",async()=>{
 globalThis.fetch=(async()=>new Response(JSON.stringify({error_code:400,error_message:"api_key private_secret is not registered"}),{status:400})) as typeof fetch;
 await expect(providerFetch("https://api.stlouisfed.org/fred/series?api_key=private_secret")).rejects.toThrow("rejected key");expect((await accessGovernor().snapshot("FRED")).status).toBe("rejected_key");
});
test("corrupt persistent budget state fails closed instead of resetting quota",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"econstats-corrupt-budget-"));const first=new RequestGovernor(dir,{EIA:2});await first.reserve("EIA");
 const files=await readdir(join(dir,"access"));await writeFile(join(dir,"access",files.find(f=>f.endsWith('.json'))!),"broken");
 await expect(new RequestGovernor(dir,{EIA:2}).reserve("EIA")).rejects.toThrow("corrupt");
});
test("a persistent-cache hit retains remaining expiry when promoted to memory",async()=>{
 let savedTtl=0;
 const memory={get:async()=>null,set:async(_k:string,_v:any,ttl:number)=>{savedTtl=ttl;}};
 const disk={get:async()=>"cached",set:async()=>{},getEntry:async()=>({value:"cached",ttlSeconds:2})};
 const cache=new LayeredCache(memory,disk);expect(await cache.getOrCompute("data",1000,async()=>"new")).toBe("cached");expect(savedTtl).toBe(2);
});
