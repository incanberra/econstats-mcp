import {parse} from 'csv-parse/sync';
import {type LayeredCache} from './cache';
import {checkedJson,worldBankPages,worldBankUrl,formatWorldBank,ecbUrl,formatEcb} from './legacy';
import {fetchRetry} from './http';
import {buildImfDataUrl,formatImfCsv} from './imf';
import {buildOecdDataUrl,buildOecdStructureUrl,requestOecd,formatOecdCsv} from './oecd';
import {buildBisDataUrl,buildBisStructureUrl,getBisDefinition,validateBisKey,formatBisCsv,requestBis} from './bis';
import {buildEurostatDataUrl,buildEurostatStructureUrl,validateEurostatFilters,formatEurostatJson,requestEurostat} from './eurostat';
import {buildEiaDataUrl,buildEiaMetadataUrl,validateEiaSelection,formatEiaData,requestEia} from './eia';
import {buildAbsDataUrl,buildAbsStructureUrl,parseAbsCsv,requestAbs,sdmxDefinition,validateSdmxKey,type SdmxDefinition} from './abs';
import {attributes,dataSeries,observation,finishResult,type DataResult,type DataSeries} from './result';
import type {Provider} from './access';
import type {Retrieval} from './selection';
import {fetchComtradeData,validateComtradeData,type ComtradeDataParams} from './comtrade';
import {AccessError} from './access';

export type Keys={FRED_KEY?:string;BLS_KEY?:string;BEA_KEY?:string;EIA_KEY?:string;COMTRADE_KEY?:string};
function requireKey(key:string|undefined,provider:string):asserts key is string {if(!key)throw new Error(`${provider} API key is not configured.`);}
function multiplier(a:Record<string,string>):number|null {const value=a.UNIT_MULT??a.SCALE;return value!==undefined&&value!==''?Number(value):null;}
function applyMetadata(s:DataSeries){
  const a={...s.dimensions,...s.attributes};s.frequency=a.FREQ??a.FREQUENCY??a.freq??s.frequency;
  s.unit=a.UNIT_MEASURE??a.UNIT??a.unit??s.unit;s.unitMultiplier=multiplier(a);
  s.adjustment=a.S_ADJUSTMENT??a.ADJUSTMENT??a.s_adj??a.SEASONAL_ADJUSTMENT??s.adjustment;
}
export function parseSdmxCsv(source:Provider,csv:string,url:URL,query:Record<string,unknown>,def:SdmxDefinition,key:string,retrievedAt:string,limit=36):DataResult {
  const header=parse(csv,{bom:true,to:1})[0] as string[];
  if(!header?.includes('TIME_PERIOD')||!header.includes('OBS_VALUE')||new Set(header).size!==header.length||!def.dimensions.every(d=>header.includes(d.id)))throw new Error('Invalid SDMX observation columns.');
  const rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true}) as Record<string,string>[];
  const dims=def.dimensions.map(d=>d.id),selected=key.split('.').map(k=>k.split('+'));
  const attrs=header.filter(k=>/^[A-Z][A-Z0-9_]*$/.test(k)&&!dims.includes(k)&&!['TIME_PERIOD','OBS_VALUE','DATAFLOW','STRUCTURE','STRUCTURE_ID','ACTION'].includes(k));
  const groups=new Map<string,DataSeries>();
  for(const r of rows){
    if(dims.some((d,i)=>!selected[i]?.includes(r[d])))throw new Error('Provider returned an unrequested SDMX series.');
    if(r.DATAFLOW&&r.DATAFLOW!==`${def.agency}:${def.id}(${def.version})`)throw new Error('Provider returned a different SDMX dataflow/version.');
    const id=dims.map(d=>r[d]).join('.');
    if(!groups.has(id))groups.set(id,dataSeries(`${def.agency}:${def.id}(${def.version})`,attributes(r,dims),url,{labels:Object.fromEntries(def.dimensions.map(d=>[d.id,d.codes.find(c=>c.code===r[d.id])?.label??r[d.id]])),notes:[def.label,...def.notes]}));
    groups.get(id)!.observations.push(observation(r.TIME_PERIOD,r.OBS_VALUE,attributes(r,attrs)));
  }
  for(const s of groups.values()){
    const a=s.observations[0]?.attributes??{};
    for(const k of ['UNIT','UNIT_MEASURE','UNIT_MULT','BASE_PER','BASE_PERIOD'])if(new Set(s.observations.map(o=>o.attributes[k]??'')).size>1)throw new Error(`Inconsistent ${k} within series.`);
    s.attributes=Object.fromEntries(attrs.filter(k=>!k.startsWith('OBS_')&&a[k]!==undefined&&s.observations.every(o=>o.attributes[k]===a[k])).map(k=>[k,a[k]]));applyMetadata(s);
  }
  return finishResult(source,query,[...groups.values()],retrievedAt,limit,['Native provider units and transformations retained; no definition was inferred from the requested tool name.']);
}
export function parseFredData(info:any,data:any,a:any,url:URL,retrievedAt:string):DataResult {
  const meta=info.seriess?.[0];if(info.seriess?.length!==1||meta?.id!==a.series_id||!Array.isArray(data.observations)||data.units!==(a.units??'lin'))throw new Error('Missing or unexpected FRED metadata/observations/transformation.');
  const units=a.units??'lin',transforms:Record<string,string>={lin:'level',pc1:'yoy_percent_change',pch:'period_percent_change',ch1:'year_ago_change',chg:'period_change'};
  if(!transforms[units])throw new Error('Invalid FRED transformation.');
  const s=dataSeries(a.series_id,{series_id:a.series_id},url,{frequency:meta.frequency??null,unit:['pc1','pch'].includes(units)?'percent':meta.units??null,unitMultiplier:['pc1','pch'].includes(units)?0:null,adjustment:meta.seasonal_adjustment??'not_reported',transformation:transforms[units],attributes:attributes(meta,['title','units','frequency','seasonal_adjustment','last_updated','notes']),notes:['FRED is a redistribution service. Native unit labels may already contain scaling; no numeric rescaling was applied.']});
  s.observations=data.observations.map((r:any)=>observation(r.date,r.value,attributes(r,['realtime_start','realtime_end'])));
  return finishResult('FRED',a,[s],retrievedAt,a.limit??36,[],meta.last_updated??null);
}
export function parseBlsData(data:any,a:any,retrievedAt:string):DataResult {
  if(data.status!=='REQUEST_SUCCEEDED'||!Array.isArray(data.Results?.series))throw new Error('BLS rejected the query or returned invalid data.');
  const series:DataSeries[]=data.Results.series.map((r:any)=>{
    if(!a.series_ids.includes(r.seriesID)||!Array.isArray(r.data))throw new Error('Unexpected BLS series.');
    const catalog=r.catalog??{},s=dataSeries(r.seriesID,{series_id:r.seriesID},`https://data.bls.gov/timeseries/${r.seriesID}`,{unit:catalog.unit??catalog.units??null,frequency:catalog.periodicity_code??null,adjustment:catalog.seasonality??'not_reported',attributes:attributes(catalog,Object.keys(catalog)),notes:['Values are native reported levels. Returned percentage/net calculations are preserved in observation attributes; use select_source for verified derived measures. A measure_data_type label is not a physical unit. Missing units or adjustment are not inferred from a series ID.']});
    for(const row of r.data){
      const monthly=/^M(0[1-9]|1[0-2])$/.test(row.period),annual=row.period==='M13';
      if(!/^\d{4}$/.test(row.year)||(!monthly&&!annual))throw new Error('Unsupported BLS observation frequency.');
      // Annual averages remain separate series, never a thirteenth month.
      if(annual)continue;
      s.observations.push(observation(`${row.year}-${row.period.slice(1)}`,row.value,{...attributes(row,['latest']),...(row.footnotes?{footnotes:JSON.stringify(row.footnotes)}:{}),...(row.calculations?{calculations:JSON.stringify(row.calculations)}:{})}));
    }
    if(r.data.some((x:any)=>x.period==='M13'))s.notes.push('Annual-average M13 rows excluded from the monthly series.');return s;
  });
  return finishResult('BLS',a,series,retrievedAt,1200);
}
export function parseBeaData(data:any,a:any,url:URL,retrievedAt:string):DataResult {
  const result=data.BEAAPI?.Results;if(!Array.isArray(result?.Data)||result.Error)throw new Error('BEA rejected the query or omitted data.');
  const groups=new Map<string,DataSeries>();
  for(const r of result.Data){
    if(!r.TimePeriod)throw new Error('Missing BEA period.');
    const dimensionKeys=Object.keys(r).filter(k=>!['TimePeriod','DataValue','NoteRef','CL_UNIT','UNIT_MULT','METRIC_NAME'].includes(k));
    const dims=attributes(r,dimensionKeys),id=JSON.stringify(dims);if(!groups.has(id))groups.set(id,dataSeries(`${a.dataset}:${a.table_name}`,dims,url,{frequency:a.frequency,notes:[...(result.Notes??[]).map((n:any)=>String(n.NoteText??n.Note)), 'CL_UNIT, METRIC_NAME and UNIT_MULT are retained as reported. No table-heading scaling was substituted.']}));
    const s=groups.get(id)!,attrs=attributes(r,['CL_UNIT','UNIT_MULT','METRIC_NAME']);
    if(s.observations.length&&JSON.stringify(s.attributes)!==JSON.stringify(attrs))throw new Error('BEA line units changed.');
    s.attributes=attrs;s.unit=[r.CL_UNIT,r.METRIC_NAME].filter(Boolean).join('; ')||null;s.unitMultiplier=multiplier(attrs);
    s.observations.push(observation(r.TimePeriod,r.DataValue,attributes(r,['NoteRef'])));
  }
  return finishResult('BEA',a,[...groups.values()],retrievedAt,10000,[],null);
}
export function parseEurostatData(data:any,url:URL,p:any,retrievedAt:string):DataResult {
  formatEurostatJson(data,url,p);
  const ids:string[]=data.id,sizes:number[]=data.size,total=sizes.reduce((a,b)=>a*b,1);
  const dimensions=ids.map(id=>{const raw=data.dimension[id].category.index;return {id,codes:Array.isArray(raw)?raw:Object.entries(raw).sort((a:any,b:any)=>a[1]-b[1]).map(([k])=>k),labels:data.dimension[id].category.label??{}};});
  const groups=new Map<string,DataSeries>();
  for(let index=0;index<total;index++){
    let rem=index;const pos:number[]=[];for(let i=ids.length-1;i>=0;i--){pos[i]=rem%sizes[i];rem=Math.floor(rem/sizes[i]);}
    const dims=Object.fromEntries(dimensions.flatMap((d,i)=>d.id==='time'?[]:[[d.id,d.codes[pos[i]]]])),id=JSON.stringify(dims),period=dimensions.find(d=>d.id==='time')!.codes[pos[ids.indexOf('time')]];
    if(!groups.has(id)){const s=dataSeries(p.datasetId,dims,url,{labels:Object.fromEntries(dimensions.filter(d=>d.id!=='time').map(d=>[d.id,d.labels[dims[d.id]]??dims[d.id]])),notes:[String(data.label??''),String(data.extension?.description??'')]});applyMetadata(s);groups.set(id,s);}
    const status=typeof data.status==='string'?data.status:data.status?.[index];
    groups.get(id)!.observations.push(observation(period,data.value[index],status?{STATUS:String(status)}:{}));
  }
  return finishResult('EUROSTAT',p,[...groups.values()],retrievedAt,p.limit??36,[],data.updated??null);
}
export function parseEiaData(data:any,url:URL,p:any,meta:any,retrievedAt:string):DataResult {
  formatEiaData(data,url,p,meta);
  const groups=new Map<string,DataSeries>(),facets=(meta.facets??[]).map((x:any)=>x.id);
  for(const r of data.data){for(const field of p.fields){
    const dims={...attributes(r,facets),field},id=JSON.stringify(dims);
    const unit=r[`${field}-units`]??r.units??meta.data?.[field]?.units??null;
    if(!groups.has(id))groups.set(id,dataSeries(p.route,dims,url,{frequency:data.frequency??p.frequency,unit,notes:[String(meta.description??''),...( /outlook|aeo|steo/i.test(p.route)?['Outlook/projection route; values may include forecasts.']:[])]}));
    const s=groups.get(id)!;if(unit!==s.unit)throw new Error('EIA units changed within a series.');
    const attrs=attributes(r,Object.keys(r).filter(k=>!facets.includes(k)&&!p.fields.includes(k)&&k!=='period'));
    s.observations.push(observation(r.period,r[field],attrs));
  }}
  const result=finishResult('EIA',p,[...groups.values()],retrievedAt,5000,['length/offset refer to rows, not observations per series; partial pages do not establish complete coverage.'],null,Number(data.total)>(p.offset??0)+data.data.length);if(Number.isFinite(Number(data.total)))result.coverage.upstreamTotalRows=Number(data.total);return result;
}
export function parseWorldBankData(page:any,meta:any,url:URL,p:any,retrievedAt:string):DataResult {
  formatWorldBank(page.rows,meta,url,page.updated,page.pages);const groups=new Map<string,DataSeries>();
  for(const r of page.rows){const country=r.countryiso3code||r.country.id;if(!groups.has(country))groups.set(country,dataSeries(`WDI:2:${p.indicator}`,{country,indicator:p.indicator},url,{frequency:'annual',unit:meta.unit||null,labels:{country:r.country.value,indicator:meta.name},attributes:attributes(meta,['name','sourceNote','sourceOrganization']),notes:[`Complete download: ${page.pages} pages.`,String(meta.sourceNote??'')]}));groups.get(country)!.observations.push(observation(r.date,r.value,attributes(r,['obs_status','decimal','unit'])));}
  return finishResult('WORLD_BANK',p,[...groups.values()],retrievedAt,10000,[],page.updated??null);
}
export function parseEcbData(data:any,url:URL,p:any,retrievedAt:string):DataResult {
  formatEcb(data,url);const structure=data.structure,ds=data.dataSets[0],dims=structure.dimensions.series,times=structure.dimensions.observation[0].values,attrs=structure.attributes??{};
  const decode=(defs:any[]=[],indices:any[]=[])=>Object.fromEntries(defs.flatMap((d:any,i:number)=>indices[i]==null?[]:[[d.id,String(d.values[indices[i]].id)]]));
  const series=Object.entries(ds.series).map(([key,r]:[string,any])=>{
    const pos=key.split(':').map(Number),d=Object.fromEntries(dims.map((v:any,i:number)=>[v.id,v.values[pos[i]].id]));
    const s=dataSeries(p.flowRef,d,url,{labels:Object.fromEntries(dims.map((v:any,i:number)=>[v.id,v.values[pos[i]].name??v.values[pos[i]].id])),attributes:{...decode(attrs.dataSet,ds.attributes),...decode(attrs.series,r.attributes)}});applyMetadata(s);
    s.observations=Object.entries(r.observations).map(([i,v]:[string,any])=>observation(times[Number(i)].id,v[0],decode(attrs.observation,v.slice(1))));return s;
  });return finishResult('ECB',p,series,retrievedAt,10000);
}

export async function fetchStructured(r:Retrieval,keys:Keys,cache:LayeredCache,fresh=false):Promise<DataResult>{
  const a=r.arguments;
  if(r.tool==='comtrade_get_data'){
    const params=a as ComtradeDataParams;validateComtradeData(params);
    if(params.access_mode==='authenticated'&&!keys.COMTRADE_KEY)throw new AccessError('COMTRADE','missing_key','Set COMTRADE_API_KEY locally, or explicitly choose preview.');
    return cache.getOrCompute(`public:comtrade:v1:${JSON.stringify(params)}`,3600,()=>fetchComtradeData(params,keys.COMTRADE_KEY),fresh);
  }
  // Refresh bypasses observation caches, never local budgets/cooldowns. Metadata can be cached.
  const compute=async():Promise<DataResult>=>{
    if(r.tool==='abs_get_data'){
      const p={datasetId:a.dataset_id,version:a.version,seriesKey:a.series_key,startPeriod:a.start_period,endPeriod:a.end_period,limit:a.limit};buildAbsDataUrl(p);
      const su=buildAbsStructureUrl(p.datasetId,p.version),xml=await cache.getOrCompute(`abs:structure:v1:${su}`,86400,()=>requestAbs(su)),def=sdmxDefinition(xml,p.datasetId,'ABS',p.version);validateSdmxKey(def,p.seriesKey);
      const url=buildAbsDataUrl({...p,version:def.version}),csv=await requestAbs(url);return parseAbsCsv(csv,url,p,def,new Date().toISOString());
    }
    if(r.tool==='fred_get_series'){
      requireKey(keys.FRED_KEY,'FRED');if(!/^[A-Za-z0-9_]{1,100}$/.test(a.series_id)||!Number.isInteger(a.limit??36)||(a.limit??36)<1||(a.limit??36)>5000||!['lin','pc1','pch','ch1','chg'].includes(a.units??'lin'))throw new Error('Invalid FRED parameters.');
      const url=(endpoint:string)=>{const u=new URL(`https://api.stlouisfed.org/fred/${endpoint}`);u.search=new URLSearchParams({series_id:a.series_id,file_type:'json',api_key:keys.FRED_KEY!}).toString();return u;};
      const obs=url('series/observations');obs.searchParams.set('units',a.units??'lin');obs.searchParams.set('limit',String(a.limit??36));obs.searchParams.set('sort_order','desc');
      const [info,data]=await Promise.all([checkedJson(url('series')),checkedJson(obs)]);return parseFredData(info,data,a,new URL(`https://fred.stlouisfed.org/series/${a.series_id}`),new Date().toISOString());
    }
    if(r.tool==='bls_get_series'){
      const y=new Date().getUTCFullYear(),sy=a.start_year??String(y-3),ey=a.end_year??String(y);
      if(!Array.isArray(a.series_ids)||!a.series_ids.length||a.series_ids.length>50||a.series_ids.some((id:string)=>!/^[A-Za-z0-9]{8,35}$/.test(id))||!/^\d{4}$/.test(sy)||!/^\d{4}$/.test(ey)||Number(sy)>Number(ey))throw new Error('Invalid BLS parameters.');
      const body={seriesid:a.series_ids,startyear:sy,endyear:ey,calculations:true,catalog:true,...(keys.BLS_KEY?{registrationkey:keys.BLS_KEY}:{})};
      const data=await checkedJson('https://api.bls.gov/publicAPI/v2/timeseries/data/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return parseBlsData(data,{...a,start_year:sy,end_year:ey},new Date().toISOString());
    }
    if(r.tool==='bea_get_data'){
      requireKey(keys.BEA_KEY,'BEA');if(!['NIPA','Regional','GDPbyIndustry'].includes(a.dataset)||!/^[A-Za-z0-9_]{1,100}$/.test(a.table_name)||!['A','Q','M'].includes(a.frequency)||!/^(?:ALL|LAST5|\d{4}(?:,\d{4})*)$/.test(a.year??'LAST5'))throw new Error('Invalid BEA parameters.');
      // Existing tool supports TableName/Frequency only for NIPA. Do not pretend it supports the other APIs' required parameters.
      if(a.dataset!=='NIPA')throw new Error('Regional and GDPbyIndustry require provider-specific parameters not exposed by this tool. Use NIPA; those datasets are not supported by this interface.');
      const year=(a.year??'LAST5')==='LAST5'?Array.from({length:5},(_,i)=>new Date().getUTCFullYear()-i).join(','):a.year;
      const url=new URL('https://apps.bea.gov/api/data/');url.search=new URLSearchParams({method:'GetData',DataSetName:a.dataset,TableName:a.table_name,Frequency:a.frequency,Year:year,ResultFormat:'JSON'}).toString();const auth=new URL(url);auth.searchParams.set('UserID',keys.BEA_KEY);
      return parseBeaData(await checkedJson(auth),{...a,year},url,new Date().toISOString());
    }
    if(r.tool==='imf_get_data'||r.tool==='oecd_get_data'){
      const oecd=r.tool==='oecd_get_data',p={datasetId:a.dataset_id,databaseId:a.database_id,space:a.space,version:a.version,seriesKey:a.series_key,countryCodes:a.country_codes,indicator:a.indicator,frequency:a.frequency,startPeriod:a.start_period,endPeriod:a.end_period,limit:a.limit};
      const url=oecd?buildOecdDataUrl(p):buildImfDataUrl(p),flow=url.pathname.split('/data/')[1].split('/')[0].split(','),key=url.pathname.split('/').at(-1)!;
      const su=oecd?buildOecdStructureUrl(a.dataset_id,a.version,a.space):new URL(`https://api.imf.org/external/sdmx/2.1/dataflow/${flow[0]}/${flow[1]}/latest?references=all`);
      const xml=await cache.getOrCompute(`structured:definition:v1:${su}`,86400,async()=>oecd?requestOecd(su,true):(await(await fetchRetry(su,{headers:{Accept:'application/vnd.sdmx.structure+xml;version=2.1'}})).text()));
      const def=sdmxDefinition(xml,flow[1],flow[0],a.version);validateSdmxKey(def,key);
      const csv=oecd?await requestOecd(url):await(await fetchRetry(url,{headers:{Accept:'application/vnd.sdmx.data+csv;version=2.0.0'}})).text();
      if(oecd)formatOecdCsv(csv,url,a.limit);else formatImfCsv(csv,url,a.limit);
      return parseSdmxCsv(oecd?'OECD':'IMF',csv,url,a,def,key,new Date().toISOString(),a.limit??36);
    }
    if(r.tool==='bis_get_data'){
      const p={datasetId:a.dataset_id,version:a.version,seriesKey:a.series_key,startPeriod:a.start_period,endPeriod:a.end_period,limit:a.limit};buildBisDataUrl(p);
      const su=buildBisStructureUrl(p.datasetId,p.version),xml=await cache.getOrCompute(`bis:structure:v1:${su}`,604800,()=>requestBis(su));const d=getBisDefinition(xml,p.datasetId,p.version);validateBisKey(d,p.seriesKey);
      const url=buildBisDataUrl({...p,version:d.version}),csv=await requestBis(url);formatBisCsv(csv,url,p,d);
      return parseSdmxCsv('BIS',csv,url,a,{id:d.id,agency:'BIS',version:d.version,label:d.label,notes:[d.description],attributeIds:d.attributes,dimensions:d.dimensions},p.seriesKey,new Date().toISOString(),p.limit??36);
    }
    if(r.tool==='eurostat_get_data'){
      const p={datasetId:a.dataset_id,filters:a.filters,startPeriod:a.start_period,endPeriod:a.end_period,limit:a.limit},url=buildEurostatDataUrl(p),su=buildEurostatStructureUrl(p.datasetId);
      const xml=await cache.getOrCompute(`eurostat:structure:v1:${su}`,86400,()=>requestEurostat(su));validateEurostatFilters(xml,p);return parseEurostatData(JSON.parse(await requestEurostat(url)),url,p,new Date().toISOString());
    }
    if(r.tool==='eia_get_data'){
      requireKey(keys.EIA_KEY,'EIA');const p={route:a.route,frequency:a.frequency,fields:a.data_fields,facets:a.facets,startPeriod:a.start_period,endPeriod:a.end_period,length:a.length??120,offset:a.offset??0},url=buildEiaDataUrl(p),su=buildEiaMetadataUrl(p.route);
      const meta=await cache.getOrCompute(`eia:metadata:v1:${su}`,86400,()=>requestEia(su,keys.EIA_KEY));validateEiaSelection(meta,p);return parseEiaData(await requestEia(url,keys.EIA_KEY),url,p,meta,new Date().toISOString());
    }
    if(r.tool==='worldbank_get_data'){
      const p={countryCodes:a.country_codes,indicator:a.indicator,startYear:a.start_year,endYear:a.end_year},url=worldBankUrl(p),su=new URL(`https://api.worldbank.org/v2/indicator/${p.indicator}?format=json&source=2&per_page=100`);
      const meta=await cache.getOrCompute(`worldbank:definition:v3:${su}`,604800,async()=>{const page=await worldBankPages(su),m=page.rows.find((x:any)=>x.id===p.indicator);if(!m)throw new Error('WDI indicator metadata is missing.');return m;});
      return parseWorldBankData(await worldBankPages(url),meta,url,p,new Date().toISOString());
    }
    if(r.tool==='ecb_get_data'){
      const p={flowRef:a.flow_ref,key:a.key,startPeriod:a.start_period,endPeriod:a.end_period},url=ecbUrl(p);return parseEcbData(await checkedJson(url,{headers:{Accept:'application/json'}}),url,p,new Date().toISOString());
    }
    throw new Error('Unsupported structured data tool.');
  };
  const ttl=r.tool==='fred_get_series'?900:3600;
  return cache.getOrCompute(`public:data:v1:${JSON.stringify(r)}:${r.tool==='bea_get_data'||r.tool==='bls_get_series'||r.tool==='worldbank_get_data'?new Date().getUTCFullYear():''}`,ttl,compute,fresh);
}
