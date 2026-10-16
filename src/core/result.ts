import {createHash} from 'node:crypto';
import {numeric} from './evidence';
import type {Provider} from './access';

export interface DataObservation {period:string;value:number|null;attributes:Record<string,string>}
export interface DataSeries {
  id:string;dataset:string;dimensions:Record<string,string>;labels:Record<string,string>;
  frequency:string|null;unit:string|null;unitMultiplier:number|null;adjustment:string;
  transformation:string;attributes:Record<string,string>;observations:DataObservation[];
  urls:string[];notes:string[];revision?:Record<string,unknown>;
}
export interface DataResult {
  schemaVersion:'1.0';source:Provider;retrievedAt:string;sourceUpdatedAt:string|null;
  query:Record<string,unknown>;series:DataSeries[];notes:string[];
  coverage:{returnedSeries:number;returnedObservations:number;missingValues:number;truncated:boolean;upstreamTotalRows?:number};
}
export function stable(value:any):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const attributes=(row:any,keys:string[])=>Object.fromEntries(keys.filter(k=>row[k]!==undefined&&row[k]!==null&&row[k]!=='').map(k=>[k,String(row[k])]));
export function safeUrl(raw:string|URL):string {
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||[...url.searchParams.keys()].some(k=>/key|token|userid|secret|password/i.test(k)))throw new Error('Expected a credential-free HTTPS citation.');
  return String(url);
}
export function seriesIdentity(source:Provider,s:Pick<DataSeries,'dataset'|'dimensions'|'transformation'>):string {
  return createHash('sha256').update(stable([source,s.dataset,s.dimensions,s.transformation])).digest('hex');
}
export function dataSeries(dataset:string,dimensions:Record<string,string>,url:string|URL,extra:Partial<DataSeries>={}):DataSeries {
  return {id:'',dataset,dimensions,labels:{},frequency:dimensions.FREQ??dimensions.freq??null,unit:null,unitMultiplier:null,
    adjustment:'not_reported',transformation:'as_reported',attributes:{},observations:[],urls:[safeUrl(url)],notes:[],...extra};
}
export function observation(period:string,value:unknown,attrs:Record<string,string>={}):DataObservation {
  if(!period||!/^\d{4}(?:-?(?:Q[1-4]|S[12]|M(?:0[1-9]|1[0-2])|(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?))?$/.test(period))throw new Error('Missing or unsupported observation period.');
  if(/^\d{4}-\d{2}-\d{2}$/.test(period)){
    const date=new Date(period+'T00:00:00Z');if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==period)throw new Error('Invalid calendar date.');
  }
  return {period,value:numeric(value)??null,attributes:attrs};
}
export function finishResult(source:Provider,query:Record<string,unknown>,series:DataSeries[],retrievedAt:string,limit=5000,notes:string[]=[],sourceUpdatedAt:string|null=null,truncated=false):DataResult {
  if(!Number.isFinite(Date.parse(retrievedAt))||!Number.isInteger(limit)||limit<1||limit>10000||series.length>250)throw new Error('Invalid provenance or result size.');
  const ids=new Set<string>();
  for(const s of series){
    s.id=seriesIdentity(source,s);if(ids.has(s.id))throw new Error('Duplicate structured series identity.');ids.add(s.id);
    if(s.unitMultiplier!==null&&!Number.isInteger(s.unitMultiplier))throw new Error('Invalid unit multiplier.');
    s.urls=s.urls.map(safeUrl);if(!s.urls.length)throw new Error('Missing source citation.');
    const obs=new Map<string,DataObservation>();
    for(const o of s.observations){
      if(o.value!==null&&(typeof o.value!=='number'||!Number.isFinite(o.value)))throw new Error('Non-numeric observation.');
      const old=obs.get(o.period);if(old&&stable(old)!==stable(o))throw new Error('Conflicting observations for the same series and period.');obs.set(o.period,o);
    }
    const sorted=[...obs.values()].sort((a,b)=>a.period.localeCompare(b.period));
    if(sorted.length>limit)truncated=true;s.observations=sorted.slice(-limit);
    if(!s.unit)s.notes.push('Unit not reported in the returned metadata; do not infer it.');
    if(s.unitMultiplier===null)s.notes.push('Unit multiplier not reported; no scaling was assumed.');
    s.notes=[...new Set(s.notes)];
  }
  const observations=series.flatMap(s=>s.observations);
  return {schemaVersion:'1.0',source,retrievedAt,sourceUpdatedAt,query,series,notes,coverage:{returnedSeries:series.length,returnedObservations:observations.length,missingValues:observations.filter(o=>o.value===null).length,truncated}};
}
export function renderResult(r:DataResult):string {
  return `${r.source}: ${r.coverage.returnedSeries} series; retrieved ${r.retrievedAt}; source updated ${r.sourceUpdatedAt??'not reported'}\n`+r.series.map(s=>
    `\nDataset: ${s.dataset}; series_id: ${s.id}\n${Object.entries(s.dimensions).map(([k,v])=>`${k}=${v}${s.labels[k]?` (${s.labels[k]})`:''}`).join(' | ')}\nUnit: ${s.unit??'not reported'}; UNIT_MULT=${s.unitMultiplier??'not reported'}; adjustment=${s.adjustment}; transformation=${s.transformation}\n`+
    s.observations.map(o=>`${o.period}: ${o.value===null?'missing':o.value}${Object.keys(o.attributes).length?' '+JSON.stringify(o.attributes):''}`).join('\n')+
    `\nSource: ${s.urls.join(' ; ')}\n${s.notes.join('\n')}${s.revision?'\nRevision tracking: '+JSON.stringify(s.revision):''}`).join('\n')+
    `\n${r.coverage.missingValues} missing values retained as null. Output truncated: ${r.coverage.truncated}.\n${r.notes.join('\n')}`;
}
