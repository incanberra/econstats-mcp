import {afterEach,expect,test} from 'bun:test';
import {buildPortwatchDataUrl,parsePortwatch,portwatchLocations,portwatchMetadata,validatePortwatch,type PortwatchParams} from '../src/core/portwatch';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
import {resetAccessState} from '../src/core/access';
const original=globalThis.fetch;afterEach(()=>{globalThis.fetch=original;resetAccessState();});
const params:PortwatchParams={dataset:'chokepoints',location_ids:['chokepoint1'],fields:['n_total','capacity'],start_date:'2024-01-01',end_date:'2024-01-03',limit:10};
test('PortWatch bounds exact IDs, fields and calendar dates before requests',()=>{
  const url=buildPortwatchDataUrl(params);expect(url.searchParams.get('where')).toContain("portid IN ('chokepoint1')");expect(url.searchParams.get('resultRecordCount')).toBe('10');
  for(const bad of [{location_ids:["chokepoint1' OR 1=1"]},{location_ids:['port1']},{fields:['unknown']},{start_date:'2024-02-30'},{end_date:'2026-01-01'},{start_date:'2025-01-01'},{limit:2001}])expect(()=>validatePortwatch({...params,...bad})).toThrow();
});
test('PortWatch retains nulls, distinguishes capacity from cargo, validates selections and discloses truncation',()=>{
  const body={features:[{attributes:{portid:'chokepoint1',portname:'Suez Canal',date:'2024-01-01',n_total:0,capacity:null}},{attributes:{portid:'chokepoint1',portname:'Suez Canal',date:Date.parse('2024-01-03'),n_total:5,capacity:2345}}],exceededTransferLimit:true};
  const r=parsePortwatch(body,params,buildPortwatchDataUrl(params),'2026-10-20T00:00:00Z',null);
  expect(r.series).toHaveLength(2);expect(r.coverage.truncated).toBe(true);expect(r.series[0].unit).toBe('vessel calls');expect(r.series[0].observations.map(o=>o.value)).toEqual([0,5]);expect(r.series[1].unit).toBe('metric tonnes');expect(r.series[1].notes.join(' ')).toContain('not measured cargo');expect(r.coverage.missingValues).toBe(1);
  expect(()=>parsePortwatch({features:[{attributes:{...body.features[0].attributes,portid:'chokepoint2'}}]},params,buildPortwatchDataUrl(params),'2026-10-20T00:00:00Z',null)).toThrow('Unrequested');
  expect(()=>parsePortwatch({features:[{attributes:{...body.features[0].attributes,n_total:'bad'}}]},params,buildPortwatchDataUrl(params),'2026-10-20T00:00:00Z',null)).toThrow('value');
});
test('PortWatch discovery refuses incomplete catalogues and caches usable metadata',async()=>{
  const cache=new LayeredCache(new MemoryCacheBackend());let calls=0;
  globalThis.fetch=(async()=>{calls++;return Response.json({fields:[{name:'date'},{name:'n_total'}],editingInfo:{dataLastEditDate:Date.parse('2026-10-19')}});}) as typeof fetch;
  expect((await portwatchMetadata(cache,'chokepoints')).fields.map(f=>f.field)).toEqual(['n_total']);await portwatchMetadata(cache,'chokepoints');expect(calls).toBe(1);
  globalThis.fetch=(async()=>Response.json({features:[],exceededTransferLimit:true})) as typeof fetch;
  await expect(portwatchLocations(cache,'ports')).rejects.toThrow('Incomplete');
});
