import {afterEach,beforeEach,expect,test} from 'bun:test';
import {comtradeUrl,validateComtradeData,parseComtradeData,fetchComtradeData,requestComtrade,comtradeReferences,comtradeProducts,comtradeAvailability,type ComtradeDataParams} from '../src/core/comtrade';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
import {fetchStructured} from '../src/core/structured-data';
import {RevisionTracker} from '../src/core/revisions';
import {providerFor,resetAccessState} from '../src/core/access';
import {connectionHealth} from '../src/core/health';
const originalFetch=globalThis.fetch,previousDisk=process.env.ECONSTATS_DISK_CACHE;
beforeEach(()=>{process.env.ECONSTATS_DISK_CACHE='false';resetAccessState();});
afterEach(()=>{globalThis.fetch=originalFetch;resetAccessState();if(previousDisk===undefined)delete process.env.ECONSTATS_DISK_CACHE;else process.env.ECONSTATS_DISK_CACHE=previousDisk;});
const at='2026-10-16T01:00:00.000Z';
const params=():ComtradeDataParams=>({reporter_code:36,partner_code:0,periods:['2023'],frequency:'A',classification:'HS',access_mode:'preview',product_codes:['8703'],flow_code:'X',fields:['primaryValue'],max_records:500});
// Synthetic fixtures model the official final-data field names; they are not observations.
const row=(extra:Record<string,unknown>={})=>({typeCode:'C',freqCode:'A',period:2023,reporterCode:36,reporterDesc:'Australia',partnerCode:0,partnerDesc:'World',partner2Code:0,classificationCode:'H6',cmdCode:'8703',cmdDesc:'Motor cars',flowCode:'X',customsCode:'C00',motCode:0,primaryValue:100,netWgt:null,qty:0,qtyUnitCode:5,qtyUnitAbbr:'u',isReported:true,isAggregate:false,isQtyEstimated:false,...extra});
const cache=()=>new LayeredCache(new MemoryCacheBackend());
const mock=(body:any,status=200)=>{globalThis.fetch=(async()=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})) as typeof fetch;};

test('Comtrade builds bounded credential-free exact queries and recognises its host',()=>{
 const p=params(),url=comtradeUrl('data',p,'2023');expect(providerFor(url)).toBe('COMTRADE');
 expect(url.pathname).toBe('/public/v1/preview/C/A/HS');expect(url.searchParams.get('partnerCode')).toBe('0');expect(url.searchParams.get('customsCode')).toBe('C00');expect(url.searchParams.get('cmdCode')).toBe('8703');expect(url.searchParams.has('subscription-key')).toBe(false);
 expect(comtradeUrl('availability',{...p,access_mode:'authenticated'},'2023').pathname).toBe('/data/v1/getDa/C/A/HS');
});
for(const [name,extra] of Object.entries({wildcard:{product_codes:['*']},aggregate:{product_codes:['AG2']},duplicates:{product_codes:['01','01']},badMonth:{frequency:'M',periods:['202313']},badAnnual:{periods:['202301']},future:{periods:['9999']},empty:{periods:[]},large:{periods:Array.from({length:13},(_,i)=>String(2000+i))},badReporter:{reporter_code:0},badPartner:{partner_code:-1},badFlow:{flow_code:'ALL'},badCap:{max_records:501},badFields:{fields:['unknown']},badClass:{classification:'S4'},badMode:{access_mode:'auto'}}))test(`Comtrade rejects ${name} locally`,()=>{expect(()=>validateComtradeData({...params(),...extra} as any)).toThrow();});
test('Comtrade preserves zero, missing values and estimation flags with native metric units',()=>{
 const p={...params(),fields:['primaryValue','netWgt','qty'] as ComtradeDataParams['fields']},r=parseComtradeData({count:1,data:[row({primaryValue:0,isQtyEstimated:true})]},p,comtradeUrl('data',p,'2023'),at);
 expect(r.schemaVersion).toBe('1.0');expect(r.coverage.truncated).toBe(true);expect(r.sourceUpdatedAt).toBeNull();
 expect(r.series.map(s=>s.unit)).toEqual(['USD','kg','u']);expect(r.series.map(s=>s.observations[0].value)).toEqual([0,null,0]);
 expect(r.series[2].observations[0].attributes.isQtyEstimated).toBe('true');expect(r.series[0].dimensions.classificationCode).toBe('H6');expect(r.series[0].labels.reporterCode).toBe('Australia');expect(r.series[0].id).toMatch(/^[a-f0-9]{64}$/);
});
for(const extra of [{reporterCode:156},{partnerCode:842},{partner2Code:1},{flowCode:'M'},{period:2022},{classificationCode:'S4'},{freqCode:'M'},{customsCode:'C01'},{motCode:1},{cmdCode:'TOTAL'},{classificationCode:null}])test(`Comtrade rejects unexpected returned identity ${JSON.stringify(extra)}`,()=>{const p=params();expect(()=>parseComtradeData({data:[row(extra)]},p,comtradeUrl('data',p,'2023'),at)).toThrow();});
test('Comtrade pins classification, separates edition changes and rejects conflicting duplicates',()=>{
 const p=params(),u=comtradeUrl('data',p,'2023'),r=parseComtradeData({data:[row(),row({classificationCode:'H5'})]},p,u,at);expect(r.series.length).toBe(2);
 expect(()=>parseComtradeData({data:[row({classificationCode:'H5'})]},{...p,classification:'H6'},u,at)).toThrow();
 expect(()=>parseComtradeData({data:[row(),row({primaryValue:101})]},p,u,at)).toThrow();
 expect(()=>parseComtradeData({data:[row({primaryValue:'not a number'})]},p,u,at)).toThrow();
});
test('Comtrade exposes empty, capped and upstream-incomplete coverage without fabricating zeroes',()=>{
 const p={...params(),access_mode:'authenticated' as const,max_records:1},u=comtradeUrl('data',p,'2023');
 expect(parseComtradeData({data:[]},p,u,at).series).toEqual([]);expect(parseComtradeData({count:8,data:[row()]},p,u,at).coverage.truncated).toBe(true);
 expect(()=>parseComtradeData({data:[row(),row()]},p,u,at)).toThrow();
});
test('Comtrade maps monthly periods and keeps quantity units distinct',()=>{
 const p={...params(),frequency:'M' as const,periods:['202301'],fields:['qty'] as ComtradeDataParams['fields']},u=comtradeUrl('data',p,'202301');
 const r=parseComtradeData({data:[row({period:202301,freqCode:'M'}),row({period:202301,freqCode:'M',qtyUnitCode:8,qtyUnitAbbr:'kg'})]},p,u,at);
 expect(r.series.length).toBe(2);expect(r.series[0].observations[0].period).toBe('2023-01');
 const missing=parseComtradeData({data:[row({period:202301,freqCode:'M',qtyUnitCode:-1,qtyUnitAbbr:'N/A'})]},p,u,at);expect(missing.series[0].unit).toBeNull();
});
test('Comtrade request headers authenticate without leaking keys, envelopes or URLs',async()=>{
 let captured:any;globalThis.fetch=(async(input:any,init:any)=>{captured={url:String(input),init};return new Response(JSON.stringify({data:[row()],request:{key:'secret-value'}}));}) as typeof fetch;
 const p={...params(),access_mode:'authenticated' as const},r=await fetchComtradeData(p,'secret-value');
 expect(captured.init.headers['Ocp-Apim-Subscription-Key']).toBe('secret-value');expect(captured.url).not.toContain('secret-value');expect(JSON.stringify(r)).not.toContain('secret-value');expect(JSON.stringify(r)).not.toContain('request');expect(r.coverage.truncated).toBe(false);
});
test('Comtrade missing credentials make no request; rejected auth never falls back to preview',async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response('private upstream message',{status:403});}) as typeof fetch;
 const p={...params(),access_mode:'authenticated' as const};await expect(fetchComtradeData(p)).rejects.toThrow('missing key');expect(calls).toBe(0);
 await expect(fetchComtradeData(p,'private-key')).rejects.toThrow('rejected key');expect(calls).toBe(1);
});
test('Comtrade 429 respects cooldown and discards raw error content',async()=>{
 let calls=0;globalThis.fetch=(async()=>{calls++;return new Response('private-key',{status:429,headers:{'Retry-After':'60'}});}) as typeof fetch;
 await expect(fetchComtradeData(params())).rejects.toThrow('rate limited');await expect(fetchComtradeData(params())).rejects.toThrow('cooldown');expect(calls).toBe(1);
});
test('Comtrade rejects non-JSON, error envelopes and unsupported URLs',async()=>{
 const u=comtradeUrl('data',params(),'2023');mock({error:'sensitive echo'});await expect(requestComtrade(u)).rejects.toThrow('error envelope');
 globalThis.fetch=(async()=>new Response('<html>unavailable</html>')) as typeof fetch;await expect(requestComtrade(u)).rejects.toThrow('Expected JSON');
 await expect(requestComtrade(new URL('https://example.com/data'))).rejects.toThrow('Unsupported');await expect(requestComtrade(new URL(String(u)+'&subscription-key=secret'))).rejects.toThrow('Unsupported');
});
test('Comtrade discovery searches and paginates native area and product metadata, preserving cached retrieval time',async()=>{
 const c=cache();mock({results:[{id:36,text:'Australia',reporterCodeIsoAlpha3:'AUS',entryEffectiveDate:'1900-01-01',isGroup:false,secret:'redacted'},{id:156,text:'China'}]});
 const a=await comtradeReferences(c,'reporters','AUS',0,1),b=await comtradeReferences(c,'reporters','AUS',0,1);expect(a.results[0].id).toBe(36);expect(a.results[0].isGroup).toBe(false);expect(a.retrievedAt).toBe(b.retrievedAt);expect(JSON.stringify(a)).not.toContain('redacted');
 mock({classCode:'H6',results:[{id:'8703',text:'Cars',parent:'87',aggrLevel:4},{id:'870310',text:'Cars snow',parent:'8703',aggrLevel:6}]});const p=await comtradeProducts(c,'H6','Cars',0,1);expect(p.hasMore).toBe(true);expect(p.results[0].parent).toBe('87');
 await expect(comtradeReferences(c,'reporters','',-1,10)).rejects.toThrow();await expect(comtradeProducts(c,'H6','',0,101)).rejects.toThrow();
});
test('Comtrade availability validates selection, preserves publication dates and removes request echoes',async()=>{
 mock({data:[{typeCode:'C',freqCode:'A',period:2023,reporterCode:36,classificationCode:'H6',publicationDate:'2024-03-01',key:'private-key'}]});
 const r=await comtradeAvailability(cache(),params());expect(r.partitions[0].records[0].publicationDate).toBe('2024-03-01');expect(JSON.stringify(r)).not.toContain('private-key');
 mock({data:[{typeCode:'C',freqCode:'A',period:2023,reporterCode:156}]});await expect(comtradeAvailability(cache(),params())).rejects.toThrow('Unexpected availability');
});
test('Comtrade multi-period retrieval combines exact series and fails atomically on a failed partition',async()=>{
 const p={...params(),periods:['2022','2023']};let calls=0;globalThis.fetch=(async(input:any)=>{calls++;const period=Number(new URL(input).searchParams.get('period'));return new Response(JSON.stringify({data:[row({period,primaryValue:period})]}));}) as typeof fetch;
 const r=await fetchComtradeData(p);expect(calls).toBe(2);expect(r.series.length).toBe(1);expect(r.series[0].observations.map(o=>o.period)).toEqual(['2022','2023']);expect(r.series[0].urls.length).toBe(2);
 calls=0;globalThis.fetch=(async()=>{calls++;return calls===1?new Response(JSON.stringify({data:[row({period:2022})]})):new Response('unavailable',{status:503});}) as typeof fetch;await expect(fetchComtradeData(p)).rejects.toThrow('unavailable');
});
test('Comtrade uses shared cache and fresh refresh, with observed numeric and flag revisions',async()=>{
 const c=cache(),request={tool:'comtrade_get_data',arguments:params()};let calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({data:[row({primaryValue:calls,isReported:calls===1})]}));}) as typeof fetch;
 const first=await fetchStructured(request,{},c),cached=await fetchStructured(request,{},c);expect(calls).toBe(1);expect(cached.retrievedAt).toBe(first.retrievedAt);
 const tracker=new RevisionTracker(undefined);await tracker.track({...first,retrievedAt:at});
 const fresh=await fetchStructured(request,{},c,true);expect(calls).toBe(2);const tracked=await tracker.track({...fresh,retrievedAt:'2026-10-16T02:00:00.000Z'});expect(tracked.series[0].revision?.changes).toHaveLength(1);
 expect(JSON.stringify(tracked.series[0].revision)).toContain('isReported');expect(JSON.stringify(await tracker.history(first.series[0].id,10))).toContain('2026-10-16');
});
test('Comtrade health distinguishes public availability from authenticated access without exposing credentials',async()=>{
 mock({data:[]});const p=await connectionHealth({},['COMTRADE'],true);expect(p.providers[0].keyConfigured).toBe(false);expect(p.providers[0].message).toContain('authenticated data access is not tested');
 const auth=await connectionHealth({COMTRADE_KEY:'private-key'},['COMTRADE'],true);expect(auth.providers[0].keyConfigured).toBe(true);expect(JSON.stringify(auth)).not.toContain('private-key');
});
test('Comtrade reports missing requested product cells separately from numeric null observations',async()=>{
 mock({data:[row()]});const r=await fetchComtradeData({...params(),product_codes:['8703','8704']});expect(r.coverage.requestedCells).toBe(2);expect(r.coverage.returnedCells).toBe(1);expect(r.coverage.missingCells).toEqual([{period:'2023',productCode:'8704'}]);expect(r.coverage.missingValues).toBe(0);
});
