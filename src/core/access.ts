import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {atomicWrite,readStored,storageDirectory,storagePath,withFileLock} from "./storage";

export const PROVIDERS=["FRED","BLS","BEA","IMF","OECD","EUROSTAT","BIS","EIA","WORLD_BANK","ECB","ABS"] as const;
export type Provider=typeof PROVIDERS[number];
export type AccessKind="healthy"|"missing_key"|"rejected_key"|"rate_limited"|"budget_exhausted"|"unavailable"|"request_rejected"|"invalid_response"|"not_checked";
export class AccessError extends Error {
  constructor(public provider:Provider,public kind:AccessKind,message:string){super(`${provider==="EUROSTAT"?"Eurostat":provider==="WORLD_BANK"?"World Bank":provider} ${kind.replaceAll("_"," ")}: ${message}`);}
}
type State={started:number;used:number;blockedUntil:number;status:AccessKind;checkedAt?:string;lastSuccess?:string;httpStatus?:number};
export function providerFor(url:URL):Provider {
  const hosts:Record<string,Provider>={"api.stlouisfed.org":"FRED","api.bls.gov":"BLS","apps.bea.gov":"BEA","api.imf.org":"IMF","sdmx.oecd.org":"OECD","ec.europa.eu":"EUROSTAT","stats.bis.org":"BIS","api.eia.gov":"EIA","api.worldbank.org":"WORLD_BANK","data-api.ecb.europa.eu":"ECB"};
  hosts['data.api.abs.gov.au']='ABS';
  const provider=hosts[url.hostname];if(!provider)throw new Error("Unsupported economic API host.");return provider;
}
export class RequestGovernor {
  private states=new Map<Provider,State>();
  private queue:Promise<any>=Promise.resolve();
  constructor(private directory?:string,private limits:Partial<Record<Provider,number>>={},private clock=()=>Date.now()){}
  private limit(p:Provider){
    const env=process.env[`ECONSTATS_BUDGET_${p}_PER_HOUR`];
    const limit=this.limits[p]??(env===undefined?(p==="OECD"?60:300):Number(env));
    if(!Number.isInteger(limit)||limit<0)throw new AccessError(p,"request_rejected","Request budget must be a nonnegative integer.");return limit;
  }
  private async update<T>(p:Provider,fn:(s:State)=>T):Promise<T>{
    const work=async()=>{
      const now=this.clock(),fresh=():State=>({started:now,used:0,blockedUntil:0,status:"not_checked"});
      const apply=async(path?:string)=>{
        let s=path?await readStored(path,true):this.states.get(p);
        if(s&&(!Number.isFinite(s.started)||!Number.isInteger(s.used)||s.used<0||!Number.isFinite(s.blockedUntil)))throw new Error("Corrupt local budget state; no upstream request sent.");
        if(!s)s=fresh();
        if(now-s.started>=3600000){s.started=now;s.used=0;if(s.status==="budget_exhausted")s.status="not_checked";}
        if(s.status==="rate_limited"&&s.blockedUntil<=now)s.status="not_checked";
        const value=fn(s);this.states.set(p,s);if(path)await atomicWrite(path,s);return value;
      };
      if(!this.directory)return apply();
      const directory=join(this.directory,"access");await mkdir(directory,{recursive:true});
      const path=storagePath(directory,`provider:${p}`);return withFileLock(path,()=>apply(path));
    };
    const task=this.queue.then(work,work);this.queue=task.catch(()=>{});return task;
  }
  async reserve(p:Provider){
    const error=await this.update(p,s=>{
      const now=this.clock(),limit=this.limit(p);
      if(s.blockedUntil>now)return new AccessError(p,"rate_limited",`Provider cooldown until ${new Date(s.blockedUntil).toISOString()}; no request sent.`);
      if(limit&&s.used>=limit){s.status="budget_exhausted";return new AccessError(p,"budget_exhausted",`Local hourly budget exhausted; resets ${new Date(s.started+3600000).toISOString()}. No request sent.`);}
      s.used++;return undefined;
    });if(error)throw error;
  }
  async record(p:Provider,status:AccessKind,httpStatus?:number,cooldownMs=0){
    await this.update(p,s=>{s.status=status;s.checkedAt=new Date(this.clock()).toISOString();if(httpStatus!==undefined)s.httpStatus=httpStatus;
      if(status==="healthy")s.lastSuccess=s.checkedAt;
      if(cooldownMs)s.blockedUntil=Math.max(s.blockedUntil,this.clock()+cooldownMs);
    });
  }
  async snapshot(p:Provider){return this.update(p,s=>({provider:p,status:s.blockedUntil>this.clock()?"rate_limited":this.limit(p)&&s.used>=this.limit(p)?"budget_exhausted":s.status,checkedAt:s.checkedAt??null,lastSuccess:s.lastSuccess??null,httpStatus:s.httpStatus??null,budget:{limitPerHour:this.limit(p),used:s.used,remaining:this.limit(p)?Math.max(0,this.limit(p)-s.used):null,resetsAt:new Date(s.started+3600000).toISOString()},cooldownUntil:s.blockedUntil>this.clock()?new Date(s.blockedUntil).toISOString():null}));}
}
let governor:RequestGovernor|undefined;
export function accessGovernor(){return governor??=new RequestGovernor(storageDirectory());}
export function resetAccessState(){governor=undefined;}
export async function providerFetch(input:string|URL,init?:RequestInit):Promise<Response>{
  const url=new URL(input),provider=providerFor(url),g=accessGovernor();await g.reserve(provider);
  let response:Response;
  try{response=await fetch(url,{...init,signal:init?.signal??AbortSignal.timeout(30000)});}
  catch{await g.record(provider,"unavailable");throw new AccessError(provider,"unavailable","Network failure or timeout. No credentials or authenticated URLs are returned.");}
  if(!response.ok){
    const status=response.status;
    let kind:AccessKind=status===429?"rate_limited":status===401||(status===403&&["FRED","BEA","BLS","EIA"].includes(provider))?"rejected_key":status>=500?"unavailable":"request_rejected";
    if(status===400&&["FRED","BEA","BLS","EIA"].includes(provider)){
      const body=await response.clone().text().catch(()=>"");
      if(/(?:api[_ ]?key|userid|registrationkey).*?(?:invalid|not registered|not active|reject)|(?:invalid|unregistered).*?(?:api[_ ]?key|userid|registrationkey)/i.test(body.slice(0,20000)))kind="rejected_key";
    }
    const retry=response.headers.get("Retry-After");
    const delay=retry?(/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()):60000;
    await g.record(provider,kind,status,status===429?Math.max(1000,Number.isFinite(delay)?delay:60000):0);
    throw new AccessError(provider,kind,`HTTP ${status}. ${kind==="rejected_key"?"Provider rejected the API key; check registration/activation.":kind==="rate_limited"?"Retry after the provider cooldown.":status===413?"Query too large. Specify start_period and end_period and narrow the selection.":"Check endpoint availability and request parameters."}`);
  }
  await g.record(provider,"healthy",response.status);return response;
}
