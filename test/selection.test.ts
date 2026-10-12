import {describe,expect,test} from 'bun:test';
import {normaliseSelection,rankSources,selectSource,type SelectionParams,type Source} from '../src/core/selection';
import {canonicalPeriod,finishEvidence,type SeriesEvidence} from '../src/core/evidence';
import {AccessError} from '../src/core/access';
const base:SelectionParams={measure:'headline_cpi_yoy',countries:['US','GB'],observations:2};
const now=new Date('2026-10-12T00:00:00Z');
const probe=async(r:any):Promise<SeriesEvidence>=>({source:r.tool.split('_')[0].toUpperCase() as Source,measure:'headline_cpi_yoy',country:r.arguments.series_key?.startsWith('GBR')?'GBR':'USA',frequency:'monthly',unit:'percent',unitMultiplier:0,adjustment:'NSA',transformation:'yoy_percent_change',dimensions:{},observations:[{period:'2026-M07',value:2},{period:'2026-M08',value:3}],urls:['https://example.org/data'],retrievedAt:'2026-10-10T00:00:00Z',notes:[]});

describe('source-selection policy',()=>{
 test('normalises countries and rejects unknown codes',()=>{
  expect(normaliseSelection(base).countries).toEqual(['USA','GBR']);
  expect(()=>normaliseSelection({...base,countries:['UK']})).toThrow('Unknown country');
  expect(()=>normaliseSelection({...base,countries:[]})).toThrow();
 });
 test('matches exact definitions without substituting inflation measures',()=>{
  expect(rankSources(base).candidates[0].source).toBe('OECD');
  expect(rankSources({...base,measure:'hicp_yoy',countries:['DE','FR']}).candidates.map(c=>c.source)).toEqual(['EUROSTAT']);
  expect(rankSources({...base,measure:'cpih_yoy',countries:['GB']}).candidates).toEqual([]);
  expect(rankSources({...base,frequency:'daily'}).candidates).toEqual([]);
 });
 test('GDP levels default to quarterly and explicit monthly requests are not silently changed',()=>{
  const p={...base,measure:'real_gdp_level',countries:['US']} as SelectionParams;
  expect(normaliseSelection(p).frequency).toBe('quarterly');
  expect(rankSources(p,{BEA:true,FRED:true}).candidates.map(c=>c.source)).toEqual(['BEA','FRED']);
  expect(rankSources({...p,frequency:'monthly'},{BEA:true}).candidates).toEqual([]);
 });
 test('GDP growth conventions remain distinct',()=>{
  expect(rankSources({...base,measure:'real_gdp_growth_qoq',countries:['US']}).candidates).toEqual([]);
  expect(rankSources({...base,measure:'real_gdp_growth_annualized',countries:['US']},{BEA:true}).candidates[0].requests[0].arguments.table_name).toBe('T10101');
 });
 test('uses the current Eurostat total-age code with a specific unemployment definition',()=>{
  const c=rankSources({...base,measure:'unemployment_rate',countries:['DE','FR']}).candidates[0];
  expect(c.requests[0].arguments.filters.age).toEqual(['TOTAL']);expect(c.definition).toContain('15–74');
 });
 test('US CPI release-day selection preserves the NSA series and year-on-year transform',()=>{
  const c=rankSources({...base,countries:['US'],purpose:'release'},{FRED:true}).candidates;
  expect(c[0].source).toBe('BLS');expect(c[0].requests[0].arguments.series_ids).toEqual(['CUUR0000SA0']);
  expect(c.find(c=>c.source==='FRED')!.requests[0].arguments.units).toBe('pc1');
 });
 test('preserves sector, real/nominal and valuation distinctions',()=>{
  expect(rankSources({...base,measure:'private_credit_gdp'}).candidates[0].requests[0].arguments.series_key).toBe('Q.US.P.A.M.770.A');
  expect(rankSources({...base,measure:'real_house_prices'}).candidates[0].requests[0].arguments.series_key).toBe('Q.US.R.628');
  expect(rankSources({...base,measure:'nominal_house_prices'}).candidates[0].requests[0].arguments.series_key).toBe('Q.US.N.628');
 });
});
describe('structured verification',()=>{
 test('returns common observations, definitions, flags and original provenance',async()=>{
  const r=await selectSource(base,{},async q=>({...await probe(q),observations:[{period:'2026-M07',value:0,attributes:{status:'P'}},{period:'2026-M08',value:-1}]}),now);
  expect(r.status).toBe('verified_recommendation');expect(r.selected.source).toBe('OECD');
  expect(r.selected.verification.commonPeriods).toEqual(['2026-07','2026-08']);expect(r.selected.verification.ageDays).toBe(42);
  const c=r.selected.verification.countries[0];expect(c.urls).toEqual(['https://example.org/data']);expect(c.retrievedAt).toBe('2026-10-10T00:00:00Z');
  expect(c.alignedObservations[0]).toEqual({period:'2026-07',value:0,attributes:{status:'P'}});expect(c.definition.adjustment).toBe('NSA');
 });
 test('explicit source preference is honored only after verification',async()=>{
  const r=await selectSource({...base,preferredSource:'IMF'},{},probe,now);expect(r.selected.source).toBe('IMF');
  const missing=await selectSource({...base,countries:['US'],preferredSource:'FRED'},{},probe,now);expect(missing.selected).toBeNull();expect(missing.status).toBe('requested_source_not_verified');
  const unknown=await selectSource({...base,preferredSource:'BIS'},{},probe,now);expect(unknown.selected).toBeNull();expect(unknown.explanation).toContain('not overridden');
 });
 test('a fourth-ranked FRED source remains eligible when other providers fail',async()=>{
  const r=await selectSource({...base,countries:['US']},{FRED:true},async q=>{if(q.tool!=='fred_get_series')throw new AccessError(q.tool.split('_')[0].toUpperCase() as any,'rate_limited','Provider cooldown.');return probe(q);},now);
  expect(r.candidates).toHaveLength(4);expect(r.selected.source).toBe('FRED');expect(r.candidates[0].verification.status).toBe('rate_limited');
 });
 test('wrong or unconfirmed definitions cannot pass despite matching dates',async()=>{
  for(const [change,status] of [
   [{country:'USA'},'country_mismatch'],[{frequency:'daily'},'frequency_mismatch'],[{measure:'core_cpi_yoy'},'definition_mismatch'],
   [{unit:'index'},'unit_mismatch'],[{unitMultiplier:2},'unit_mismatch'],[{adjustment:'SA'},'adjustment_mismatch'],[{adjustment:'not_reported'},'definition_unconfirmed'],[{transformation:'level'},'transformation_mismatch'],
  ] as const){
   const r=await selectSource(base,{},async q=>({...await probe(q),...change}) as any,now);
   expect(r.selected).toBeNull();expect(r.candidates[0].verification.status).toBe(status);
  }
 });
 test('mismatched scale across countries is rejected even with valid financial data',async()=>{
  const r=await selectSource({...base,measure:'private_credit_gdp'}, {},async q=>({...await probe(q),source:'BIS',country:q.arguments.series_key.includes('.US.')?'USA':'GBR',measure:'private_credit_gdp',frequency:'quarterly',unit:'percent_GDP',unitMultiplier:q.arguments.series_key.includes('.US.')?0:3,adjustment:'not_applicable',transformation:'level',observations:[{period:'2026-Q1',value:1},{period:'2026-Q2',value:2}]}),now);
  expect(r.selected).toBeNull();expect(r.candidates[0].verification.status).toBe('incomparable_definitions');
 });
 test('different latest months align to actual common periods',async()=>{
  const r=await selectSource(base,{},async q=>{const e=await probe(q);e.observations.push({period:e.country==='USA'?'2026-09':'2026-06',value:4});return e;},now);
  expect(r.selected.verification.commonPeriods).toEqual(['2026-07','2026-08']);expect(r.selected.requests[0].arguments.limit).toBe(14);
 });
 test('sparse coverage and stale data are explained separately',async()=>{
  const r=await selectSource(base,{},async q=>({...await probe(q),observations:[{period:'2026-08',value:2}]}),now);
  expect(r.selected).toBeNull();expect(r.candidates[0].verification.status).toBe('partial_coverage');expect(r.candidates[0].verification.message).toContain('Only 1');
  const stale=await selectSource({...base,maxAgeDays:10},{},probe,now);expect(stale.selected).toBeNull();expect(stale.candidates[0].verification.status).toBe('stale');
 });
 test('verification off makes no calls and cannot claim verified data',async()=>{
  const r=await selectSource({...base,verify:false},{},async()=>{throw new Error('Must not fetch');},now);expect(r.status).toBe('unverified_recommendation');expect(r.selected.verification.status).toBe('unverified');
 });
 test('latest verified common period takes precedence over suitability score',async()=>{
  const r=await selectSource(base,{},async q=>{const e=await probe(q);if(e.source==='OECD')e.observations[1].period='2026-06';return e;},now);expect(r.selected.source).toBe('IMF');
 });
 test('formatted text, NaN, future dates and conflicting duplicate values cannot verify',async()=>{
  for(const fn of [async()=>('2026-07: 2\n2026-08: 3' as any),async(q:any)=>({...await probe(q),observations:[{period:'2026-07',value:NaN}]}),async(q:any)=>({...await probe(q),observations:[{period:'2027-01',value:1},{period:'2027-02',value:2}]}),async(q:any)=>({...await probe(q),observations:[{period:'2026-07',value:1},{period:'2026-07',value:2}]})]){
   expect((await selectSource(base,{},fn,now)).selected).toBeNull();
  }
 });
 test('unexpected exception messages never expose credentials',async()=>{
  const r=await selectSource(base,{},async()=>{throw new Error('https://api.example/?api_key=secret');},now);expect(JSON.stringify(r)).not.toContain('secret');expect(r.candidates[0].verification.status).toBe('lookup_failed');
 });
 test('period normalization is frequency-aware and checks actual calendar dates',()=>{
  expect(canonicalPeriod('2026-M08','monthly')).toBe('2026-08');expect(canonicalPeriod('2026Q2','quarterly')).toBe('2026-Q2');expect(canonicalPeriod('2026-04-01','quarterly')).toBe('2026-Q2');
  expect(()=>canonicalPeriod('2026-02-30','daily')).toThrow();expect(()=>canonicalPeriod('2026-08','daily')).toThrow();expect(()=>canonicalPeriod('2026-05-01','quarterly')).toThrow();
 });
 test('authenticated citations cannot enter structured evidence',async()=>{
  expect(()=>finishEvidence({...awaitProbe,urls:['https://example.org/?UserID=secret']})).toThrow();
 });
});
const awaitProbe:SeriesEvidence={source:'FRED',measure:'unemployment_rate',country:'USA',frequency:'monthly',unit:'percent',unitMultiplier:0,adjustment:'SA',transformation:'level',dimensions:{},observations:[],urls:[],retrievedAt:'2026-10-12',notes:[]};
