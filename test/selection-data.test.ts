import {afterEach,expect,test} from 'bun:test';
import {parseCpiCsv,parseFredEvidence,parseBlsEvidence,parseBeaEvidence,parseEurostatEvidence,parseBisEvidence,parseWorldBankEvidence,parseEiaEvidence,parseEcbEvidence,selectionEvidence} from '../src/core/selection-data';
import {finishEvidence} from '../src/core/evidence';
import {createLayeredCache} from '../src/core/cache';
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
const url=new URL('https://example.org/data');
const oecdHeader='STRUCTURE_ID,REF_AREA,FREQ,METHODOLOGY,MEASURE,UNIT_MEASURE,EXPENDITURE,ADJUSTMENT,TRANSFORMATION,TIME_PERIOD,OBS_VALUE,UNIT_MULT,OBS_STATUS\n';
const oecdRow='OECD.SDD.TPS:DSD_PRICES@DF_PRICES_ALL(1.0),USA,M,N,CPI,PA,_T,N,GY,2026-08,3.4,,P\n';
test('OECD verification checks returned dimensions, unit and scale instead of trusting the query',()=>{
 const e=finishEvidence(parseCpiCsv('OECD',oecdHeader+oecdRow,'USA.M.N.CPI.PA._T.N.GY',url));
 expect(e.unit).toBe('percent');expect(e.adjustment).toBe('NSA');expect(e.observations[0].attributes?.OBS_STATUS).toBe('P');
 for(const row of [oecdRow.replace(',USA,',',GBR,'),oecdRow.replace(',PA,',',IX,'),oecdRow.replace(',N,GY,',',Y,GY,'),oecdRow.replace(',GY,',',G1,'),oecdRow.replace(',3.4,,P',',3.4,3,P')])expect(()=>parseCpiCsv('OECD',oecdHeader+row,'USA.M.N.CPI.PA._T.N.GY',url)).toThrow();
});
test('IMF annual CPI never invents absent adjustment metadata or accepts an index',()=>{
 const header='DATAFLOW,COUNTRY,INDEX_TYPE,COICOP_1999,TYPE_OF_TRANSFORMATION,FREQUENCY,TIME_PERIOD,OBS_VALUE,SCALE,UNIT,STATUS\n';
 const row='IMF.STA:CPI(5.0.0),GBR,CPI,_T,YOY_PCH_PA_PT,M,2026-M08,3,0,,E\n';
 const e=finishEvidence(parseCpiCsv('IMF',header+row,'GBR.CPI._T.YOY_PCH_PA_PT.M',url));expect(e.adjustment).toBe('not_reported');expect(e.observations[0].period).toBe('2026-08');
 expect(()=>parseCpiCsv('IMF',header+row.replace('YOY_PCH_PA_PT','IX'),'GBR.CPI._T.YOY_PCH_PA_PT.M',url)).toThrow();
});
const fredInfo={seriess:[{id:'CPIAUCNS',title:'CPI',frequency_short:'M',units:'Index 1982-1984=100',seasonal_adjustment_short:'NSA'}]};
const fredData={units:'pc1',observations:[{date:'2026-08-01',value:'3.4'}]};
const fredArgs={series_id:'CPIAUCNS',units:'pc1',limit:1};
test('FRED verifies returned metadata and transformation, not just numeric periods',()=>{
 expect(finishEvidence(parseFredEvidence(fredInfo,fredData,fredArgs)).observations[0].period).toBe('2026-08');
 for(const change of [{id:'CPIAUCSL'},{frequency_short:'Q'},{units:'Dollars'},{seasonal_adjustment_short:'SA'}])expect(()=>parseFredEvidence({seriess:[{...fredInfo.seriess[0],...change}]},fredData,fredArgs)).toThrow();
 expect(()=>parseFredEvidence(fredInfo,{...fredData,units:'lin'},fredArgs)).toThrow();
});
const blsArgs={series_ids:['CUUR0000SA0'],start_year:'2024',end_year:'2026'};
function bls(rows:any[],id='CUUR0000SA0'){return {status:'REQUEST_SUCCEEDED',Results:{series:[{seriesID:id,data:rows}]}};}
test('BLS calculates annual inflation only from the same series and exact prior-year month',()=>{
 const rows=[{year:'2026',period:'M08',value:'110'},{year:'2025',period:'M08',value:'100'},{year:'2026',period:'M07',value:'109'},{year:'2025',period:'M06',value:'99'},{year:'2026',period:'M13',value:'108'}];
 const e=finishEvidence(parseBlsEvidence(bls(rows),blsArgs));expect(e.observations).toHaveLength(1);expect(e.observations[0].value).toBeCloseTo(10);expect(e.notes.join(' ')).toContain('computed');
 expect(e.observations[0].attributes?.calculation).toContain('12_months');
 expect(parseBlsEvidence(bls([{year:'2026',period:'M08',value:'110'}]),blsArgs).observations).toEqual([]);
});
test('BLS preserves reported calculations and rejects contrary catalogue adjustment',()=>{
 const data=bls([{year:'2026',period:'M08',value:'110',calculations:{pct_changes:{'12':'0'}}}]);
 expect(parseBlsEvidence(data,blsArgs).observations[0].value).toBe(0);
 (data.Results.series[0] as any).catalog={seasonality:'Seasonally Adjusted'};expect(()=>parseBlsEvidence(data,blsArgs)).toThrow();
});
test('payroll change uses the previous calendar month including a year boundary',()=>{
 const data=bls([{year:'2026',period:'M01',value:'150000'},{year:'2025',period:'M12',value:'150010'}],'CES0000000001');
 const e=parseBlsEvidence(data,{...blsArgs,series_ids:['CES0000000001']});expect(e.observations[0].value).toBe(-10);expect(e.unitMultiplier).toBe(3);
});
test('BLS cannot compute from conflicting baseline observations or a zero denominator',()=>{
 const current={year:'2026',period:'M08',value:'110'},prior={year:'2025',period:'M08',value:'100'};
 expect(()=>parseBlsEvidence(bls([current,prior,{...prior,value:'90'}]),blsArgs)).toThrow('conflicting');
 expect(parseBlsEvidence(bls([current,{...prior,value:'0'}]),blsArgs).observations).toEqual([]);
});
const beaArgs={dataset:'NIPA',table_name:'T10106',frequency:'Q',year:'2026'};
const beaRow={TableName:'T10106',LineNumber:'1',LineDescription:'Gross domestic product',TimePeriod:'2026Q2',DataValue:'24,408,011',CL_UNIT:'Level',UNIT_MULT:'6',METRIC_NAME:'Chained Dollars'};
const bea=(row:any=beaRow)=>({BEAAPI:{Results:{Data:[row],Notes:[{NoteRef:'T10106',NoteText:'Real GDP [Billions of chained (2017) dollars]'}]}}});
test('BEA uses native row scaling and the reference year from table notes',()=>{
 const e=finishEvidence(parseBeaEvidence(bea(),beaArgs,url));expect(e.unitMultiplier).toBe(6);expect(e.unit).toBe('chained_2017_USD');expect(e.observations[0]).toEqual({period:'2026-Q2',value:24408011});
 expect(()=>parseBeaEvidence(bea({...beaRow,TableName:'T10105'}),beaArgs,url)).toThrow();
 expect(()=>parseBeaEvidence(bea({...beaRow,LineNumber:'2'}),beaArgs,url)).toThrow();
 expect(()=>parseBeaEvidence(bea({...beaRow,METRIC_NAME:'Current Dollars'}),beaArgs,url)).toThrow();
 const missing=bea();missing.BEAAPI.Results.Notes=[];expect(()=>parseBeaEvidence(missing,beaArgs,url)).toThrow('reference year');
});
test('BEA annualized growth cannot be validated using ordinary GDP levels',()=>{
 const a={...beaArgs,table_name:'T10101'};
 expect(()=>parseBeaEvidence(bea({...beaRow,TableName:'T10101'}),a,url)).toThrow();
 const e=parseBeaEvidence(bea({...beaRow,TableName:'T10101',CL_UNIT:'Percent change, annual rate',METRIC_NAME:'Fisher Quantity Index',UNIT_MULT:'0',DataValue:'3.8'}),a,url);expect(e.transformation).toBe('qoq_annualized_percent_change');
});
test('Eurostat decoding supports time-first sparse grids and carries status flags',()=>{
 const filters={freq:['M'],unit:['RCH_A'],coicop18:['TOTAL'],geo:['DE']},ids=['time',...Object.keys(filters)];
 const data={class:'dataset',version:'2.0',id:ids,size:[3,1,1,1,1],dimension:Object.fromEntries(ids.map(id=>[id,{category:{index:id==='time'?{'2026-06':0,'2026-07':1,'2026-08':2}:{[filters[id as keyof typeof filters][0]]:0}}}])),value:{0:0,2:-1},status:{2:'p'},extension:{id:'prc_hicp_minr'}};
 const e=finishEvidence(parseEurostatEvidence(data,url,{datasetId:'prc_hicp_minr',filters,limit:3}));expect(e.country).toBe('DEU');expect(e.observations.map(o=>o.period)).toEqual(['2026-06','2026-08']);expect(e.observations[1].attributes?.status).toBe('p');
 data.dimension.unit.category.index={I15:0};expect(()=>parseEurostatEvidence(data,url,{datasetId:'prc_hicp_minr',filters,limit:3})).toThrow();
});
test('BIS rejects changed country, unit, scaling and real/nominal dimensions',()=>{
 const dimensions=[['FREQ','Q'],['REF_AREA','US'],['VALUE','R'],['UNIT_MEASURE','628']].map(([id,code])=>({id,label:id,codes:[{code,label:code}]}));
 const def={id:'WS_SPP',version:'1.0',label:'House prices',description:'',dimensions,attributes:['UNIT_MULT']};
 const p={datasetId:'WS_SPP',seriesKey:'Q.US.R.628',limit:2};
 const header='DATAFLOW,FREQ,REF_AREA,VALUE,UNIT_MEASURE,UNIT_MULT,TIME_PERIOD,OBS_VALUE,OBS_STATUS\n';
 const row='BIS:WS_SPP(1.0),Q,US,R,628,0,2026-Q2,120,P\n';
 const e=finishEvidence(parseBisEvidence(header+row,url,p,def));expect(e.measure).toBe('real_house_prices');expect(e.adjustment).toBe('not_reported');expect(e.observations[0].attributes?.OBS_STATUS).toBe('P');
 for(const r of [row.replace(',US,',',GB,'),row.replace(',R,',',N,'),row.replace(',628,',',999,'),row.replace(',0,',',3,')])expect(()=>parseBisEvidence(header+r,url,p,def)).toThrow();
});
test('World Bank validates indicator, country, and PPP reference year',()=>{
 const p={countryCodes:['US'],indicator:'NY.GDP.PCAP.PP.KD',startYear:2024,endYear:2026};
 const u=new URL('https://api.worldbank.org/v2/country/US/indicator/NY.GDP.PCAP.PP.KD?date=2024:2026');
 const meta={id:p.indicator,name:'GDP per capita, PPP (constant 2021 international $)'},page={rows:[{countryiso3code:'USA',country:{id:'US',value:'United States'},indicator:{id:p.indicator},date:'2025',value:0}],updated:'2026-10-01',pages:1};
 const e=parseWorldBankEvidence(page,meta,u,p);expect(e.unit).toBe('constant_2021_international_dollars_per_person');expect(e.observations[0].value).toBe(0);
 expect(()=>parseWorldBankEvidence(page,{...meta,name:'GDP per capita, PPP (current international $)'},u,p)).toThrow();
 expect(()=>parseWorldBankEvidence({...page,rows:[{...page.rows[0],countryiso3code:'GBR',country:{id:'GB'}}]},meta,u,p)).toThrow();
});
test('EIA structured verification rejects a unit change while retaining exact residential facets',async()=>{
 const meta=await Bun.file(new URL('./fixtures/eia/electricity-metadata.json',import.meta.url)).json(),data=await Bun.file(new URL('./fixtures/eia/electricity-data.json',import.meta.url)).json();
 const p={route:'electricity/retail-sales',frequency:'monthly',fields:['price'],facets:{stateid:['US'],sectorid:['RES']},length:2};
 const e=parseEiaEvidence(data,url,p,meta);expect(e.measure).toBe('residential_electricity_price');expect(e.dimensions.sectorid).toBe('RES');
 data.data.forEach((r:any)=>r['price-units']='dollars per kilowatt-hour');expect(()=>parseEiaEvidence(data,url,p,meta)).toThrow('units differ');
});
test('ECB structured verification checks deposit-rate identity and percent scaling',()=>{
 const ids=['FREQ','REF_AREA','CURRENCY','PROVIDER_FM','INSTRUMENT_FM','PROVIDER_FM_ID','DATA_TYPE_FM'],codes=['D','U2','EUR','4F','KR','DFR','LEV'];
 const data={structure:{dimensions:{series:ids.map((id,i)=>({id,values:[{id:codes[i]}]})),observation:[{id:'TIME_PERIOD',values:[{id:'2026-10-12'}]}]},attributes:{series:[{id:'UNIT',values:[{id:'PCPA'}]},{id:'UNIT_MULT',values:[{id:'0'}]}]}},dataSets:[{series:{'0:0:0:0:0:0:0':{attributes:[0,0],observations:{0:[0]}}}}]};
 const u=new URL('https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV');expect(parseEcbEvidence(data,u).observations[0].value).toBe(0);
 data.structure.attributes.series[1].values[0].id='3';expect(()=>parseEcbEvidence(data,u)).toThrow('unscaled');
});
test('structured cache stores only validated evidence and preserves retrieval time',async()=>{
 let calls=0,bad=true;globalThis.fetch=(async(input:any)=>{calls++;const isObs=String(input).includes('observations');return new Response(JSON.stringify(isObs?{...fredData,units:bad?'lin':'pc1'}:fredInfo));}) as any;
 const cache=createLayeredCache(),r={tool:'fred_get_series',arguments:fredArgs};
 await expect(selectionEvidence(r,{FRED_KEY:'secret'},cache)).rejects.toThrow('transformation');bad=false;
 const e=await selectionEvidence(r,{FRED_KEY:'secret'},cache),again=await selectionEvidence(r,{FRED_KEY:'secret'},cache);expect(calls).toBe(4);expect(again.retrievedAt).toBe(e.retrievedAt);expect(JSON.stringify(e)).not.toContain('secret');
});
test('historical FRED verification sends date bounds to the provider',async()=>{
 const seen:URL[]=[];
 globalThis.fetch=(async(input:any)=>{const u=new URL(input);seen.push(u);return new Response(JSON.stringify(u.pathname.endsWith('/observations')?{units:'pc1',observations:[{date:'2020-01-01',value:'2'}]}:fredInfo));}) as typeof fetch;
 const e=await selectionEvidence({tool:'fred_get_series',arguments:{...fredArgs,start_period:'2020-01-01',end_period:'2020-01-31'}},{FRED_KEY:'test-only'},createLayeredCache());
 const request=seen.find(u=>u.pathname.endsWith('/observations'))!;
 expect(request.searchParams.get('observation_start')).toBe('2020-01-01');expect(request.searchParams.get('observation_end')).toBe('2020-01-31');expect(e.observations[0].period).toBe('2020-01');
});
test('BLS historical range is filtered before trimming baseline and later-year observations',async()=>{
 const rows=Array.from({length:144},(_,i)=>({year:String(2009+Math.floor(i/12)),period:`M${String(i%12+1).padStart(2,'0')}`,value:'100',calculations:{pct_changes:{'12':'2'}}}));
 globalThis.fetch=(async()=>new Response(JSON.stringify(bls(rows)))) as typeof fetch;
 const e=await selectionEvidence({tool:'bls_get_series',arguments:{series_ids:['CUUR0000SA0'],start_year:'2009',end_year:'2020'}},{},createLayeredCache(),{startPeriod:'2010-05',endPeriod:'2020-04'});
 expect(e.observations).toHaveLength(120);expect(e.observations[0].period).toBe('2010-05');expect(e.observations.at(-1)!.period).toBe('2020-04');
});
test('historical OECD verification sends both dates and does not request latest observations',async()=>{
 let seen:URL|undefined;
 globalThis.fetch=(async(input:any)=>{seen=new URL(input);return new Response(oecdHeader+oecdRow.replace('2026-08','2020-01'));}) as typeof fetch;
 const e=await selectionEvidence({tool:'oecd_get_data',arguments:{dataset_id:'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL',series_key:'USA.M.N.CPI.PA._T.N.GY',start_period:'2020-01',end_period:'2020-01',limit:1}},{},createLayeredCache());
 expect(seen!.searchParams.get('startPeriod')).toBe('2020-01');expect(seen!.searchParams.get('endPeriod')).toBe('2020-01');expect(seen!.searchParams.has('lastNObservations')).toBe(false);expect(e.observations[0].period).toBe('2020-01');
});
