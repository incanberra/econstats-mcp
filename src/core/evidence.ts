import type {Measure,Source} from './selection';

export type Frequency='daily'|'weekly'|'monthly'|'quarterly'|'annual';
export type Adjustment='NSA'|'SA'|'SCA'|'not_applicable'|'not_reported';
export interface Observation {period:string;value:number;attributes?:Record<string,string>}
export interface SeriesEvidence {
  source:Source;measure:Measure;country:string;frequency:Frequency;
  unit:string;unitMultiplier:number;adjustment:Adjustment;transformation:string;
  dimensions:Record<string,string>;observations:Observation[];
  urls:string[];retrievedAt:string;notes:string[];
}
export class VerificationError extends Error {
  constructor(public reason:string,message:string){super(message);}
}
export function requireEvidence(condition:unknown,reason:string,message:string):asserts condition {
  if(!condition)throw new VerificationError(reason,message);
}
export function numeric(value:unknown):number|undefined {
  if(value===null||value===undefined||['','.','-','--','---','NA'].includes(String(value).trim()))return undefined;
  requireEvidence(typeof value==='number'||typeof value==='string','invalid_response','Expected a numeric observation.');
  const s=String(value).replace(/,/g,'');
  requireEvidence(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)&&Number.isFinite(Number(s)),'invalid_response','Invalid numeric observation.');
  return Number(s);
}
export function frequency(code:string):Frequency {
  const f:Record<string,Frequency>={D:'daily',W:'weekly',M:'monthly',Q:'quarterly',A:'annual',daily:'daily',weekly:'weekly',monthly:'monthly',quarterly:'quarterly',annual:'annual'};
  requireEvidence(f[code],'frequency_mismatch','Unsupported or missing frequency in provider metadata.');return f[code];
}
export function canonicalPeriod(raw:string,f:Frequency):string {
  const p=String(raw).replace(/^(\d{4})Q/,'$1-Q').replace('-M','-');
  // FRED dates identify the start of a period. Only aggregate when its metadata
  // explicitly reports that frequency; daily observations must never pass as monthly.
  if(/^\d{4}-\d{2}-\d{2}$/.test(p)){
    const date=new Date(`${p}T00:00:00Z`);
    requireEvidence(Number.isFinite(+date)&&date.toISOString().slice(0,10)===p,'invalid_period','Invalid calendar date.');
    if(f==='daily'||f==='weekly')return p;
    requireEvidence(p.endsWith('-01'),'frequency_mismatch','Expected a period-start observation date.');
    if(f==='monthly')return p.slice(0,7);
    if(f==='quarterly'){
      requireEvidence([1,4,7,10].includes(date.getUTCMonth()+1),'frequency_mismatch','Quarterly dates must start a quarter.');
      return `${p.slice(0,4)}-Q${Math.floor(date.getUTCMonth()/3)+1}`;
    }
    requireEvidence(p.endsWith('-01-01'),'frequency_mismatch','Annual dates must start a year.');return p.slice(0,4);
  }
  const valid=f==='monthly'?/^\d{4}-(0[1-9]|1[0-2])$/:f==='quarterly'?/^\d{4}-Q[1-4]$/:f==='annual'?/^\d{4}$/:/$a/;
  requireEvidence(valid.test(p),'frequency_mismatch',`Observation period does not match ${f} frequency.`);return p;
}
export function finishEvidence(e:SeriesEvidence,limit=120):SeriesEvidence {
  requireEvidence(e.unit&&Number.isInteger(e.unitMultiplier),'unit_unconfirmed','Units or scaling could not be confirmed.');
  requireEvidence(typeof e.retrievedAt==='string'&&Number.isFinite(Date.parse(e.retrievedAt)),'missing_provenance','Original retrieval time is missing.');
  const obs=new Map<string,Observation>();
  for(const o of e.observations){
    requireEvidence(typeof o.value==='number'&&Number.isFinite(o.value),'invalid_response','Non-numeric observation.');
    const period=canonicalPeriod(o.period,e.frequency),next={...o,period},previous=obs.get(period);
    requireEvidence(!previous||JSON.stringify(previous)===JSON.stringify(next),'conflicting_observations','Duplicate period has conflicting values or flags.');obs.set(period,next);
  }
  requireEvidence(e.urls.length&&e.urls.every(u=>{try{const url=new URL(u);return url.protocol==='https:'&&![...url.searchParams.keys()].some(k=>/api_key|userid|registrationkey/i.test(k));}catch{return false;}}),'missing_provenance','Expected credential-free source citations.');
  return {...e,observations:[...obs.values()].sort((a,b)=>a.period.localeCompare(b.period)).slice(-limit)};
}
export function expectedTransformation(measure:Measure):string {
  return /cpi.*yoy|hicp_yoy/.test(measure)?'yoy_percent_change':measure==='real_gdp_growth_annualized'?'qoq_annualized_percent_change':measure==='real_gdp_growth_qoq'?'qoq_percent_change':measure==='nonfarm_jobs_change'?'period_change':'level';
}
export function expectedAdjustment(measure:Measure):Adjustment|undefined {
  return /cpi.*yoy|hicp_yoy/.test(measure)?'NSA':/real_gdp/.test(measure)?measure==='real_gdp_growth_qoq'?'SCA':'SA':/unemployment_rate|nonfarm_jobs_change/.test(measure)?'SA':undefined;
}
export function comparisonSignature(e:SeriesEvidence):string {
  return JSON.stringify([e.measure,e.frequency,e.unit,e.unitMultiplier,e.adjustment,e.transformation]);
}
