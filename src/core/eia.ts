import {providerFetch,AccessError} from "./access";
const BASE="https://api.eia.gov/v2/";
export interface EiaDataParams {route:string;frequency:string;fields:string[];facets:Record<string,string[]>;startPeriod?:string;endPeriod?:string;length?:number;offset?:number}
export function eiaRoute(route=""):string{
  const clean=route.replace(/\/$/,"");
  if(clean&&!/^[a-z0-9-]+(?:\/[a-z0-9-]+){0,9}$/.test(clean))throw new Error("Invalid EIA route. Use a relative route from discovery; no URLs, query strings or traversal.");
  if(clean.split("/").some(p=>["data","facet","seriesid","v2"].includes(p)))throw new Error("Supply the dataset route, excluding data/facet/seriesid/v2 suffixes.");
  return clean;
}
export function buildEiaMetadataUrl(route="",facet?:string):URL{
  const r=eiaRoute(route);
  if(facet&&!/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(facet))throw new Error("Invalid EIA facet ID.");
  return new URL(`${BASE}${r?r+"/":""}${facet?`facet/${facet}/`:""}`);
}
function period(p:string,end=false):number{
  if(!/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?(?:T(?:[01]\d|2[0-3]))?|-Q[1-4])?$/.test(p))throw new Error("Invalid EIA period. Use YYYY, YYYY-MM, YYYY-Qq, YYYY-MM-DD or YYYY-MM-DDTHH.");
  const [date,hour]=p.split("T"),[y,part,day]=date.split("-");
  if(hour&&!day)throw new Error("Hourly periods require a full date.");
  const month=!part?(end?12:1):part.startsWith("Q")?Number(part.slice(1))*3-(end?0:2):Number(part);
  if(day&&new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date)throw new Error("Invalid EIA calendar date.");
  return Date.UTC(Number(y),month-1,day?Number(day):end?new Date(Date.UTC(Number(y),month,0)).getUTCDate():1,hour?Number(hour):end?23:0);
}
export function buildEiaDataUrl(p:EiaDataParams):URL{
  const route=eiaRoute(p.route);if(!route)throw new Error("Select a dataset route before requesting EIA data.");
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(p.frequency))throw new Error("Invalid EIA frequency.");
  if(!Array.isArray(p.fields)||!p.fields.length||p.fields.length>5||p.fields.some(f=>!/^[a-z][a-z0-9_-]{0,60}$/.test(f)))throw new Error("Select 1–5 exact data fields from metadata.");
  if(!p.facets||typeof p.facets!=="object"||Array.isArray(p.facets))throw new Error("Supply an explicit facets object.");
  const url=new URL(`${BASE}${route}/data/`);url.searchParams.set("frequency",p.frequency);
  [...new Set(p.fields)].sort().forEach((f,i)=>url.searchParams.set(`data[${i}]`,f));
  let combinations=1;
  for(const [facet,codes] of Object.entries(p.facets).sort(([a],[b])=>a.localeCompare(b))){
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(facet)||!Array.isArray(codes)||!codes.length||codes.length>50||codes.some(c=>typeof c!=="string"||!/^[A-Za-z0-9_.-]{1,120}$/.test(c)))throw new Error("Invalid EIA facet selection. Use exact codes, no wildcards.");
    const values=[...new Set(codes)].sort();combinations*=values.length;
    values.forEach((c,i)=>url.searchParams.set(`facets[${facet}][${i}]`,c));
  }
  if(combinations>50)throw new Error("EIA selection exceeds 50 facet combinations.");
  const length=p.length??120,offset=p.offset??0;
  if(!Number.isInteger(length)||length<1||length>5000||!Number.isInteger(offset)||offset<0)throw new Error("EIA length must be 1–5000 and offset >= 0.");
  if(p.startPeriod){period(p.startPeriod);url.searchParams.set("start",p.startPeriod);}
  if(p.endPeriod){period(p.endPeriod,true);url.searchParams.set("end",p.endPeriod);}
  if(p.startPeriod&&p.endPeriod&&period(p.startPeriod)>period(p.endPeriod,true))throw new Error("start_period must not be after end_period.");
  url.searchParams.set("sort[0][column]","period");url.searchParams.set("sort[0][direction]","desc");
  Object.keys(p.facets).sort().forEach((f,i)=>{url.searchParams.set(`sort[${i+1}][column]`,f);url.searchParams.set(`sort[${i+1}][direction]`,`asc`);});
  url.searchParams.set("length",String(length));url.searchParams.set("offset",String(offset));
  return url;
}
export function validateEiaMetadata(meta:any):void{
  if(!meta||typeof meta!=="object"||(!Array.isArray(meta.routes)&&!Array.isArray(meta.frequency)))throw new Error("Unexpected EIA route metadata.");
}
export function validateEiaSelection(meta:any,p:EiaDataParams):void{
  validateEiaMetadata(meta);
  if(!meta.frequency?.some((f:any)=>f.id===p.frequency))throw new Error("EIA frequency is not available for this route. Inspect metadata.");
  if(p.fields.some(f=>!Object.hasOwn(meta.data??{},f)))throw new Error("Unknown EIA data field. Inspect metadata.");
  const dims=(meta.facets??[]).map((f:any)=>f.id);
  if(Object.keys(p.facets).some(f=>!dims.includes(f)))throw new Error("Unknown EIA facet. Inspect metadata.");
  if(dims.some((f:string)=>!p.facets[f]?.length)&&!(dims.includes("series")&&p.facets.series?.length))throw new Error("Select every EIA facet, or explicit series codes for routes with a series facet, to avoid broad downloads.");
}
export function formatEiaRoutes(meta:any,route:string,query="",offset=0,limit=20):string{
  validateEiaMetadata(meta);
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches=(meta.routes??[]).filter((r:any)=>terms.every(t=>`${r.id} ${r.name} ${r.description}`.toLowerCase().includes(t)));
  const rows=matches.slice(offset,offset+limit).map((r:any)=>`${route?eiaRoute(route)+"/":""}${r.id}: ${r.name} — ${r.description??""}`);
  return `${rows.join("\n")||"No matching child routes; inspect this route's metadata for data fields."}\nShowing ${rows.length} of ${matches.length} child routes (offset ${offset}). Search is within this node, not the entire catalogue.\nSource: ${buildEiaMetadataUrl(route)} (API key omitted)`;
}
export function formatEiaMetadata(meta:any,route:string):string{
  validateEiaMetadata(meta);
  return `EIA route ${eiaRoute(route)}: ${meta.name??meta.id}\n${meta.description??""}\nCoverage: ${meta.startPeriod??"unknown"} to ${meta.endPeriod??"unknown"}; default frequency ${meta.defaultFrequency??"none"}. Coverage dates are metadata hints; check actual selected series.\nFrequencies: ${(meta.frequency??[]).map((f:any)=>`${f.id} (${f.format})`).join("; ")}\nFacets: ${(meta.facets??[]).map((f:any)=>`${f.id}=${f.description}`).join("; ")}\nData fields: ${Object.entries(meta.data??{}).map(([id,v]:[string,any])=>`${id}=${v.alias??id}${v.units?` (${v.units})`:" (units supplied with observations)"}`).join("; ")}\n${meta.routes?.length?"Child routes are available via eia_list_routes.\n":""}Source: ${buildEiaMetadataUrl(route)} (API key omitted)`;
}
export function formatEiaFacets(data:any,url:URL,query="",offset=0,limit=30):string{
  if(!Array.isArray(data.facets))throw new Error("Unexpected EIA facet response.");
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches=data.facets.filter((f:any)=>terms.every(t=>`${f.id} ${f.name}`.toLowerCase().includes(t)));
  return `${matches.slice(offset,offset+limit).map((f:any)=>`${f.id}: ${f.name}`).join("\n")||"No matching facet values on this page."}\nShowing ${Math.min(limit,Math.max(0,matches.length-offset))} of ${matches.length} matched downloaded codes. API total ${data.totalFacets??data.facets.length}; server may cap the downloaded catalogue.\nSource: ${url} (API key omitted)`;
}
export function formatEiaData(data:any,url:URL,p:EiaDataParams,meta:any):string{
  if(!Array.isArray(data.data)||data.frequency!==p.frequency||data.data.length>(p.length??120))throw new Error("Unexpected EIA data response/frequency or page length.");
  const dims=(meta.facets??[]).map((f:any)=>f.id) as string[],groups=new Map<string,{label:string,values:Map<string,string>}>();let missing=0;
  for(const row of data.data){
    if(typeof row.period!=="string"||!row.period)throw new Error("EIA observation has no period.");
    if(Object.entries(p.facets).some(([f,codes])=>!codes.includes(String(row[f]))))throw new Error("EIA returned unrequested facet codes.");
    if(dims.some(d=>row[d]===undefined))throw new Error("EIA response is missing series dimensions.");
    const coords=dims.map(d=>`${d}=${row[d]}`).join(" | ");
    const reserved=new Set(["period",...dims,...p.fields,...p.fields.map(f=>`${f}-units`),"units"]);
    const details=Object.entries(row).filter(([k,v])=>!reserved.has(k)&&v!==null&&v!=="").map(([k,v])=>`${k}=${v}`).join("; ");
    for(const f of p.fields){
      const value=row[f];if(value===null||value===undefined||["",".","-","--","NA"].includes(String(value).trim())){missing++;continue;}
      if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value))||!Number.isFinite(Number(value)))throw new Error("EIA returned a non-numeric observation.");
      const units=row[`${f}-units`]??row.units??meta.data?.[f]?.units;
      if(!units)throw new Error("EIA observation units are unavailable; inspect the series definition.");
      const key=`${coords} | field=${f}`;
      if(!groups.has(key))groups.set(key,{label:`${key} | units=${units}`,values:new Map()});
      const g=groups.get(key)!;if(g.label!==`${key} | units=${units}`)throw new Error("EIA series units changed within this page.");
      const displayed=`${value}${details?` [${details}]`:""}`;
      if(g.values.has(row.period)&&g.values.get(row.period)!==displayed)throw new Error("EIA returned conflicting observations for a series and period.");
      g.values.set(row.period,displayed);
    }
  }
  const body=[...groups.values()].map(g=>`## EIA: ${meta.name??p.route}\n${g.label}\n${[...g.values].sort(([a],[b])=>a.localeCompare(b)).map(([d,v])=>`${d}: ${v}`).join("\n")}`).join("\n\n");
  const total=Number(data.total),next=(p.offset??0)+data.data.length;
  return `${body||"No numeric EIA observations for this selection."}\n${missing} missing values omitted; missing is not zero.\nRows returned ${data.data.length}; offset ${p.offset??0}; API total ${data.total??"unknown"}. ${Number.isFinite(total)&&next<total?`More rows available: use offset=${next}.`:""} length is rows per query page, not observations per series.\n${/^(aeo|steo|ieo)(\/|$)/.test(p.route)?"This route contains projections/estimates; do not describe forecasts as realised observations.\n":""}${data.warnings?`API warnings: ${JSON.stringify(data.warnings)}\n`:""}Source: U.S. Energy Information Administration (EIA)\nURL: ${url} (API key omitted)\nRetrieved: ${new Date().toISOString()}\nFrequency: ${data.frequency}; reported units retained. Data can be revised; cite route, facets, field, units, observation period and query URL.`;
}
export async function requestEia(url:URL,key?:string):Promise<any>{
  if(!key)throw new Error("EIA_API_KEY is not configured. Get a free key at https://www.eia.gov/opendata/register.php and save it in the local .env file.");
  const authenticated=new URL(url);authenticated.searchParams.set("api_key",key);
  let res:Response;try{res=await providerFetch(authenticated,{signal:AbortSignal.timeout(30000)});}catch(error){if(error instanceof AccessError)throw error;throw new Error("EIA request failed or timed out.");}
  if(res.status===429)throw new Error("EIA rate limit reached. Retry later; the demonstration key has low limits.");
  if(res.status===403)throw new Error("EIA rejected the API key. Check registration/activation and EIA_API_KEY.");
  if(!res.ok)throw new Error(`EIA API HTTP ${res.status}. Check route, fields, frequency and facets.`);
  const raw=await res.text();if(raw.length>20_000_000)throw new Error("EIA response exceeds 20 MB. Narrow the query.");
  let obj:any;try{obj=JSON.parse(raw);}catch{throw new Error("Unexpected EIA JSON response.");}
  if(obj.error||obj.errors||!obj.response)throw new Error("EIA rejected the request or returned no response. Check route and selectors.");
  // Do not return/cache the API's outer request echo, which includes its API key.
  const safe=JSON.stringify({...obj.response,...(obj.warning?{warnings:{warning:obj.warning,description:obj.description}}:{})}).replaceAll(key,"[REDACTED]");
  return JSON.parse(safe);
}
