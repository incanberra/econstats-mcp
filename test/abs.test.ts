import {afterEach,expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ABS_CATALOG_URL,absCatalogue,absStructure,buildAbsDataUrl,buildAbsStructureUrl,sdmxDefinition,parseAbsCsv,validateSdmxKey} from '../src/core/abs';
import {parseAbsEvidence} from '../src/core/selection-data';
import {rankSources,selectSource} from '../src/core/selection';
import {fetchStructured} from '../src/core/structured-data';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
const fixture=(f:string)=>readFile(join(import.meta.dir,'fixtures','abs',f),'utf8');
const cases=[['ANA_AGG','M1.GPM.20.AUS.Q'],['ANA_AGG','M2.GPM.20.AUS.Q'],['CPI','3.10001.10.50.M'],['LF','M13.3.1599.20.AUS.M'],['ITGS','M1.1000+2000.20.AUS.M']];
const at='2026-10-15T20:00:00.000Z',originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
for(const [id,key] of cases)test(`official ABS fixture ${id}/${key} preserves native data and provenance`,async()=>{
  const xml=await fixture(id+'-structure.xml'),def=sdmxDefinition(xml,id,'ABS'),p={datasetId:id,seriesKey:key,limit:4};
  validateSdmxKey(def,key);const url=buildAbsDataUrl({...p,version:def.version});
  const result=parseAbsCsv(await fixture(id+'-'+key.replaceAll('+','_')+'.csv'),url,p,def,at);
  expect(result.source).toBe('ABS');expect(result.retrievedAt).toBe(at);expect(result.series.length).toBe(id==='ITGS'?2:1);expect(result.series[0].observations.length).toBe(4);expect(result.series[0].labels.MEASURE).toBeTruthy();
  expect(result.series[0].urls[0]).toContain(`ABS,${id},${def.version}`);expect(result.coverage.truncated).toBe(false);
  if(id==='ITGS'){expect(result.series.find(s=>s.dimensions.DATA_ITEM==='2000')!.observations.every(o=>o.value!<0)).toBe(true);expect(result.series.find(s=>s.dimensions.DATA_ITEM==='1000')!.observations.every(o=>o.value!>0)).toBe(true);}
});
test('ABS structures paginate code labels and resolve current versions',async()=>{
  const xml=await fixture('CPI-structure.xml'),def=sdmxDefinition(xml,'CPI','ABS');expect(def.version).toBe('2.0.0');expect(def.dimensions.map(d=>d.id)).toEqual(['MEASURE','INDEX','TSEST','REGION','FREQ']);
  const codes=absStructure(xml,'CPI',undefined,'INDEX','',1,2);expect(codes.dimensions[0].codes.length).toBe(2);expect(codes.dimensions[0].offset).toBe(1);expect(codes.dimensions[0].totalCodes).toBeGreaterThan(100);
  expect(absCatalogue(xml,'consumer price').datasets[0].id).toBe('CPI');expect(ABS_CATALOG_URL).toContain('/dataflow/ABS/');
});
test('ABS rejects unsafe, broad and reversed queries before fetching',()=>{
  for(const change of [{datasetId:'../x'},{version:'https://evil'},{seriesKey:'M1..20.AUS.Q'},{seriesKey:'*'},{seriesKey:'M1.GPM.20.AUS.Q?key=x'},{limit:0},{limit:121},{startPeriod:'2026-13'},{startPeriod:'2026-Q4',endPeriod:'2025-Q1'},{seriesKey:Array.from({length:51},(_,i)=>i).join('+')}])expect(()=>buildAbsDataUrl({datasetId:'ANA_AGG',seriesKey:'M1.GPM.20.AUS.Q',...change} as any)).toThrow();
  expect(()=>buildAbsStructureUrl('https://evil')).toThrow();
});
test('ABS rejects unexpected series, dataflow, conflicting values and changing scaling',async()=>{
  const xml=await fixture('ANA_AGG-structure.xml'),def=sdmxDefinition(xml,'ANA_AGG','ABS'),p={datasetId:'ANA_AGG',seriesKey:'M1.GPM.20.AUS.Q',limit:4},url=buildAbsDataUrl(p),csv=await fixture('ANA_AGG-M1.GPM.20.AUS.Q.csv');
  expect(()=>validateSdmxKey(def,'M1.unknown.20.AUS.Q')).toThrow();
  for(const text of [csv.replace('ABS:ANA_AGG','ABS:WRONG'),csv.replace(',AUS,',',US,'),csv+csv.split('\n')[1].replace(',699461,',',1,')+'\n',csv.replace(',6,',',9,')])expect(()=>parseAbsCsv(text,url,p,def,at)).toThrow();
  expect(()=>parseAbsCsv(csv.replace(',699461,',',bad,'),url,p,def,at)).toThrow();
});
test('ABS null, zero, negative values and status flags remain separate',async()=>{
  const def=sdmxDefinition(await fixture('ANA_AGG-structure.xml'),'ANA_AGG','ABS'),p={datasetId:'ANA_AGG',seriesKey:'M1.GPM.20.AUS.Q',limit:4};
  const csv=(await fixture('ANA_AGG-M1.GPM.20.AUS.Q.csv')).replace(',699461,',',0,').replace(',696539,',',-1,').replace(',694551,',',,').replace(',6,,',',6,P,');
  const r=parseAbsCsv(csv,buildAbsDataUrl(p),p,def,at);expect(r.series[0].observations.map(o=>o.value)).toEqual([688271,null,-1,0]);expect(r.coverage.missingValues).toBe(1);expect(r.series[0].observations.at(-1)!.attributes.OBS_STATUS).toBe('P');
});
for(const [id,key,measure] of [['CPI','3.10001.10.50.M','headline_cpi_yoy'],['LF','M13.3.1599.20.AUS.M','unemployment_rate'],['ANA_AGG','M2.GPM.20.AUS.Q','real_gdp_growth_qoq']])test(`ABS verifies exact ${measure} without changing conventions`,async()=>{
  const def=sdmxDefinition(await fixture(id+'-structure.xml'),id,'ABS'),p={datasetId:id,seriesKey:key,limit:4},r=parseAbsCsv(await fixture(id+'-'+key+'.csv'),buildAbsDataUrl(p),p,def,at),e=parseAbsEvidence(r,def);
  expect(e.measure).toBe(measure);expect(e.country).toBe('AUS');expect(e.unitMultiplier).toBe(0);expect(e.adjustment).toBe(measure==='headline_cpi_yoy'?'NSA':'SA');
  const ranked=rankSources({measure:measure as any,countries:['AU'],observations:4});expect(ranked.candidates[0].source).toBe('ABS');
  const selected=await selectSource({measure:measure as any,countries:['AU'],observations:4,preferredSource:'ABS'}, {}, async r=>{if(r.tool!=='abs_get_data')throw Error('not mocked');return e;},new Date('2026-10-16'));expect(selected.status).toBe('verified_recommendation');
  expect(()=>parseAbsEvidence({...r,series:[{...r.series[0],unit:'AUD'}]},def)).toThrow();
});
test('ABS metadata is checked before data; failures are not cached and cached provenance stays original',async()=>{
  const xml=await fixture('LF-structure.xml'),csv=await fixture('LF-M13.3.1599.20.AUS.M.csv');let count=0;
  globalThis.fetch=(async input=>{count++;return new Response(String(input).includes('/dataflow/')?xml:csv);}) as typeof fetch;
  const cache=new LayeredCache(new MemoryCacheBackend()),r={tool:'abs_get_data',arguments:{dataset_id:'LF',series_key:'M13.3.1599.20.AUS.M',limit:4}};
  const first=await fetchStructured(r,{},cache);expect(count).toBe(2);const second=await fetchStructured(r,{},cache);expect(count).toBe(2);expect(second.retrievedAt).toBe(first.retrievedAt);
  await expect(fetchStructured({...r,arguments:{...r.arguments,series_key:'INVALID.3.1599.20.AUS.M'}},{},cache)).rejects.toThrow();expect(count).toBe(2);
  await fetchStructured(r,{},cache,true);expect(count).toBe(3);
});
