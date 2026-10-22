import {parse} from 'csv-parse/sync';
import {attributes,dataSeries,observation,finishResult,type DataResult,type DataSeries} from './result';
import type {SdmxDefinition} from './abs';
import type {Provider} from './access';
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
    if([r.DATAFLOW,r.STRUCTURE_ID].some(v=>v&&v!==`${def.agency}:${def.id}(${def.version})`))throw new Error('Provider returned a different SDMX dataflow/version.');
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
