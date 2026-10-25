import {afterEach,expect,test} from 'bun:test';
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
import {EconStatsCoreClient} from '../src/core/client';
import {OecdParser} from '../src/core/oecd-parse-client';
import {withRequestContext,cancellation} from '../src/core/request-context';

const dir=new URL('./fixtures/oecd-government/',import.meta.url);
const xml=gunzipSync(readFileSync(new URL('structure.xml.gz',dir))).toString();
const csv=readFileSync(new URL('observations.csv',dir),'utf8');
const dataset_id='OECD.GOV.GIP,DSD_GOV@DF_GOV_PF_YU';
const request={tool:'oecd_get_data',arguments:{dataset_id,version:'1.0',series_key:'A.FRA+AUS+USA.GE.PT_B1GQ.S13.YU.PF',start_period:'2007',end_period:'2024',limit:100}};
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});

test('real OECD structure discovery and concurrent data requests share one compact parsed definition',async()=>{
  let metadata=0,data=0;const persisted:any[]=[];
  globalThis.fetch=(async input=>{const u=new URL(String(input));
    if(u.pathname.includes('/dataflow/')){metadata++;return new Response(xml);}
    data++;expect(u.pathname).toContain(',1.0/');return new Response(csv);
  }) as typeof fetch;
  const l2=new MemoryCacheBackend(),cache=new LayeredCache(new MemoryCacheBackend(),{
    get:k=>l2.get(k),set:async(k,v,ttl)=>{persisted.push({key:k,value:v});await l2.set(k,v,ttl);},
  });
  const client=new EconStatsCoreClient({},cache);
  const [structure,first,second]=await Promise.all([
    client.oecdGetStructure(dataset_id,'1.0','REF_AREA','United States'),
    client.getStructuredData(request),client.getStructuredData(request),
  ]);
  expect(structure).toContain('USA=United States');expect(metadata).toBe(1);expect(data).toBe(1);
  expect(first.coverage).toMatchObject({returnedSeries:3,returnedObservations:54,missingValues:0,truncated:false});
  expect(Object.fromEntries(first.series.map(s=>[s.dimensions.REF_AREA,s.observations.at(-1)!.value]))).toEqual({AUS:39.636,FRA:57.286,USA:39.566});
  expect(second.series.map(s=>s.observations)).toEqual(first.series.map(s=>s.observations));
  const definitions=persisted.filter(x=>x.key.startsWith('oecd:definition:'));
  expect(definitions).toHaveLength(1);expect(definitions[0].value.dimensions).toHaveLength(7);
  expect(JSON.stringify(definitions[0].value).length).toBeLessThan(xml.length/3);
  expect(persisted.some(x=>typeof x.value==='string'&&x.value.includes('<message:Structure'))).toBe(false);
  await client.getStructuredData(request);expect(metadata).toBe(1);expect(data).toBe(1);
},10000);

test('invalid metadata is not cached; the same query recovers on a valid response',async()=>{
  let calls=0;
  globalThis.fetch=(async input=>new Response(new URL(String(input)).pathname.includes('/dataflow/')?
    (++calls===1?xml.slice(0,-100):xml):csv)) as typeof fetch;
  const client=new EconStatsCoreClient({});
  expect(await client.oecdGetStructure(dataset_id,'1.0')).toContain('invalid or incomplete');
  expect(await client.oecdGetStructure(dataset_id,'1.0')).toContain('dimension order: FREQ.REF_AREA');
  expect(calls).toBe(2);
});

test('parser cancellation kills the OS process and a subsequent parse recovers',async()=>{
  const parser=new OecdParser(),controller=new AbortController();
  const pending=parser.parse({kind:'definition',xml,datasetId:dataset_id,version:'1.0'},controller.signal);
  expect(parser.stats().active).toBe(true);controller.abort(cancellation('deadline'));
  await expect(pending).rejects.toMatchObject({name:'TimeoutError'});
  for(let i=0;i<100&&parser.stats().active;i++)await Bun.sleep(5);
  expect(parser.stats()).toEqual({active:false,queued:0,inputBytes:0});
  const good=await parser.parse({kind:'definition',xml,datasetId:dataset_id,version:'1.0'});
  expect((good as any).dimensions).toHaveLength(7);
});

test('parser queue and byte limits reject excess work without blocking health/event-loop timers',async()=>{
  const parser=new OecdParser(1,4*1024*1024),controller=new AbortController();
  const first=parser.parse({kind:'definition',xml,datasetId:dataset_id,version:'1.0'},controller.signal);
  await expect(parser.parse({kind:'definition',xml,datasetId:dataset_id,version:'1.0'})).rejects.toThrow('capacity');
  await Bun.sleep(1);controller.abort(cancellation('client_closed'));
  await expect(first).rejects.toMatchObject({name:'AbortError'});
});

test('metadata parser failures never expose provider content in their errors',async()=>{
  const parser=new OecdParser();
  await expect(parser.parse({kind:'definition',xml:'<invalid>private_provider_value',datasetId:dataset_id})).rejects.toThrow('invalid or incomplete');
  try{await parser.parse({kind:'definition',xml:'<!DOCTYPE private_provider_value><x/>',datasetId:dataset_id});}
  catch(error){expect(String(error)).not.toContain('private_provider_value');}
});
