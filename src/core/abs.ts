import {rankCatalogue} from './catalogue-search';
import {XMLParser} from 'fast-xml-parser';
import {parse} from 'csv-parse/sync';
import {providerFetch} from './access';
import {attributes,dataSeries,observation,finishResult,type DataResult} from './result';

export const ABS_BASE='https://data.api.abs.gov.au/rest';
export const ABS_CATALOG_URL=`${ABS_BASE}/dataflow/ABS/all/latest?references=none`;
export interface AbsDataParams {datasetId:string;version?:string;seriesKey:string;startPeriod?:string;endPeriod?:string;limit?:number}
export const list=(v:any):any[]=>v==null?[]:Array.isArray(v)?v:[v];
export function english(v:any,field='Name'):string {const names=list(v?.[field]),n=names.find(n=>n.lang==='en')??names[0];return typeof n==='string'?n:String(n?.['#text']??'');}
export function sdmxStructures(xml:string):any {
  if(xml.length>20_000_000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Unsafe or oversized SDMX metadata.');
  const structures=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'',removeNSPrefix:true,processEntities:false,parseTagValue:false}).parse(xml).Structure?.Structures;
  if(!structures)throw new Error('Unexpected SDMX metadata response.');return structures;
}
export interface SdmxDefinition {id:string;agency:string;version:string;label:string;notes:string[];attributeIds:string[];dimensions:{id:string;label:string;codes:{code:string;label:string}[]}[]}
export function sdmxDefinition(xml:string,id:string,agency:string,version='latest'):SdmxDefinition {
  const s=sdmxStructures(xml),flow=list(s.Dataflows?.Dataflow).find(f=>f.id===id&&f.agencyID===agency&&(version==='latest'||f.version===version));
  const ref=flow?.Structure?.Ref,dsd=list(s.DataStructures?.DataStructure).find(d=>d.id===ref?.id&&d.agencyID===ref?.agencyID&&(!ref?.version||String(d.version)===String(ref.version)));
  if(!flow||!dsd)throw new Error('Requested dataflow and referenced structure are missing.');
  const dimensions=list(dsd.DataStructureComponents?.DimensionList?.Dimension).sort((a,b)=>Number(a.position)-Number(b.position)).map(d=>{
    const r=d.ConceptIdentity?.Ref,scheme=list(s.Concepts?.ConceptScheme).find(c=>c.id===r?.maintainableParentID&&c.agencyID===r?.agencyID&&(!r?.maintainableParentVersion||c.version===r.maintainableParentVersion));
    const concept=list(scheme?.Concept).find(c=>c.id===r?.id),e=d.LocalRepresentation?.Enumeration?.Ref??concept?.CoreRepresentation?.Enumeration?.Ref;
    const cl=list(s.Codelists?.Codelist).find(c=>c.id===e?.id&&c.agencyID===e?.agencyID&&(!e?.version||c.version===e.version));
    return {id:String(d.id),label:english(concept),codes:list(cl?.Code).map(c=>({code:String(c.id),label:english(c)}))};
  });
  if(!dimensions.length||new Set(dimensions.map(d=>d.id)).size!==dimensions.length||dimensions.some(d=>!d.codes.length||new Set(d.codes.map(c=>c.code)).size!==d.codes.length))throw new Error('Missing or duplicate SDMX dimensions/codelists.');
  const notes=[english(flow,'Description'),...list(flow.Annotations?.Annotation).map(a=>[a.AnnotationType,english(a,'AnnotationText'),a.AnnotationTitle,a.AnnotationURL].filter(Boolean).join(': '))].filter(Boolean);
  return {id,agency,version:String(flow.version),label:english(flow),notes,dimensions,attributeIds:list(dsd.DataStructureComponents?.AttributeList?.Attribute).map(a=>a.id)};
}
function dataset(id:string,version='latest') {
  if(!/^[A-Z][A-Z0-9_]{0,79}$/.test(id)||!/^(?:latest|\d+(?:\.\d+){0,2})$/.test(version))throw new Error('Use an ABS dataset ID and version from discovery.');return {id,version};
}
export function buildAbsStructureUrl(id:string,version?:string):URL {const d=dataset(id,version);return new URL(`${ABS_BASE}/dataflow/ABS/${d.id}/${d.version}?references=all`);}
export function buildAbsDataUrl(p:AbsDataParams):URL {
  const d=dataset(p.datasetId,p.version),limit=p.limit??36;
  if(!Number.isInteger(limit)||limit<1||limit>120||p.seriesKey.length>1000||!p.seriesKey.split('.').every(k=>/^[A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)*$/.test(k))||p.seriesKey.split('.').reduce((n,k)=>n*k.split('+').length,1)>50)throw new Error('Specify every ABS dimension explicitly, at most 50 series and limit 1-120.');
  for(const t of [p.startPeriod,p.endPeriod])if(t&&!/^\d{4}(?:-(?:0[1-9]|1[0-2]|Q[1-4]))?$/.test(t))throw new Error('Use YYYY, YYYY-MM or YYYY-Qq.');
  if(p.startPeriod&&p.endPeriod&&p.startPeriod>p.endPeriod)throw new Error('start_period must not be after end_period.');
  const u=new URL(`${ABS_BASE}/data/ABS,${d.id}${d.version==='latest'?'':','+d.version}/${p.seriesKey}`);
  u.searchParams.set('dimensionAtObservation','AllDimensions');
  if(p.startPeriod)u.searchParams.set('startPeriod',p.startPeriod);if(p.endPeriod)u.searchParams.set('endPeriod',p.endPeriod);
  u.searchParams.set('lastNObservations',String(limit));return u;
}
export function validateSdmxKey(def:SdmxDefinition,key:string){
  const parts=key.split('.');if(parts.length!==def.dimensions.length)throw new Error(`Key requires ${def.dimensions.map(d=>d.id).join('.')} in this order.`);
  def.dimensions.forEach((d,i)=>{for(const code of parts[i].split('+'))if(!d.codes.some(c=>c.code===code))throw new Error(`Unknown ${d.id} code ${code}; inspect dataset structure.`);});
}
export function absCatalogue(xml:string,query='',offset=0,limit=20){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid catalogue pagination.');
  const flows=rankCatalogue(list(sdmxStructures(xml).Dataflows?.Dataflow).filter(f=>f.agencyID==='ABS'),query,f=>({id:f.id,name:english(f)}));
  return {source:'ABS',url:ABS_CATALOG_URL,total:flows.length,offset,datasets:flows.slice(offset,offset+limit).map(f=>({id:f.id,version:String(f.version),label:english(f)})),notes:['Catalogue codes do not guarantee current data coverage. Inspect structure before retrieval.']};
}
export function absStructure(xml:string,id:string,version?:string,dimensionId?:string,query='',offset=0,limit=50){
  const d=sdmxDefinition(xml,id,'ABS',version);if(dimensionId&&!d.dimensions.some(x=>x.id===dimensionId))throw new Error('Unknown ABS dimension.');
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid code pagination.');
  const words=query.toLowerCase().split(/\s+/).filter(Boolean);
  return {...d,dimensionOrder:d.dimensions.map(x=>x.id),dimensions:d.dimensions.filter(x=>!dimensionId||x.id===dimensionId).map(x=>{const codes=x.codes.filter(c=>words.every(t=>`${c.code} ${c.label}`.toLowerCase().includes(t)));return {...x,codes:codes.slice(offset,offset+limit),totalCodes:codes.length,offset};}),url:String(buildAbsStructureUrl(id,version))};
}
export async function requestAbs(url:string|URL):Promise<string>{
  const accept=new URL(url).pathname.includes('/data/')?'application/vnd.sdmx.data+csv;file=true;labels=id':'application/vnd.sdmx.structure+xml;version=2.1';
  const r=await providerFetch(url,{headers:{Accept:accept},signal:AbortSignal.timeout(45000)});
  if(!r.ok)throw new Error(`ABS API HTTP ${r.status}; check dataset, codes and availability.`);
  const text=await r.text();if(text.length>20_000_000)throw new Error('ABS response exceeds 20 MB; narrow the query.');return text;
}
export function parseAbsCsv(csv:string,url:URL,p:AbsDataParams,def:SdmxDefinition,retrievedAt:string):DataResult {
  const header=parse(csv,{bom:true,to:1})[0] as string[];
  if(!header?.includes('TIME_PERIOD')||!header.includes('OBS_VALUE')||new Set(header).size!==header.length||!def.dimensions.every(d=>header.includes(d.id)))throw new Error('Unexpected ABS CSV columns.');
  const rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true}) as Record<string,string>[],groups=new Map<string,ReturnType<typeof dataSeries>>();
  const dims=def.dimensions.map(d=>d.id),selected=p.seriesKey.split('.').map(k=>k.split('+'));
  const reserved=new Set([...dims,'TIME_PERIOD','OBS_VALUE','DATAFLOW','STRUCTURE','STRUCTURE_ID','ACTION']);
  const attrNames=header.filter(h=>/^[A-Z][A-Z0-9_]*$/.test(h)&&!reserved.has(h));
  for(const row of rows){
    if(dims.some((d,i)=>!selected[i]?.includes(row[d])))throw new Error('ABS returned unrequested dimension codes.');
    if(row.DATAFLOW&&row.DATAFLOW!==`ABS:${def.id}(${def.version})`)throw new Error('ABS returned a different dataflow.');
    const id=dims.map(d=>row[d]).join('.');
    if(!groups.has(id))groups.set(id,dataSeries(`${def.agency}:${def.id}(${def.version})`,attributes(row,dims),url,{labels:Object.fromEntries(def.dimensions.map(d=>[d.id,d.codes.find(c=>c.code===row[d.id])!.label])),notes:[def.label,...def.notes]}));
    groups.get(id)!.observations.push(observation(row.TIME_PERIOD,row.OBS_VALUE,attributes(row,attrNames)));
  }
  for(const s of groups.values()){
    for(const key of ['UNIT_MEASURE','UNIT_MULT','BASE_PER','BASE_PERIOD'])if(new Set(s.observations.map(o=>o.attributes[key]??'')).size>1)throw new Error(`ABS series has inconsistent ${key}.`);
    const a=s.observations[0]?.attributes??{};s.unit=a.UNIT_MEASURE??null;s.unitMultiplier=a.UNIT_MULT!==undefined&&a.UNIT_MULT!==''?Number(a.UNIT_MULT):null;
    s.adjustment=s.dimensions.TSEST==='10'?'NSA':s.dimensions.TSEST==='20'?'SA':s.dimensions.TSEST==='30'?'trend':'not_reported';
    s.attributes=Object.fromEntries(attrNames.filter(k=>!/^OBS_/.test(k)&&s.observations.every(o=>o.attributes[k]===a[k])&&a[k]!==undefined).map(k=>[k,a[k]]));
    s.transformation=s.labels.MEASURE??'as_reported';
  }
  return finishResult('ABS',p as unknown as Record<string,unknown>,[...groups.values()],retrievedAt,p.limit??36,['ABS Data API is a beta service. API freshness is not guaranteed; compare the latest period with the relevant publication. No unit conversion or annualisation was applied.']);
}
