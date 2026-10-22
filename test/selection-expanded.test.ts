import {expect,test} from 'bun:test';
import {normaliseSelection,rankSources,selectSource,type SelectionParams} from '../src/core/selection';
import {dateRetrieval} from '../src/core/selection-periods';
import type {SeriesEvidence} from '../src/core/evidence';
const now=new Date('2026-10-23T00:00:00Z');
const cpi:SelectionParams={measure:'headline_cpi_yoy',countries:['US','GB'],observations:2};
const evidence=async(r:any):Promise<SeriesEvidence>=>({source:r.tool.split('_')[0].toUpperCase(),measure:'headline_cpi_yoy',country:r.arguments.series_key?.startsWith('GBR')?'GBR':'USA',frequency:'monthly',unit:'percent',unitMultiplier:0,adjustment:'NSA',transformation:'yoy_percent_change',dimensions:{},observations:r.tool==='oecd_get_data'?[{period:'2026-06',value:1},{period:'2026-07',value:2}]:[{period:'2026-07',value:2},{period:'2026-08',value:3}],urls:['https://example.org/data'],retrievedAt:'2026-10-01T00:00:00Z',notes:[]});
const never=async():Promise<SeriesEvidence>=>{throw new Error('Discovery plans must not call an evidence adapter');};
test('comparison prefers suitability; latest prefers freshness; explicit preference remains binding',async()=>{
 expect((await selectSource({...cpi,purpose:'comparison'},{},evidence,now)).selected.source).toBe('OECD');
 expect((await selectSource({...cpi,purpose:'latest'},{},evidence,now)).selected.source).toBe('IMF');
 expect((await selectSource({...cpi,purpose:'comparison',preferredSource:'IMF'},{},evidence,now)).selected.source).toBe('IMF');
 expect((await selectSource({...cpi,purpose:'comparison',maxAgeDays:60},{},evidence,now)).selected.source).toBe('IMF');
});
test('release prefers the original producer even when a redistributor has newer observations',async()=>{
 const p={...cpi,countries:['US'],purpose:'release'} as SelectionParams;
 const probe=async(r:any)=>{const e=await evidence(r);if(r.tool==='bls_get_series')e.observations=[{period:'2026-05',value:1},{period:'2026-06',value:2}];return e;};
 expect((await selectSource(p,{FRED:true},probe,now)).selected.source).toBe('BLS');
 const failed=await selectSource(p,{FRED:true},async r=>{if(r.tool==='bls_get_series')throw new Error('unavailable');return probe(r);},now);
 expect(failed.selected.source).not.toBe('BLS');expect(failed.candidates.find(c=>c.source==='BLS')!.verification.status).toBe('lookup_failed');
});
test('trade route retains dimensions and does not claim unqueried data are verified',async()=>{
 const p:SelectionParams={measure:'merchandise_exports_value',countries:['CN'],partnerCountries:['US'],productCodes:['8703'],classification:'H6',startPeriod:'2020',endPeriod:'2025'};
 const r=await selectSource(p,{COMTRADE:true},never,now);
 expect(r.status).toBe('discovery_required');expect(r.selected).toBeNull();expect(r.recommendedSource).toBe('COMTRADE');
 expect(r.request.partnerCountries).toEqual(['USA']);expect(r.request.startPeriod).toBe('2020');
 expect(r.discovery).toContainEqual({tool:'comtrade_list_reference',arguments:{reference:'reporters',query:'CHN'}});
 expect(r.discovery).toContainEqual({tool:'comtrade_search_products',arguments:{query:'8703',classification:'H6'}});
 expect(r.requirements.join(' ')).toContain('primaryValue');
 expect((await selectSource(p,{},never,now)).status).toBe('source_unavailable');
 expect((await selectSource({...p,preferredSource:'OECD'},{COMTRADE:true},never,now)).recommendedSource).toBeNull();
});
test('TiVA route preserves origin/destination, industry and historical dates',async()=>{
 const r=await selectSource({measure:'foreign_value_added_in_final_demand',countries:['AU'],partnerCountries:['CN'],industryQuery:'manufacturing',startPeriod:'2000',endPeriod:'2022'},{},never,now);
 expect(r.recommendedSource).toBe('OECD');expect(r.discovery).toEqual([{tool:'oecd_list_datasets',arguments:{query:'TiVA',space:'sti-public'}}]);
 expect(r.requirements.join(' ')).toContain('final-demand destination');expect(r.request.industryQuery).toBe('manufacturing');expect(r.selected).toBeNull();
});
test('agriculture checks installed snapshots and native code dimensions',async()=>{
 const r=await selectSource({measure:'agricultural_production',countries:['AU'],productQuery:'wheat',startPeriod:'2000',endPeriod:'2025'},{},never,now);
 expect(r.recommendedSource).toBe('FAOSTAT');expect(r.discovery[0].tool).toBe('faostat_list_domains');
 expect(r.discovery).toContainEqual({tool:'faostat_list_codes',arguments:{domain:'QCL',dimension:'item',query:'wheat'}});
 expect(r.requirements.join(' ')).toContain('snapshot date');
});
test('shipping supports named chokepoints without inventing a country or native location ID',async()=>{
 const r=await selectSource({measure:'chokepoint_capacity',countries:[],locationQuery:'Suez',startPeriod:'2025-01-01',endPeriod:'2025-12-31'},{},never,now);
 expect(r.recommendedSource).toBe('PORTWATCH');expect(r.request.frequency).toBe('daily');
 expect(r.discovery[1]).toEqual({tool:'portwatch_list_locations',arguments:{dataset:'chokepoints',query:'Suez'}});
 expect(r.requirements.join(' ')).toContain('not actual cargo tonnage');
});
test('mixed-country GDP gaps produce usable discovery steps, not an empty registry dead end',async()=>{
 const r=await selectSource({measure:'real_gdp_growth_qoq',countries:['AU','US','FR'],verify:false},{},never,now);
 expect(r.status).toBe('discovery_required');expect(r.recommendedSource).toBe('OECD');expect(r.discovery[0].arguments.query).toBe('GDP');
});
test('bounded historical requests require all requested periods by default and exclude outside observations',async()=>{
 const p:SelectionParams={measure:'headline_cpi_yoy',countries:['US','GB'],startPeriod:'2020-01',endPeriod:'2020-03'};
 const values=[{period:'2019-12',value:1},{period:'2020-01',value:1},{period:'2020-02',value:2},{period:'2020-03',value:3},{period:'2026-08',value:99}];
 const r=await selectSource(p,{},async q=>({...await evidence(q),observations:values}),now);
 expect(r.selected.verification.commonPeriods).toEqual(['2020-01','2020-02','2020-03']);
 const missing=await selectSource(p,{},async q=>({...await evidence(q),observations:values.filter(x=>x.period!=='2020-02')}),now);
 expect(missing.selected).toBeNull();expect(missing.candidates[0].verification.missingPeriods).toEqual(['2020-02']);
});
test('date normalisation, range limits and incompatible dimension filters fail explicitly',()=>{
 expect(normaliseSelection({measure:'real_gdp_growth_qoq',countries:['AU'],startPeriod:'2020',endPeriod:'2021'}).requiredPeriods).toHaveLength(8);
 for(const p of [
  {...cpi,startPeriod:'2025',endPeriod:'2020'}, {...cpi,startPeriod:'2020-02-30'},
  {measure:'population',countries:['AU'],startPeriod:'1900',endPeriod:'2025'},
  {measure:'agricultural_production',countries:['AU'],frequency:'monthly'},
  {...cpi,productQuery:'wheat'}, {...cpi,preferredSource:'UNKNOWN'},
  {measure:'chokepoint_capacity',countries:[],locationType:'ports'},
 ] as SelectionParams[])expect(()=>normaliseSelection(p)).toThrow();
});
test('date ranges reach every registered macro request in its provider convention',()=>{
 const requests=[
  ['FRED',{tool:'fred_get_series',arguments:{limit:2}},'start_period','2020-01-01','end_period','2020-12-31'],
  ['BLS',{tool:'bls_get_series',arguments:{}},'start_year','2019','end_year','2020'],
  ['BEA',{tool:'bea_get_data',arguments:{}},'year','2020','year','2020'],
  ['WORLD_BANK',{tool:'worldbank_get_data',arguments:{}},'start_year',2020,'end_year',2020],
 ] as const;
 for(const [,request,startKey,startValue,endKey,endValue] of requests){const r=dateRetrieval(request,'2020','2020',12);expect(r.arguments[startKey]).toBe(startValue);expect(r.arguments[endKey]).toBe(endValue);}
 for(const tool of ['oecd_get_data','imf_get_data','abs_get_data','bis_get_data','eurostat_get_data','eia_get_data','ecb_get_data']){
  const r=dateRetrieval({tool,arguments:{start_period:'2025'}},'2020-01','2020-12',12);
  expect(r.arguments.start_period).toBe('2020-01');expect(r.arguments.end_period).toBe('2020-12');
  expect(dateRetrieval({tool,arguments:{start_period:'2025'}},undefined,'2020',12).arguments.start_period).toBeUndefined();
 }
 const r=rankSources({...cpi,startPeriod:'2020-01',endPeriod:'2020-02'});
 expect(r.candidates.every(c=>c.requests.every(q=>q.arguments.start_period==='2020-01'))).toBe(true);
});
