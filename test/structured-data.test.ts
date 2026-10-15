import {afterEach,expect,test} from 'bun:test';
import {parseFredData,parseBlsData,parseBeaData,parseSdmxCsv,parseEurostatData,parseEiaData,parseWorldBankData,parseEcbData,fetchStructured} from '../src/core/structured-data';
import {finishResult,dataSeries,observation,renderResult,safeUrl} from '../src/core/result';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
import {worldBankUrl,ecbUrl} from '../src/core/legacy';
import {buildEiaDataUrl} from '../src/core/eia';
import type {SdmxDefinition} from '../src/core/abs';
const at='2026-10-15T20:00:00.000Z',url=new URL('https://example.org/data'),originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
function contract(r:any){expect(r.schemaVersion).toBe('1.0');expect(r.retrievedAt).toBe(at);expect(r.series[0].id).toMatch(/^[a-f0-9]{64}$/);expect(r.series[0].observations.map((o:any)=>o.value)).toEqual([0,-1,null]);expect(r.coverage.missingValues).toBe(1);expect(renderResult(r)).toContain('missing values retained as null');expect(JSON.parse(JSON.stringify(r))).toEqual(r);}
test('FRED structured results validate transformations and keep native definitions and missingness',()=>{
  const info={seriess:[{id:'TEST',units:'Index 2020=100',frequency:'Monthly',seasonal_adjustment:'Not Seasonally Adjusted'}]},data={units:'pc1',observations:[{date:'2026-01-01',value:'0'},{date:'2026-02-01',value:'-1'},{date:'2026-03-01',value:'.'}]},args={series_id:'TEST',units:'pc1',limit:3};
  const r=parseFredData(info,data,args,url,at);contract(r);expect(r.series[0].unit).toBe('percent');expect(r.series[0].transformation).toBe('yoy_percent_change');
  expect(()=>parseFredData(info,{...data,units:'lin'},args,url,at)).toThrow();expect(()=>parseFredData({seriess:[{id:'OTHER'}]},data,args,url,at)).toThrow();
});
test('BLS preserves reported levels, provider calculations and footnotes without relabelling levels as changes',()=>{
  const data={status:'REQUEST_SUCCEEDED',Results:{series:[{seriesID:'LNS14000000',catalog:{series_title:'Unemployment'},data:[{year:'2026',period:'M01',value:'0',calculations:{pct_changes:{'12':'10'}},footnotes:[{code:'P'}]},{year:'2026',period:'M02',value:'-1'},{year:'2026',period:'M03',value:'-'},{year:'2026',period:'M13',value:'100'}]}]}};
  const r=parseBlsData(data,{series_ids:['LNS14000000']},at);contract(r);expect(r.series[0].unit).toBeNull();expect(r.series[0].observations[0].attributes.calculations).toContain('10');expect(r.series[0].notes.join(' ')).toContain('M13');
});
test('BEA preserves all returned lines, geographical identities and row scaling',()=>{
  const rows=[0,-1,null].map((v,i)=>({TableName:'T10106',LineNumber:'1',LineDescription:'GDP',GeoFIPS:'US',TimePeriod:`2026Q${i+1}`,DataValue:v===null?'---':String(v),CL_UNIT:'Level',METRIC_NAME:'Chained Dollars',UNIT_MULT:'6'}));
  const r=parseBeaData({BEAAPI:{Results:{Data:rows,Notes:[{NoteText:'chained 2017 dollars'}]}}},{dataset:'NIPA',table_name:'T10106',frequency:'Q'},url,at);contract(r);expect(r.series[0].unitMultiplier).toBe(6);expect(r.series[0].notes).toContain('chained 2017 dollars');
  const multi=parseBeaData({BEAAPI:{Results:{Data:[...rows,...rows.map(r=>({...r,GeoFIPS:'AU'}))]}}},{dataset:'NIPA',table_name:'T10106',frequency:'Q'},url,at);expect(multi.series.length).toBe(2);
  expect(()=>parseBeaData({BEAAPI:{Results:{Data:[rows[0],{...rows[1],UNIT_MULT:'9'}]}}},{},url,at)).toThrow();
});
for(const source of ['IMF','OECD','BIS'] as const)test(`${source} structured SDMX parser uses DSD dimensions, retains flags and rejects unsolicited series`,()=>{
  const d:SdmxDefinition={id:'TEST',agency:source,version:'1.0',label:'Test',notes:[],attributeIds:[],dimensions:[{id:'FREQ',label:'Frequency',codes:[{code:'M',label:'Monthly'}]},{id:'AREA',label:'Area',codes:[{code:'AU',label:'Australia'}]}]};
  const csv=`DATAFLOW,FREQ,AREA,UNIT_MEASURE,UNIT_MULT,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n${source}:TEST(1.0),M,AU,PCT,0,2026-01,0,P\n${source}:TEST(1.0),M,AU,PCT,0,2026-02,-1,\n${source}:TEST(1.0),M,AU,PCT,0,2026-03,,M\n`;
  const r=parseSdmxCsv(source,csv,url,{},d,'M.AU',at,3);contract(r);expect(r.series[0].dimensions).toEqual({FREQ:'M',AREA:'AU'});expect(r.series[0].unitMultiplier).toBe(0);expect(r.series[0].observations[0].attributes.OBS_STATUS).toBe('P');
  expect(()=>parseSdmxCsv(source,csv.replace(',AU,',',US,'),url,{},d,'M.AU',at,3)).toThrow();expect(()=>parseSdmxCsv(source,csv.replace(',0,P',',garbage,P'),url,{},d,'M.AU',at,3)).toThrow();
});
test('Eurostat structured parser decodes time-first sparse grids without fabricating zeroes',()=>{
  const p={datasetId:'test',filters:{freq:['M'],geo:['AU']},limit:3};
  const data={version:'2.0',class:'dataset',id:['time','freq','geo'],size:[3,1,1],dimension:{time:{category:{index:{'2026-01':0,'2026-02':1,'2026-03':2}}},freq:{category:{index:{M:0}}},geo:{category:{index:{AU:0}}}},value:{0:0,1:-1},status:{0:'P',2:'M'}};
  const r=parseEurostatData(data,url,p,at);contract(r);expect(r.series[0].observations[2].attributes.STATUS).toBe('M');
});
test('EIA structured values retain page incompleteness, facets, units and missingness',()=>{
  const p={route:'electricity/retail-sales',frequency:'monthly',fields:['price'],facets:{stateid:['US'],sectorid:['RES']},length:3,offset:0},meta={frequency:[{id:'monthly'}],facets:[{id:'stateid'},{id:'sectorid'}],data:{price:{units:'cents per kilowatt-hour'}}};
  const data={frequency:'monthly',total:10,data:[0,-1,null].map((v,i)=>({stateid:'US',sectorid:'RES',period:`2026-0${i+1}`,price:v,'price-units':'cents per kilowatt-hour'}))};
  const r=parseEiaData(data,buildEiaDataUrl(p),p,meta,at);contract(r);expect(r.coverage.truncated).toBe(true);expect(r.series[0].unit).toBe('cents per kilowatt-hour');expect(r.series[0].dimensions.sectorid).toBe('RES');
});
test('World Bank structured data retain country, source update and all-page provenance',()=>{
  const p={countryCodes:['AU'],indicator:'SP.POP.TOTL',startYear:2020,endYear:2022},rows=[0,-1,null].map((v,i)=>({countryiso3code:'AUS',country:{id:'AU',value:'Australia'},indicator:{id:p.indicator},date:String(2020+i),value:v}));
  const r=parseWorldBankData({rows,pages:1,updated:'2026-10-01'},{id:p.indicator,name:'Population',unit:'persons'},worldBankUrl(p),p,at);contract(r);expect(r.sourceUpdatedAt).toBe('2026-10-01');
});
test('ECB structured data decode series/observation attributes and scaling',()=>{
  const p={flowRef:'FM',key:'M.AU'},data={structure:{dimensions:{series:[{id:'FREQ',values:[{id:'M'}]},{id:'AREA',values:[{id:'AU'}]}],observation:[{id:'TIME_PERIOD',values:[{id:'2026-01'},{id:'2026-02'},{id:'2026-03'}]}]},attributes:{series:[{id:'UNIT',values:[{id:'PC'}]},{id:'UNIT_MULT',values:[{id:'0'}]}],observation:[{id:'OBS_STATUS',values:[{id:'P'}]}]}},dataSets:[{series:{'0:0':{attributes:[0,0],observations:{0:[0,0],1:[-1],2:[null]}}}}]};
  const r=parseEcbData(data,ecbUrl(p),p,at);contract(r);expect(r.series[0].attributes.UNIT_MULT).toBe('0');expect(r.series[0].observations[0].attributes.OBS_STATUS).toBe('P');
});
test('common results reject conflicting duplicates, bad dates and credential-bearing citations',()=>{
  for(const key of ['api_key','UserID','subscription-key','access_token'])expect(()=>safeUrl(`https://example.org/?${key}=secret`)).toThrow();
  expect(()=>observation('2026-02-30',1)).toThrow();
  expect(()=>finishResult('ABS',{},[dataSeries('test',{},url,{observations:[observation('2026-01',1),observation('2026-01',2)]})],at)).toThrow();
});
test('explicit refresh replaces the observation cache; invalid results are never cached',async()=>{
  let calls=0,bad=true;globalThis.fetch=(async input=>{calls++;return new Response(JSON.stringify(String(input).includes('/observations')?{units:'lin',observations:[{date:'2026-01-01',value:bad?'bad':String(calls)}]}:{seriess:[{id:'TEST',units:'Percent'}]}));}) as typeof fetch;
  const cache=new LayeredCache(new MemoryCacheBackend()),r={tool:'fred_get_series',arguments:{series_id:'TEST',units:'lin',limit:1}},keys={FRED_KEY:'private_secret'};
  await expect(fetchStructured(r,keys,cache)).rejects.toThrow();bad=false;const first=await fetchStructured(r,keys,cache);expect(calls).toBe(4);const fresh=await fetchStructured(r,keys,cache,true);expect(calls).toBe(6);expect(fresh.series[0].observations[0].value).not.toBe(first.series[0].observations[0].value);expect(await fetchStructured(r,keys,cache)).toEqual(fresh);expect(calls).toBe(6);expect(JSON.stringify(fresh)).not.toContain('private_secret');
});
test('unsupported BEA datasets fail before sending misleading parameters',async()=>{
  let calls=0;globalThis.fetch=(async()=>{calls++;throw Error('unexpected');}) as unknown as typeof fetch;
  await expect(fetchStructured({tool:'bea_get_data',arguments:{dataset:'Regional',table_name:'SAGDP2N',frequency:'A',year:'2025'}},{BEA_KEY:'private_secret'},new LayeredCache(new MemoryCacheBackend()))).rejects.toThrow('not supported');expect(calls).toBe(0);
});
