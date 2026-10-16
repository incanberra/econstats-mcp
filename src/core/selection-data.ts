import {parse} from 'csv-parse/sync';
import iso from 'i18n-iso-countries';
import {type LayeredCache} from './cache';
import {checkedJson,worldBankPages,worldBankUrl,formatWorldBank,ecbUrl,formatEcb} from './legacy';
import {fetchRetry} from './http';
import {buildImfDataUrl} from './imf';
import {buildOecdDataUrl,requestOecd} from './oecd';
import {buildBisDataUrl,buildBisStructureUrl,getBisDefinition,validateBisKey,formatBisCsv,requestBis} from './bis';
import {buildEurostatDataUrl,buildEurostatStructureUrl,validateEurostatFilters,formatEurostatJson,requestEurostat} from './eurostat';
import {buildEiaDataUrl,buildEiaMetadataUrl,validateEiaSelection,formatEiaData,requestEia} from './eia';
import {type SeriesEvidence,type Observation,type Adjustment,requireEvidence as check,numeric,frequency,finishEvidence,expectedTransformation} from './evidence';
import type {Retrieval,Measure,Source} from './selection';

type Keys={FRED_KEY?:string;BLS_KEY?:string;BEA_KEY?:string;EIA_KEY?:string};
const iso3=(code:string)=>code==='U2'?'EA':iso.alpha2ToAlpha3(code)||code;
const props=(row:any,keys:string[])=>Object.fromEntries(keys.filter(k=>row[k]!==undefined&&row[k]!==null&&row[k]!=='').map(k=>[k,String(row[k])]));
function constant(rows:any[],field:string,required=true):string {
  const values=[...new Set(rows.map(r=>String(r[field]??'')))];
  check(values.length===1&&(!required||values[0]!==''),'unit_unconfirmed',`Provider omitted or changed ${field} within the series.`);return values[0];
}
function base(source:Source,measure:Measure,country:string,f:string,unit:string,adjustment:Adjustment,dimensions:Record<string,string>,observations:Observation[],url:URL|string,unitMultiplier=0):SeriesEvidence {
  return {source,measure,country,frequency:frequency(f),unit,unitMultiplier,adjustment,transformation:expectedTransformation(measure),dimensions,observations,urls:[String(url)],retrievedAt:new Date().toISOString(),notes:[]};
}
function csvRows(csv:string):Record<string,string>[] {
  check(csv.length<=20_000_000,'invalid_response','Response exceeds the verification size limit.');
  const header=parse(csv,{bom:true,to:1})[0] as string[];
  check(header?.includes('TIME_PERIOD')&&header.includes('OBS_VALUE')&&new Set(header).size===header.length,'invalid_response','Missing or duplicate observation columns.');
  const rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true}) as Record<string,string>[];
  check(rows.length,'no_data','Provider returned no observations.');return rows;
}
function matchingRows(rows:any[],dims:string[],key:string){
  const codes=key.split('.');check(codes.length===dims.length,'definition_mismatch','Unexpected series dimension count.');
  check(rows.every(r=>dims.every((d,i)=>r[d]===codes[i])),'definition_mismatch','Provider returned a different country, frequency or series definition.');
  return props(rows[0],dims);
}
function observations(rows:any[],attrs:string[]=[]):Observation[]{
  return rows.flatMap(r=>{const value=numeric(r.OBS_VALUE);return value===undefined?[]:[{period:r.TIME_PERIOD,value,attributes:props(r,attrs)}];});
}

export function parseCpiCsv(source:'OECD'|'IMF',csv:string,key:string,url:URL):SeriesEvidence {
  const rows=csvRows(csv),oecd=source==='OECD';
  const dims=oecd?['REF_AREA','FREQ','METHODOLOGY','MEASURE','UNIT_MEASURE','EXPENDITURE','ADJUSTMENT','TRANSFORMATION']:['COUNTRY','INDEX_TYPE','COICOP_1999','TYPE_OF_TRANSFORMATION','FREQUENCY'];
  const d=matchingRows(rows,dims,key);
  check(rows.every(r=>(r.STRUCTURE_ID??r.DATAFLOW??'').startsWith(oecd?'OECD.SDD.TPS:DSD_PRICES@DF_PRICES_ALL(':'IMF.STA:CPI(')),'definition_mismatch','Provider returned a different CPI dataset.');
  check(oecd?d.METHODOLOGY==='N'&&d.MEASURE==='CPI'&&d.UNIT_MEASURE==='PA'&&d.EXPENDITURE==='_T'&&d.ADJUSTMENT==='N'&&d.TRANSFORMATION==='GY':d.INDEX_TYPE==='CPI'&&d.COICOP_1999==='_T'&&d.TYPE_OF_TRANSFORMATION==='YOY_PCH_PA_PT','definition_mismatch','Expected national all-items CPI expressed as annual percentage change.');
  const scale=constant(rows,oecd?'UNIT_MULT':'SCALE',false);
  check(scale===''||scale==='0','unit_mismatch','Inflation must be reported as unscaled percent.');
  if(!oecd){const unit=constant(rows,'UNIT',false);check(!unit||['PC','PCT','PA','PT','YOY_PCH_PA_PT'].includes(unit),'unit_mismatch','IMF unit conflicts with the annual percentage-change dimension.');}
  const e=base(source,'headline_cpi_yoy',oecd?d.REF_AREA:d.COUNTRY,oecd?d.FREQ:d.FREQUENCY,'percent',oecd?'NSA':'not_reported',d,observations(rows,['OBS_STATUS','STATUS']),url);
  e.notes.push('National CPI methods and baskets differ; matching dimensions do not make national CPI fully harmonised.');
  if(!oecd)e.notes.push('The IMF CPI response identifies the annual transformation but does not report seasonal adjustment. Strict selection cannot confirm adjustment from this response.');
  return e;
}

export function parseFredEvidence(info:any,data:any,a:any):SeriesEvidence {
  const s=info.seriess?.[0];check(info.seriess?.length===1&&s?.id===a.series_id&&Array.isArray(data.observations),'definition_mismatch','FRED series metadata did not match the requested ID.');
  const specs:Record<string,{measure:Measure;f:string;unit:RegExp;adj:string;transform:string}>={
    CPIAUCNS:{measure:'headline_cpi_yoy',f:'M',unit:/^Index /i,adj:'NSA',transform:'pc1'},
    CPILFENS:{measure:'core_cpi_yoy',f:'M',unit:/^Index /i,adj:'NSA',transform:'pc1'},
    GDPC1:{measure:'real_gdp_level',f:'Q',unit:/^Billions of Chained \d{4} Dollars$/i,adj:'SAAR',transform:'lin'},
    A191RL1Q225SBEA:{measure:'real_gdp_growth_annualized',f:'Q',unit:/^Percent Change from Preceding Period$/i,adj:'SAAR',transform:'lin'},
    UNRATE:{measure:'unemployment_rate',f:'M',unit:/^Percent$/i,adj:'SA',transform:'lin'},
    PAYEMS:{measure:'nonfarm_jobs_change',f:'M',unit:/^Thousands of Persons$/i,adj:'SA',transform:'chg'},
  };
  const spec=specs[s.id];check(spec&&spec.f===s.frequency_short&&spec.unit.test(s.units)&&spec.adj===s.seasonal_adjustment_short,'definition_mismatch','FRED frequency, units or seasonal adjustment differ from the registered series definition.');
  check(a.units===spec.transform&&data.units===spec.transform,'transformation_mismatch','FRED did not confirm the requested transformation.');
  const unit=s.id==='GDPC1'?`chained_${s.units.match(/\d{4}/)[0]}_USD`:s.id==='PAYEMS'?'persons':'percent';
  return base('FRED',spec.measure,'USA',s.frequency_short,unit,spec.adj==='NSA'?'NSA':'SA',props(s,['id','title','units','frequency_short','seasonal_adjustment_short']),data.observations.flatMap((r:any)=>{const v=numeric(r.value);return v===undefined?[]:[{period:r.date,value:v}];}),`https://fred.stlouisfed.org/series/${s.id}`,s.id==='GDPC1'?9:s.id==='PAYEMS'?3:0);
}

export function parseBlsEvidence(data:any,a:any):SeriesEvidence {
  const id=a.series_ids[0],s=data.Results?.series;
  check(data.status==='REQUEST_SUCCEEDED'&&s?.length===1&&s[0].seriesID===id&&Array.isArray(s[0].data),'definition_mismatch','BLS returned a different series or invalid response.');
  const measures:Record<string,Measure>={CUUR0000SA0:'headline_cpi_yoy',CUUR0000SA0L1E:'core_cpi_yoy',LNS14000000:'unemployment_rate',CES0000000001:'nonfarm_jobs_change'};
  const measure=measures[id];check(measure,'definition_unconfirmed','BLS series has no registered definition.');
  const index=id.startsWith('CU'),employment=id.startsWith('CE');
  const levels=new Map<string,number>();
  for(const r of s[0].data){
    if(/^M(0[1-9]|1[0-2])$/.test(r.period)){
      const v=numeric(r.value),period=`${r.year}-${r.period.slice(1)}`;
      check(!levels.has(period)||v===levels.get(period),'conflicting_observations','BLS returned conflicting levels for a baseline month.');
      if(v!==undefined)levels.set(period,v);
    }
  }
  let computed=false;
  const obs:Observation[]=s[0].data.flatMap((r:any)=>{
    if(r.period==='M13')return [];
    check(/^M(0[1-9]|1[0-2])$/.test(r.period)&&/^\d{4}$/.test(r.year),'frequency_mismatch','Expected monthly BLS observations.');
    check(Number(r.year)>=Number(a.start_year)&&Number(r.year)<=Number(a.end_year),'invalid_period','BLS returned an unrequested year.');
    let value=numeric(index?r.calculations?.pct_changes?.['12']:employment?r.calculations?.net_changes?.['1']:r.value);
    let calculation=index||employment?'provider_calculation':'reported_level';
    if(value===undefined&&(index||employment)){
      const current=levels.get(`${r.year}-${r.period.slice(1)}`),priorDate=new Date(Date.UTC(Number(r.year),Number(r.period.slice(1))-1-(index?12:1),1));
      const prior=levels.get(priorDate.toISOString().slice(0,7));
      if(current!==undefined&&prior!==undefined&&(!index||prior!==0)){value=index?(current/prior-1)*100:current-prior;computed=true;calculation=index?'100 * (level / level_12_months_earlier - 1)':'level - level_1_month_earlier';}
    }
    // A missing calculation and missing baseline never turn a level into a change.
    return value===undefined?[]:[{period:`${r.year}-${r.period.slice(1)}`,value,attributes:{calculation,footnotes:JSON.stringify(r.footnotes??[])}}];
  });
  const e=base('BLS',measure,'USA','M',employment?'persons':'percent',index?'NSA':'SA',{seriesID:id,...props(s[0].catalog??{},['series_title','seasonality'])},obs,`https://data.bls.gov/timeseries/${id}`,employment?3:0);
  const season=String(s[0].catalog?.seasonality??'');
  if(season)check(index?/not seasonally|unadjusted/i.test(season):/^seasonally adjusted$/i.test(season),'adjustment_mismatch','BLS catalogue adjustment conflicts with the registered series.');
  e.notes.push('Country, measure, units and adjustment use the registered BLS series ID; observations come from the BLS JSON response.');
  if(computed)e.notes.push('Where BLS omitted calculations, changes were computed from exact calendar-month baselines in the same returned series; formulas are attached to observations.');return e;
}

export function parseBeaEvidence(data:any,a:any,url:URL):SeriesEvidence {
  check(a.dataset==='NIPA'&&['T10101','T10106'].includes(a.table_name)&&a.frequency==='Q','definition_unconfirmed','Unsupported GDP table or frequency.');
  const all=data.BEAAPI?.Results?.Data;check(Array.isArray(all),'invalid_response','BEA did not return a data table.');
  const rows=all.filter((r:any)=>String(r.LineNumber)==='1'&&r.LineDescription==='Gross domestic product');
  check(rows.length,'no_data','BEA returned no gross domestic product line.');
  check(rows.every((r:any)=>r.TableName===a.table_name),'definition_mismatch','BEA returned a different GDP table.');
  const growth=a.table_name==='T10101',unit=constant(rows,'CL_UNIT'),mult=constant(rows,'UNIT_MULT'),metric=constant(rows,'METRIC_NAME');
  check(growth?/percent change, annual rate/i.test(unit)&&mult==='0'&&/Fisher Quantity Index/i.test(metric):unit==='Level'&&['6','9'].includes(mult)&&metric==='Chained Dollars','unit_mismatch','BEA GDP units or growth convention were not confirmed.');
  const notes=(data.BEAAPI.Results.Notes??[]).filter((n:any)=>String(n.NoteRef).startsWith(a.table_name)).map((n:any)=>n.NoteText).join('\n');
  const year=growth?'':notes.match(/chained\s*\(?(\d{4})\)?\s*dollars/i)?.[1];check(growth||year,'unit_unconfirmed','BEA chained-dollar reference year is missing.');
  const e=base('BEA',growth?'real_gdp_growth_annualized':'real_gdp_level','USA','Q',growth?'percent':`chained_${year}_USD`,'SA',props(rows[0],['TableName','LineNumber','LineDescription','CL_UNIT','UNIT_MULT','METRIC_NAME']),rows.flatMap((r:any)=>{const v=numeric(r.DataValue);return v===undefined?[]:[{period:r.TimePeriod,value:v}];}),url,Number(mult));
  e.notes.push('The registered NIPA table and GDP line specify seasonally adjusted annual rates.');return e;
}

export function parseEurostatEvidence(data:any,url:URL,p:any):SeriesEvidence {
  formatEurostatJson(data,url,p); // Shared schema/grid/selection validation; no display-text parsing.
  const dims:Record<string,string>={},times:string[]=[];
  for(const id of data.id){
    const raw=data.dimension[id].category.index,codes=Array.isArray(raw)?raw:Object.keys(raw).sort((a,b)=>raw[a]-raw[b]);
    if(id==='time')times.push(...codes);else {check(codes.length===1,'definition_mismatch','Selection returned more than one series.');dims[id]=codes[0];}
  }
  const specs:Record<string,{measure:Measure;unit:string;adjustment:Adjustment}>={prc_hicp_minr:{measure:'hicp_yoy',unit:'percent',adjustment:'NSA'},namq_10_gdp:{measure:'real_gdp_growth_qoq',unit:'percent',adjustment:'SCA'},une_rt_m:{measure:'unemployment_rate',unit:'percent',adjustment:'SA'}};
  const spec=specs[p.datasetId];check(spec,'definition_unconfirmed','Unregistered Eurostat measure.');
  check(p.datasetId==='prc_hicp_minr'?dims.unit==='RCH_A'&&dims.coicop18==='TOTAL':p.datasetId==='namq_10_gdp'?dims.unit==='CLV_PCH_PRE'&&dims.s_adj==='SCA'&&dims.na_item==='B1GQ':dims.unit==='PC_ACT'&&dims.s_adj==='SA'&&dims.sex==='T'&&dims.age==='TOTAL','definition_mismatch','Eurostat units, adjustment or measure differ from the registered definition.');
  const obs:Observation[]=Object.entries(data.value).flatMap(([i,v])=>v==null?[]:[{period:times[Number(i)],value:v as number,attributes:{status:typeof data.status==='string'?data.status:data.status?.[i]??''}}]);
  const e=base('EUROSTAT',spec.measure,iso3(dims.geo),dims.freq,spec.unit,spec.adjustment,dims,obs,url);
  if(spec.measure==='unemployment_rate')e.urls.push('https://ec.europa.eu/eurostat/cache/metadata/EN/une_rt_m_esms.htm');
  if(spec.measure==='hicp_yoy')e.notes.push('HICP is harmonised, but national expenditure weights differ. The HICP annual-rate dataset is unadjusted.');return e;
}

export function parseBisEvidence(csv:string,url:URL,p:any,def:ReturnType<typeof getBisDefinition>):SeriesEvidence {
  validateBisKey(def,p.seriesKey);formatBisCsv(csv,url,p,def);
  const rows=csvRows(csv),d=matchingRows(rows,def.dimensions.map(d=>d.id),p.seriesKey),parts=p.seriesKey.split('.');
  const measures:Record<string,Measure>={WS_TC:'private_credit_gdp',WS_CREDIT_GAP:'credit_gap',WS_DSR:'private_debt_service',WS_LBS_D_PUB:'crossborder_bank_claims',WS_CBPOL:'policy_rate'};
  const measure=measures[p.datasetId]??(p.datasetId==='WS_SPP'?(parts[2]==='R'?'real_house_prices':'nominal_house_prices'):p.datasetId==='WS_EER'?(parts[1]==='R'?'real_effective_exchange_rate':'nominal_effective_exchange_rate'):undefined);
  check(measure,'definition_unconfirmed','Unregistered BIS definition.');
  const unit=constant(rows,'UNIT_MEASURE'),mult=constant(rows,'UNIT_MULT',false)||'0';
  const expectedUnits:Record<string,string>={WS_TC:'367',WS_CREDIT_GAP:'770',WS_DSR:'367',WS_LBS_D_PUB:'USD',WS_CBPOL:'368',WS_SPP:'628',WS_EER:'882'};
  check(unit===expectedUnits[p.datasetId]&&mult===(p.datasetId==='WS_LBS_D_PUB'?'6':'0'),'unit_mismatch','BIS unit code or scaling differs from the registered definition.');
  const attrs=Object.keys(rows[0]).filter(k=>/^[A-Z][A-Z0-9_]*$/.test(k)&&!def.dimensions.some(d=>d.id===k)&&!['TIME_PERIOD','OBS_VALUE'].includes(k));
  for(const k of ['BASE_PER','BASE_PERIOD'])if(k in rows[0])constant(rows,k,false);
  const country=d.BORROWERS_CTY??d.L_REP_CTY??d.REF_AREA;
  check(country,'country_unconfirmed','BIS country dimension is missing.');
  const e=base('BIS',measure,iso3(country),d.FREQ,constant(rows,'Unit of measure',false)||unit,p.datasetId==='WS_CBPOL'?'not_applicable':'not_reported',{...d,...props(rows[0],['UNIT_MEASURE','UNIT_MULT','BASE_PER','BASE_PERIOD'])},observations(rows,attrs),url,Number(mult));
  e.notes.push('BIS dimension codes and current codelists establish the measure; national compilation, coverage and breaks can differ.');
  if(e.adjustment==='not_reported')e.notes.push('A separate seasonal-adjustment field is not supplied. This measure uses the same registered BIS definition and adjustment codes across countries; do not describe it as seasonally adjusted.');return e;
}

export function parseEiaEvidence(data:any,url:URL,p:any,meta:any):SeriesEvidence {
  validateEiaSelection(meta,p);formatEiaData(data,url,p,meta);
  const rows=data.data;check(rows.length,'no_data','EIA returned no observations.');
  check(p.fields.length===1,'definition_mismatch','Expected a single energy measure.');
  const field=p.fields[0],series=p.facets.series?.[0];
  const specs:Record<string,{measure:Measure;route:string;unit:string}>={RWTC:{measure:'wti_spot_price',route:'petroleum/pri/spt',unit:'$/BBL'},RNGWHHD:{measure:'henry_hub_spot_price',route:'natural-gas/pri/fut',unit:'$/MMBTU'},EMM_EPMR_PTE_NUS_DPG:{measure:'regular_gasoline_price',route:'petroleum/pri/gnd',unit:'$/GAL'}};
  const spec=series?specs[series]:p.route==='electricity/retail-sales'&&p.facets.stateid?.[0]==='US'&&p.facets.sectorid?.[0]==='RES'?{measure:field==='price'?'residential_electricity_price':'residential_electricity_sales',route:p.route,unit:field==='price'?'cents per kilowatt-hour':'million kilowatt hours'}:undefined;
  check(spec&&spec.route===p.route&&(series?field==='value':['price','sales'].includes(field)),'definition_mismatch','Unregistered energy series or field.');
  const units=rows.map((r:any)=>String(r[`${field}-units`]??r.units??meta.data?.[field]?.units??''));
  check(units.every((u:string)=>u===spec.unit),'unit_mismatch','EIA units differ from the registered series definition.');
  const dims=(meta.facets??[]).map((f:any)=>f.id);dims.forEach((d:string)=>constant(rows,d));
  const e=base('EIA',spec.measure as Measure,'USA',data.frequency,spec.unit,'not_reported',props(rows[0],dims),rows.flatMap((r:any)=>{const v=numeric(r[field]);return v===undefined?[]:[{period:r.period,value:v}];}),url);
  e.notes.push('Reported energy price/sales levels; the response does not identify a seasonal-adjustment field.');return e;
}

export function parseWorldBankEvidence(page:any,meta:any,url:URL,p:any):SeriesEvidence {
  formatWorldBank(page.rows,meta,url,page.updated,page.pages);
  const population=p.indicator==='SP.POP.TOTL';check(population||p.indicator==='NY.GDP.PCAP.PP.KD','definition_unconfirmed','Unregistered World Bank indicator.');
  check(meta.id===p.indicator,'definition_mismatch','World Bank metadata identifies a different indicator.');
  const year=String(meta.name).match(/constant (\d{4}) international/i)?.[1];check(population||year,'unit_unconfirmed','World Bank PPP price reference year is missing.');
  check(population?/population, total/i.test(meta.name):/GDP per capita, PPP/i.test(meta.name),'definition_mismatch','World Bank indicator definition changed.');
  const e=base('WORLD_BANK',population?'population':'gdp_per_capita_ppp',iso3(p.countryCodes[0]),'A',population?'persons':`constant_${year}_international_dollars_per_person`,'not_applicable',{indicator:meta.id,title:meta.name},page.rows.flatMap((r:any)=>r.value==null?[]:[{period:r.date,value:r.value,attributes:props(r,['obs_status'])}]),url);
  e.notes.push(String(meta.sourceNote??'Current WDI indicator definition.'));return e;
}

export function parseEcbEvidence(data:any,url:URL):SeriesEvidence {
  formatEcb(data,url);
  const s=data.structure,ds=data.dataSets[0],entries=Object.entries(ds.series) as [string,any][];
  check(entries.length===1,'definition_mismatch','ECB returned more than one series.');
  const [key,series]=entries[0],indexes=key.split(':').map(Number);
  const dims=Object.fromEntries(s.dimensions.series.map((d:any,i:number)=>[d.id,d.values[indexes[i]].id]));
  const decode=(defs:any[]=[],indices:any[]=[])=>Object.fromEntries(defs.flatMap((d:any,i:number)=>indices?.[i]==null?[]:[[d.id,String(d.values[indices[i]].id)]]));
  const attrs={...decode(s.attributes.dataSet,ds.attributes),...decode(s.attributes.series,series.attributes)};
  check(dims.REF_AREA==='U2'&&dims.FREQ==='D'&&dims.CURRENCY==='EUR'&&dims.PROVIDER_FM_ID==='DFR'&&dims.DATA_TYPE_FM==='LEV','definition_mismatch','ECB response does not identify the euro-area deposit-facility level.');
  check(attrs.UNIT==='PCPA'&&(attrs.UNIT_MULT??'0')==='0','unit_mismatch','ECB rate units are not unscaled percent per annum.');
  const times=s.dimensions.observation[0].values;
  return base('ECB','ecb_deposit_rate','EA',dims.FREQ,'percent_per_annum','not_applicable',{...dims,...attrs},Object.entries(series.observations).flatMap(([i,v]:[string,any])=>v[0]==null?[]:[{period:times[Number(i)].id,value:v[0],attributes:decode(s.attributes.observation,v.slice(1))}]),url);
}

export async function eiaObservationResponse(cache:LayeredCache,url:URL,p:any,meta:any,key?:string){
  return cache.getOrCompute(`eia:observations:v2:${url}`,3600,async()=>{
    const data=await requestEia(url,key);formatEiaData(data,url,p,meta);return {data,retrievedAt:new Date().toISOString()};
  });
}

export async function selectionEvidence(r:Retrieval,keys:Keys,cache:LayeredCache):Promise<SeriesEvidence> {
  const a=r.arguments,cacheKey=`selection:evidence:v2:${JSON.stringify(r)}`;
  return cache.getOrCompute(cacheKey,r.tool==='fred_get_series'?900:3600,async()=>{
    let e:SeriesEvidence;
    if(r.tool==='fred_get_series'){
      check(keys.FRED_KEY,'missing_key','FRED API key is not configured.');
      const url=(endpoint:string)=>new URL(`https://api.stlouisfed.org/fred/${endpoint}?series_id=${encodeURIComponent(a.series_id)}&file_type=json&api_key=${encodeURIComponent(keys.FRED_KEY!)}`);
      const obs=url('series/observations');obs.searchParams.set('units',a.units);obs.searchParams.set('limit',String(a.limit));obs.searchParams.set('sort_order','desc');
      const [info,data]=await Promise.all([checkedJson(url('series')),checkedJson(obs)]);e=parseFredEvidence(info,data,a);
    }else if(r.tool==='bls_get_series'){
      const body={seriesid:a.series_ids,startyear:a.start_year,endyear:a.end_year,calculations:true,catalog:true,...(keys.BLS_KEY?{registrationkey:keys.BLS_KEY}:{})};
      e=parseBlsEvidence(await checkedJson('https://api.bls.gov/publicAPI/v2/timeseries/data/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),a);
    }else if(r.tool==='bea_get_data'){
      check(keys.BEA_KEY,'missing_key','BEA API key is not configured.');
      const url=new URL('https://apps.bea.gov/api/data/');url.search=new URLSearchParams({method:'GetData',DataSetName:a.dataset,TableName:a.table_name,Frequency:a.frequency,Year:a.year,ResultFormat:'JSON'}).toString();
      const auth=new URL(url);auth.searchParams.set('UserID',keys.BEA_KEY!);e=parseBeaEvidence(await checkedJson(auth),a,url);
    }else if(r.tool==='oecd_get_data'||r.tool==='imf_get_data'){
      const oecd=r.tool==='oecd_get_data',p={datasetId:a.dataset_id,databaseId:a.database_id,seriesKey:a.series_key,limit:a.limit};
      const url=oecd?buildOecdDataUrl(p):buildImfDataUrl(p);
      const csv=oecd?await requestOecd(url):await(await fetchRetry(url,{headers:{Accept:'application/vnd.sdmx.data+csv;version=2.0.0'}})).text();
      e=parseCpiCsv(oecd?'OECD':'IMF',csv,a.series_key,url);
    }else if(r.tool==='bis_get_data'){
      const structureUrl=buildBisStructureUrl(a.dataset_id);
      const xml=await cache.getOrCompute(`bis:structure:v1:${structureUrl}`,7*86400,async()=>{const xml=await requestBis(structureUrl);getBisDefinition(xml,a.dataset_id);return xml;});
      const def=getBisDefinition(xml,a.dataset_id),p={datasetId:a.dataset_id,seriesKey:a.series_key,limit:a.limit,version:def.version};
      validateBisKey(def,p.seriesKey);const url=buildBisDataUrl(p);e=parseBisEvidence(await requestBis(url),url,p,def);
    }else if(r.tool==='eurostat_get_data'){
      const p={datasetId:a.dataset_id,filters:a.filters,limit:a.limit},su=buildEurostatStructureUrl(p.datasetId);
      const xml=await cache.getOrCompute(`eurostat:structure:v1:${su}`,86400,()=>requestEurostat(su));validateEurostatFilters(xml,p);
      const url=buildEurostatDataUrl(p);e=parseEurostatEvidence(JSON.parse(await requestEurostat(url)),url,p);
    }else if(r.tool==='eia_get_data'){
      check(keys.EIA_KEY,'missing_key','EIA API key is not configured.');
      const p={route:a.route,frequency:a.frequency,fields:a.data_fields,facets:a.facets,length:a.length},mu=buildEiaMetadataUrl(p.route);
      const meta=await cache.getOrCompute(`eia:metadata:v1:${mu}`,86400,()=>requestEia(mu,keys.EIA_KEY));validateEiaSelection(meta,p);
      const url=buildEiaDataUrl(p),response=await eiaObservationResponse(cache,url,p,meta,keys.EIA_KEY);e=parseEiaEvidence(response.data,url,p,meta);e.retrievedAt=response.retrievedAt;
    }else if(r.tool==='worldbank_get_data'){
      const p={countryCodes:a.country_codes,indicator:a.indicator,startYear:a.start_year,endYear:a.end_year},url=worldBankUrl(p);
      const mu=new URL(`https://api.worldbank.org/v2/indicator/${p.indicator}?format=json&source=2&per_page=100`);
      const meta=await cache.getOrCompute(`worldbank:definition:v3:${mu}`,7*86400,async()=>{const result=await worldBankPages(mu),d=result.rows.find((r:any)=>r.id===p.indicator);check(d,'definition_unconfirmed','WDI indicator metadata is missing.');return d;});
      e=parseWorldBankEvidence(await worldBankPages(url),meta,url,p);
    }else if(r.tool==='ecb_get_data'){
      const url=ecbUrl({flowRef:a.flow_ref,key:a.key,startPeriod:a.start_period});e=parseEcbEvidence(await checkedJson(url,{headers:{Accept:'application/json'}}),url);
    }else throw new Error('No structured evidence adapter for this tool.');
    check(e.observations.length,'no_data','Provider returned no numeric observations for the requested transformation.');
    return finishEvidence(e,a.limit??a.length??120);
  });
}
