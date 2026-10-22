import {AccessError,providerFetch} from './access';
import {type LayeredCache} from './cache';
import {attributes,dataSeries,finishResult,observation,type DataSeries} from './result';

const BASE='https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/';
export const PORTWATCH_DATASETS=['ports','chokepoints'] as const;
export type PortwatchDataset=typeof PORTWATCH_DATASETS[number];
const SERVICES={ports:{data:'Daily_Ports_Data',locations:'PortWatch_ports_database'},chokepoints:{data:'Daily_Chokepoints_Data',locations:'PortWatch_chokepoints_database'}};
const TYPES=['container','dry_bulk','general_cargo','roro','tanker','cargo'];
export const PORTWATCH_FIELDS={ports:['portcalls',...TYPES.map(t=>'portcalls_'+t),'import',...TYPES.map(t=>'import_'+t),'export',...TYPES.map(t=>'export_'+t)],chokepoints:['n_total',...TYPES.map(t=>'n_'+t),'capacity',...TYPES.map(t=>'capacity_'+t)]};
export interface PortwatchParams {dataset:PortwatchDataset;location_ids:string[];fields:string[];start_date:string;end_date:string;limit?:number}
export function portwatchUrl(dataset:PortwatchDataset,locations=false){
  if(!PORTWATCH_DATASETS.includes(dataset))throw new Error('Choose ports or chokepoints.');
  return new URL(`${BASE}${SERVICES[dataset][locations?'locations':'data']}/FeatureServer/0`);
}
export async function portwatchJson(url:URL){
  const response=await providerFetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
  const reader=response.body?.getReader();if(!reader)throw new AccessError('PORTWATCH','invalid_response','Empty response.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4_000_000)throw new Error('size');chunks.push(value);}}
  catch{await reader.cancel().catch(()=>{});throw new AccessError('PORTWATCH','invalid_response','Response exceeded its limit or could not be read. Narrow the query.');}
  let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new AccessError('PORTWATCH','invalid_response','Expected JSON.');}
  if(body.error)throw new AccessError('PORTWATCH','request_rejected','Upstream rejected this query. Inspect metadata and parameters.');return body;
}
function date(value:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Use valid YYYY-MM-DD dates.');return Date.parse(value);
}
export function validatePortwatch(p:PortwatchParams){
  portwatchUrl(p.dataset);
  const pattern=p.dataset==='ports'?/^port\d{1,6}$/:/^chokepoint\d{1,4}$/;
  if(!Array.isArray(p.location_ids)||!p.location_ids.length||p.location_ids.length>5||p.location_ids.some(id=>!pattern.test(id))||new Set(p.location_ids).size!==p.location_ids.length)throw new Error('Select 1–5 unique IDs from portwatch_list_locations.');
  if(!Array.isArray(p.fields)||!p.fields.length||p.fields.length>5||p.fields.some(f=>!PORTWATCH_FIELDS[p.dataset].includes(f))||new Set(p.fields).size!==p.fields.length)throw new Error('Select 1–5 unique fields from portwatch_get_metadata.');
  const start=date(p.start_date),end=date(p.end_date);
  if(start>end||end-start>366*86400000)throw new Error('Select an ordered date range of at most 367 days.');
  if(!Number.isInteger(p.limit??1000)||(p.limit??1000)<1||(p.limit??1000)>2000)throw new Error('limit must be 1–2000 rows.');
}
export function buildPortwatchDataUrl(p:PortwatchParams){
  validatePortwatch(p);const url=portwatchUrl(p.dataset);url.pathname+='/query';
  url.search=new URLSearchParams({f:'json',where:`portid IN (${p.location_ids.map(id=>`'${id}'`).join(',')}) AND date >= DATE '${p.start_date}' AND date <= DATE '${p.end_date}'`,outFields:['date','portid','portname',...(p.dataset==='ports'?['country','ISO3']:[]),...p.fields].join(','),returnGeometry:'false',orderByFields:'date ASC,portid ASC',resultRecordCount:String(p.limit??1000)}).toString();return url;
}
export async function portwatchMetadata(cache:LayeredCache,dataset:PortwatchDataset){
  const url=portwatchUrl(dataset);url.search='f=json';
  return cache.getOrCompute(`portwatch:metadata:v1:${dataset}`,3600,async()=>{
    const body=await portwatchJson(url);if(!Array.isArray(body.fields)||!body.fields.some((f:any)=>f.name==='date'))throw new Error('Missing PortWatch field definitions.');
    return {dataset,sourceUrl:String(url),retrievedAt:new Date().toISOString(),sourceUpdatedAt:body.editingInfo?.dataLastEditDate?new Date(body.editingInfo.dataLastEditDate).toISOString():null,fields:PORTWATCH_FIELDS[dataset].filter(f=>body.fields.some((v:any)=>v.name===f)).map(field=>({field,unit:field.startsWith('n_')||field.startsWith('portcalls')?'vessel calls':'metric tonnes',definition:field.startsWith('capacity')?'Sum of vessel deadweight capacity transiting the chokepoint; capacity is not measured cargo weight.':field.startsWith('import')||field.startsWith('export')?'AIS-derived estimated maritime shipment volume.':'AIS-derived vessel calls.'})),notes:['Discover location IDs with portwatch_list_locations. Daily observations may be revised; missing days are not zero.','Cargo and total fields overlap their component vessel types: do not add totals to components.','AIS reception, reporting and methodology affect coverage; this is not customs-verified product-level trade.']};
  });
}
export async function portwatchLocations(cache:LayeredCache,dataset:PortwatchDataset,query='',country?:string,offset=0,limit=30){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||query.length>200||country!==undefined&&!/^[A-Z]{3}$/.test(country))throw new Error('Invalid discovery query, ISO3 country or pagination.');
  const url=portwatchUrl(dataset,true);url.pathname+='/query';url.search=new URLSearchParams({f:'json',where:'1=1',outFields:'portid,portname,country,ISO3,lat,lon,LOCODE',returnGeometry:'false',orderByFields:'portid ASC',resultRecordCount:'1000'}).toString();
  const catalog=await cache.getOrCompute(`portwatch:locations:v1:${dataset}`,86400,async()=>{
    const rows:any[]=[],seen=new Set<string>();
    for(let page=0;page<5;page++){
      const pageUrl=new URL(url);pageUrl.searchParams.set('resultOffset',String(rows.length));const body=await portwatchJson(pageUrl);
      if(!Array.isArray(body.features)||body.features.length>1000)throw new Error('Incomplete PortWatch location catalogue.');
      for(const f of body.features){const r=f.attributes;if(!r?.portid||!r.portname||seen.has(r.portid))throw new Error('Incomplete PortWatch location catalogue.');seen.add(r.portid);rows.push(r);}
      if(!body.exceededTransferLimit)return {rows,retrievedAt:new Date().toISOString()};
      if(!body.features.length)break;
    }throw new Error('Incomplete PortWatch location catalogue.');
  });
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean),rows=catalog.rows.filter((r:any)=>(!country||r.ISO3===country)&&terms.every(t=>[r.portid,r.portname,r.country,r.LOCODE].join(' ').toLowerCase().includes(t)));
  return {dataset,sourceUrl:String(url),retrievedAt:catalog.retrievedAt,total:rows.length,offset,locations:rows.slice(offset,offset+limit),notes:['Catalogue presence does not establish date coverage.']};
}
export function parsePortwatch(body:any,p:PortwatchParams,url:URL,retrievedAt:string,updated:string|null){
  validatePortwatch(p);if(!Array.isArray(body.features)||body.features.length>(p.limit??1000))throw new Error('Invalid PortWatch observations.');
  const groups=new Map<string,DataSeries>();
  for(const feature of body.features){
    const r=feature.attributes;if(!r||!p.location_ids.includes(r.portid))throw new Error('Unrequested PortWatch location.');
    const day=typeof r.date==='number'?new Date(r.date).toISOString().slice(0,10):r.date;
    date(day);if(day<p.start_date||day>p.end_date)throw new Error('Unrequested PortWatch date.');
    for(const field of p.fields){
      if(!Object.hasOwn(r,field)||r[field]!==null&&(typeof r[field]!=='number'||!Number.isFinite(r[field])||r[field]<0))throw new Error('Invalid PortWatch value.');
      const key=r.portid+':'+field;
      if(!groups.has(key))groups.set(key,dataSeries(`portwatch:${p.dataset}`,{location_id:r.portid,field},url,{labels:{location_id:r.portname??r.portid},frequency:'daily',unit:field.startsWith('n_')||field.startsWith('portcalls')?'vessel calls':'metric tonnes',unitMultiplier:0,attributes:attributes(r,['country','ISO3']),notes:['AIS-derived daily observations; missing days are not zero.','Total and component vessel fields overlap.',...(field.startsWith('capacity')?['Chokepoint capacity is vessel deadweight capacity, not measured cargo tonnage.']:field.startsWith('import')||field.startsWith('export')?['Estimated maritime shipment volume, not customs trade values or all-mode trade.']:[])]}));
      groups.get(key)!.observations.push(observation(day,r[field]));
    }
  }
  return finishResult('PORTWATCH',p as unknown as Record<string,unknown>,[...groups.values()],retrievedAt,2000,['Daily values are estimates and can be revised. A partial page must not be treated as the complete date range.'],updated,body.exceededTransferLimit===true||body.features.length===(p.limit??1000));
}
export async function fetchPortwatch(cache:LayeredCache,p:PortwatchParams){
  const url=buildPortwatchDataUrl(p),meta=await portwatchMetadata(cache,p.dataset);
  if(p.fields.some(f=>!meta.fields.some((m:any)=>m.field===f)))throw new Error('Requested field is absent from current upstream metadata.');
  return parsePortwatch(await portwatchJson(url),p,url,new Date().toISOString(),meta.sourceUpdatedAt);
}
