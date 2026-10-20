import {Database} from 'bun:sqlite';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {AccessError,providerFetch} from './access';
import {FAOSTAT_DOMAINS,FAOSTAT_CATALOG,faostatSource,type FaostatDomain} from './faostat-catalog';
import {dataSeries,finishResult,observation,type DataSeries} from './result';

export interface FaostatParams {domain:FaostatDomain;area_codes:string[];item_codes:string[];element_codes:string[];start_year:number;end_year:number;limit?:number}
export function faostatDirectory(){return resolve(process.env.ECONSTATS_FAOSTAT_DIR??join(import.meta.dir,'../../faostat-data'));}
function snapshot(domain:FaostatDomain){
  if(!Object.hasOwn(FAOSTAT_DOMAINS,domain))throw new Error('Choose QCL, FBS, RFN or RFB.');
  const path=join(faostatDirectory(),domain+'.sqlite');
  if(!existsSync(path))throw new AccessError('FAOSTAT','unavailable','Public-data snapshot is not installed. Build it with bun run build:faostat or use the hosted Docker image. No API key is needed.');
  return new Database(path,{readonly:true});
}
function manifest(db:Database){const row=db.query('SELECT json FROM manifest').get() as {json:string}|null;const value=row?JSON.parse(row.json):null;if(value?.schemaVersion!==1)throw new Error('Invalid FAOSTAT snapshot manifest.');return value;}
export function faostatDomains(){
  return {source:'FAOSTAT',mode:'public_bulk_snapshot',domains:Object.entries(FAOSTAT_DOMAINS).map(([domain,definition])=>{
    if(!existsSync(join(faostatDirectory(),domain+'.sqlite')))return {domain,name:definition.name,installed:false,sourceUrl:faostatSource(domain as FaostatDomain)};
    const db=snapshot(domain as FaostatDomain);try{return {...manifest(db),installed:true};}finally{db.close();}
  }),notes:['Snapshots contain annual observations from 1990 onward, subject to domain coverage; FBS starts in 2010.','Data are refreshed when the snapshots/image are rebuilt, not during a tool call. fresh=true bypasses the result cache only.','Query FAOSTAT-native area, item and element codes; do not use ISO codes or Comtrade codes.','Food-balance values estimate availability and uses; they are not real-time inventories. Fertiliser nutrient tonnes differ from product tonnes.']};
}
export function faostatCodes(domain:FaostatDomain,dimension:'area'|'item'|'element',query='',offset=0,limit=30){
  if(!['area','item','element'].includes(dimension)||query.length>200||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid FAOSTAT codes query or pagination.');
  const db=snapshot(domain);try{
    const text=query.toLowerCase(),params=[dimension,text,text];
    const where='dimension=? AND (?=\'\' OR instr(lower(code||\' \'||label),?)>0)';
    return {domain,dimension,...manifest(db),total:(db.query(`SELECT count(*) AS n FROM codes WHERE ${where}`).get(...params) as {n:number}).n,offset,codes:db.query(`SELECT code,label FROM codes WHERE ${where} ORDER BY CAST(code AS INTEGER) LIMIT ? OFFSET ?`).all(...params,limit,offset),notes:['Codes describe the installed snapshot; a code does not guarantee every requested year has observations.']};
  }finally{db.close();}
}
export function validateFaostat(p:FaostatParams){
  if(!Object.hasOwn(FAOSTAT_DOMAINS,p.domain))throw new Error('Choose QCL, FBS, RFN or RFB.');
  for(const [codes,max] of [[p.area_codes,5],[p.item_codes,10],[p.element_codes,5]] as const)if(!Array.isArray(codes)||!codes.length||codes.length>max||codes.some(c=>typeof c!=='string'||!/^\d{1,7}$/.test(c)||String(Number(c))!==c)||new Set(codes).size!==codes.length)throw new Error('Choose unique native numeric codes from faostat_list_codes; no wildcards or leading zeroes.');
  if(!Number.isInteger(p.start_year)||!Number.isInteger(p.end_year)||p.start_year<1990||p.end_year>2100||p.end_year<p.start_year||p.end_year-p.start_year>40)throw new Error('Choose an ordered annual range from 1990 onward, at most 41 years.');
  if(p.area_codes.length*p.item_codes.length*p.element_codes.length>100)throw new Error('Select at most 100 area/item/element combinations.');
  if(!Number.isInteger(p.limit??1000)||(p.limit??1000)<1||(p.limit??1000)>5000)throw new Error('limit must be 1–5000 rows.');
}
export function fetchFaostat(p:FaostatParams){
  validateFaostat(p);const db=snapshot(p.domain);
  try{
    const meta=manifest(db),labels=new Map<string,string>();
    for(const [dimension,codes] of [['area',p.area_codes],['item',p.item_codes],['element',p.element_codes]] as const)for(const code of codes){const row=db.query('SELECT label FROM codes WHERE dimension=? AND code=?').get(dimension,code) as {label:string}|null;if(!row)throw new Error('Unknown FAOSTAT code for this snapshot. Discover codes first.');labels.set(dimension+':'+code,row.label);}
    const placeholders=(codes:string[])=>codes.map(()=>'?').join(','),rows=db.query(`SELECT * FROM observations WHERE area IN (${placeholders(p.area_codes)}) AND item IN (${placeholders(p.item_codes)}) AND element IN (${placeholders(p.element_codes)}) AND year BETWEEN ? AND ? ORDER BY area,item,element,year,unit LIMIT ?`).all(...p.area_codes.map(Number),...p.item_codes.map(Number),...p.element_codes.map(Number),p.start_year,p.end_year,(p.limit??1000)+1) as any[];
    const truncated=rows.length>(p.limit??1000),groups=new Map<string,DataSeries>();
    for(const row of rows.slice(0,p.limit??1000)){
      const dimensions={area:String(row.area),item:String(row.item),element:String(row.element),unit:row.unit},key=JSON.stringify(dimensions);
      if(!groups.has(key))groups.set(key,dataSeries(`FAOSTAT:${p.domain}`,dimensions,faostatSource(p.domain),{labels:{area:labels.get('area:'+row.area)!,item:labels.get('item:'+row.item)!,element:labels.get('element:'+row.element)!},frequency:'annual',unit:row.unit,unitMultiplier:0,notes:['Official bulk snapshot; native reported units and values retained without scaling.',`Snapshot downloaded ${meta.retrievedAt}; archive SHA-256 ${meta.sourceSha256}.`,'Reported output, agricultural area, yield, nutrient mass and product mass are different measures. Read element and unit labels.','FAOSTAT flags are retained verbatim; consult the source domain metadata for definitions.']}));
      groups.get(key)!.observations.push(observation(String(row.year),row.value,{...(row.flag?{flag:row.flag}:{}),...(row.note?{note:row.note}:{})}));
    }
    return finishResult('FAOSTAT',p as unknown as Record<string,unknown>,[...groups.values()],new Date().toISOString(),5000,[`Snapshot downloaded ${meta.retrievedAt}; upstream dataset updated ${meta.sourceUpdatedAt??'not reported'}. Rebuild snapshots to refresh data.`,`Installed coverage: ${meta.startYear}–${meta.endYear}; absent observations are not zero.`,`Snapshot is not refreshed by fresh=true.`,...(p.domain==='FBS'?['Food balance sheets describe estimated food availability and uses, not current inventories or actual individual intake.']:[])],meta.sourceUpdatedAt,truncated);
  }finally{db.close();}
}
export async function probeFaostat(){
  const domains=faostatDomains();if(domains.domains.some(d=>!d.installed))throw new AccessError('FAOSTAT','unavailable','One or more public snapshots are missing. Rebuild the hosted image.');
  const res=await providerFetch(FAOSTAT_CATALOG,{signal:AbortSignal.timeout(30000),redirect:'error'}),body:any=await res.json();if(!Array.isArray(body.Datasets?.Dataset))throw new AccessError('FAOSTAT','invalid_response','Invalid bulk catalogue.');
  const newer=domains.domains.filter((d:any)=>{const current=body.Datasets.Dataset.find((r:any)=>r.DatasetCode===d.domain);return current?.DateUpdate&&current.DateUpdate!==d.sourceUpdatedAt;}).map(d=>d.domain);
  return newer.length?`Snapshots installed; newer upstream releases exist for ${newer.join(', ')}. Rebuild to update.`:'Snapshots installed and catalogue release dates match. Coverage and current inventories are not implied.';
}
