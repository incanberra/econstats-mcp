import iso from "i18n-iso-countries";
import {fetchRetry} from "./http";
import {AccessError,accessGovernor,providerFor} from "./access";

export async function checkedJson(url:string|URL,init?:RequestInit):Promise<any>{
  const target=new URL(url),provider=providerFor(target),res=await fetchRetry(target,init);
  const text=await res.text();
  if(text.length>20_000_000)throw new AccessError(provider,"invalid_response","Response exceeds 20 MB; narrow the query.");
  let value:any;try{value=JSON.parse(text);}catch{await accessGovernor().record(provider,"invalid_response");throw new AccessError(provider,"invalid_response","Expected JSON, received malformed or non-JSON data.");}
  const failure=provider==="FRED"?value.error_code:provider==="BEA"?value?.BEAAPI?.Results?.Error??value?.BEAAPI?.Error:provider==="BLS"&&value.status!=="REQUEST_SUCCEEDED"?value.message??"missing status":undefined;
  if(failure){
    const description=JSON.stringify(provider==="FRED"?value.error_message:failure);
    const kind=/rate.?limit|threshold|quota|too many|exceed.*(?:request|limit)/i.test(description)?"rate_limited":/key|userid|registration|activat|authentication/i.test(description)?"rejected_key":"request_rejected";
    await accessGovernor().record(provider,kind,res.status,kind==="rate_limited"?(provider==="BLS"&&/daily/i.test(description)?86400000:60000):0);throw new AccessError(provider,kind,kind==="rate_limited"?"Provider rate limit reached; retry after cooldown.":"Provider rejected the request; check credentials and parameters.");
  }
  const secrets=[...target.searchParams].filter(([k])=>/^(api_key|userid|registrationkey)$/i.test(k)).map(([,v])=>v);
  if(typeof init?.body==="string"){try{const body=JSON.parse(init.body);if(body.registrationkey)secrets.push(body.registrationkey);}catch{}}
  const serial=JSON.stringify(value,((key,v)=>/^(request|api_key|userid|registrationkey)$/i.test(key)?undefined:v));
  return JSON.parse(secrets.filter(Boolean).reduce((s,key)=>s.replaceAll(key,"[REDACTED]"),serial));
}
export function legacyFailure(provider:"FRED"|"BLS"|"BEA"|"WORLD_BANK"|"ECB",kind:"invalid_response"|"request_rejected"|"rejected_key",message:string):never{
  // Messages are local descriptions; provider request echoes and private URLs are never used.
  throw new AccessError(provider,kind,message);
}
export async function worldBankPages(url:URL):Promise<{rows:any[];updated:string;pages:number}>{
  const rows:any[]=[],seen=new Set<string>();let pages=1,total:number|undefined,updated="unknown";
  for(let page=1;page<=pages;page++){
    const query=new URL(url);query.searchParams.set("page",String(page));
    const response=await checkedJson(query);
    if(!Array.isArray(response)||response.length!==2||!response[0]||response[0].message)legacyFailure("WORLD_BANK","request_rejected","World Bank rejected the query. Check indicator, country codes and date range.");
    const meta=response[0],data=response[1]??[];
    if(!Array.isArray(data)||Number(meta.page)!==page||!Number.isInteger(Number(meta.pages))||Number(meta.pages)<0||Number(meta.pages)>500||!Number.isInteger(Number(meta.total))||Number(meta.total)<0||Number(meta.total)>50000)legacyFailure("WORLD_BANK","invalid_response","Unexpected or oversized pagination metadata; narrow the query.");
    if(page===1){pages=Math.max(1,Number(meta.pages));total=Number(meta.total);updated=meta.lastupdated??"unknown";}
    else if(Number(meta.pages)!==pages||Number(meta.total)!==total||(meta.lastupdated??"unknown")!==updated)legacyFailure("WORLD_BANK","invalid_response","World Bank data changed during pagination; retry the complete query.");
    for(const row of data){const id=row.date!==undefined?`${row.indicator?.id}|${row.countryiso3code??row.country?.id}|${row.date}`:String(row.id);
      if(seen.has(id))legacyFailure("WORLD_BANK","invalid_response","Repeated rows across World Bank pages; complete coverage cannot be confirmed.");seen.add(id);rows.push(row);}
  }
  if(rows.length!==total)legacyFailure("WORLD_BANK","invalid_response","World Bank pagination was incomplete; no partial observations returned.");
  return {rows,updated,pages};
}
export function worldBankUrl(p:{countryCodes:string[];indicator:string;startYear?:number;endYear?:number}):URL{
  if(!Array.isArray(p.countryCodes)||!p.countryCodes.length||p.countryCodes.length>50||p.countryCodes.some(c=>!/^[A-Za-z0-9]{2,3}$/.test(c))||!/^[A-Za-z0-9_.-]{1,120}$/.test(p.indicator))throw new Error("Select 1–50 exact World Bank country/aggregate codes and an indicator ID; no wildcards or URLs.");
  const end=p.endYear??new Date().getUTCFullYear(),start=p.startYear??end-59;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1900||end<start||end-start>149||end>new Date().getUTCFullYear())throw new Error("World Bank years must be 1900–current year, ordered, with at most 150 years.");
  const url=new URL(`https://api.worldbank.org/v2/country/${[...new Set(p.countryCodes.map(c=>c.toUpperCase()))].sort().join(";")}/indicator/${p.indicator}`);
  url.searchParams.set("format","json");url.searchParams.set("source","2");url.searchParams.set("per_page","100");url.searchParams.set("date",`${start}:${end}`);return url;
}
export function formatWorldBank(rows:any[],metadata:any,url:URL,updated:string,pages:number):string{
  const selected=url.pathname.split("/country/")[1].split("/")[0].split(";"),indicator=url.pathname.split("/indicator/")[1];
  const bounds=url.searchParams.get("date")!.split(":").map(Number),groups=new Map<string,{title:string;values:Map<string,string>}>();let missing=0;
  for(const row of rows){
    const id=row.countryiso3code||row.country?.id;
    if(row.indicator?.id!==indicator||!selected.some(c=>c===id||c===row.country?.id||iso.alpha2ToAlpha3(c)===id)||!/^\d{4}$/.test(row.date)||Number(row.date)<bounds[0]||Number(row.date)>bounds[1])legacyFailure("WORLD_BANK","invalid_response","World Bank returned an unrequested country, indicator or year.");
    if(row.value===null||row.value===undefined){missing++;continue;}
    if(typeof row.value!=="number"||!Number.isFinite(row.value))legacyFailure("WORLD_BANK","invalid_response","Non-numeric World Bank observation.");
    if(!groups.has(id))groups.set(id,{title:row.country?.value??id,values:new Map()});
    const flags=[row.obs_status?`status=${row.obs_status}`:"",row.unit?`unit=${row.unit}`:""].filter(Boolean).join("; ");
    groups.get(id)!.values.set(row.date,`${row.value}${flags?` [${flags}]`:""}`);
  }
  return [...groups].map(([id,g])=>`## World Bank: ${metadata.name} — ${g.title}\nCountry=${id}; indicator=${indicator}; unit=${metadata.unit||"not supplied by API; retain indicator definition"}\n${[...g.values].sort(([a],[b])=>a.localeCompare(b)).map(([d,v])=>`${d}: ${v}`).join("\n")}`).join("\n\n")+
    `\n${groups.size?"":"No numeric World Bank observations for this selection.\n"}${missing} missing observations omitted; missing is not zero.\nDefinition: ${metadata.sourceNote??"not supplied"}\nOriginal organisation: ${metadata.sourceOrganization??"not supplied"}\nSource: World Bank World Development Indicators (source 2)\nURL: ${url}\nIndicator page: https://data.worldbank.org/indicator/${indicator}\nAll ${pages} pages retrieved (${rows.length} rows). Source updated: ${updated}\nRetrieved: ${new Date().toISOString()}\nCurrent revised annual observations; preserve indicator units, country definitions and status flags.`;
}
export function ecbUrl(p:{flowRef:string;key:string;startPeriod?:string;endPeriod?:string}):URL{
  if(!/^[A-Z][A-Z0-9_]{0,60}$/.test(p.flowRef)||!p.key||p.key.length>1000||!p.key.split(".").every(v=>/^[A-Za-z0-9_-]+(?:\+[A-Za-z0-9_-]+)*$/.test(v))||p.key.split(".").reduce((n,v)=>n*v.split("+").length,1)>50)throw new Error("Use an exact ECB flow and fully specified series key; no wildcard dimensions or URLs (maximum 50 series).");
  for(const d of [p.startPeriod,p.endPeriod])if(d&&!/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|-Q[1-4])?$/.test(d))throw new Error("Invalid ECB period. Use YYYY, YYYY-MM, YYYY-MM-DD or YYYY-Qq.");
  if(p.startPeriod&&p.endPeriod&&p.startPeriod>p.endPeriod)throw new Error("ECB start_period must not be after end_period.");
  const url=new URL(`https://data-api.ecb.europa.eu/service/data/${p.flowRef}/${p.key}`);url.searchParams.set("format","jsondata");
  if(p.startPeriod)url.searchParams.set("startPeriod",p.startPeriod);if(p.endPeriod)url.searchParams.set("endPeriod",p.endPeriod);return url;
}
export function formatEcb(data:any,url:URL):string{
  const structure=data?.structure,datasets=data?.dataSets;
  if(!structure?.dimensions||!Array.isArray(datasets)||datasets.length!==1||!datasets[0]?.series)legacyFailure("ECB","invalid_response","Unexpected ECB SDMX-JSON structure.");
  const dims=structure.dimensions.series??[],obsDims=structure.dimensions.observation??[],times=obsDims.find((d:any)=>d.id==="TIME_PERIOD")?.values;
  if(!Array.isArray(times)||obsDims.length!==1)legacyFailure("ECB","invalid_response","Expected one ECB time dimension; cannot safely align observations.");
  const attrs=structure.attributes??{},dataset=datasets[0],groups:string[]=[];let missing=0;
  const decode=(definitions:any[],indices:any[])=>definitions.map((d:any,i:number)=>{
    const index=indices?.[i];if(index===undefined||index===null)return "";
    const v=d.values?.[index];if(!v)legacyFailure("ECB","invalid_response","Invalid ECB attribute index.");return `${d.id}=${v.id}${v.name&&v.name!==v.id?` (${v.name})`:""}`;
  }).filter(Boolean);
  const constraints=url.pathname.split("/").at(-1)!.split(".");
  for(const [key,series] of Object.entries(dataset.series) as [string,any][]){
    const indices=key.split(":").map(Number);
    if(indices.length!==dims.length||constraints.length!==dims.length)legacyFailure("ECB","invalid_response","Unexpected ECB series dimensions.");
    const labels=dims.map((d:any,i:number)=>{const v=d.values?.[indices[i]];if(!v||!constraints[i].split("+").includes(v.id))legacyFailure("ECB","invalid_response","ECB returned an unrequested series.");return `${d.id}=${v.id}${v.name?` (${v.name})`:""}`;});
    const attributes=[...decode(attrs.dataSet??[],dataset.attributes),...decode(attrs.series??[],series.attributes)];
    const lines=Object.entries(series.observations??{}).map(([idx,values]:[string,any])=>{
      if(!/^\d+$/.test(idx)||!times[Number(idx)]?.id||!Array.isArray(values))legacyFailure("ECB","invalid_response","Invalid ECB observation index or time period.");
      const value=values[0];if(value===null||value===undefined){missing++;return "";}
      if(typeof value!=="number"||!Number.isFinite(value))legacyFailure("ECB","invalid_response","Non-numeric ECB observation.");
      const flags=decode(attrs.observation??[],values.slice(1));return `${times[Number(idx)].id}: ${value}${flags.length?` [${flags.join("; ")}]`:""}`;
    }).filter(Boolean).sort();
    groups.push(`## ECB: ${url.pathname.split("/data/")[1]}\n${labels.join(" | ")}\n${attributes.join("\n")}\n${lines.join("\n")||"No numeric observations for this series."}`);
  }
  return `${groups.join("\n\n")||"No numeric ECB observations for this selection."}\n${missing} missing observations omitted; missing is not zero.\nSource: European Central Bank\nURL: ${url}\nRetrieved: ${new Date().toISOString()}\nRetain UNIT, UNIT_MULT scaling, frequency, adjustment, base periods and observation-status flags as supplied by metadata. No automatic unit conversion. Current revised data; not historical vintages.`;
}
