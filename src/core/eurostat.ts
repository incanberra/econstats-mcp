import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination";
export const EUROSTAT_CATALOG_URL = `${BASE}/catalogue/toc/txt?lang=en`;
export interface EurostatDataParams {
  datasetId: string;
  filters: Record<string,string[]>;
  startPeriod?: string;
  endPeriod?: string;
  limit?: number;
}
const list = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
function english(value: any, property = "Name"): string {
  const names = list(value?.[property]);
  const n = names.find(n=>n.lang === "en") ?? names[0];
  return typeof n === "string" ? n : String(n?.["#text"] ?? "");
}
function plainHtml(text: string): string {
  return text.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim().slice(0,2000);
}
function dataset(id: string): string {
  if (!/^[a-z][a-z0-9_]{1,100}$/i.test(id)) throw new Error("Invalid dataset_id. Use a main Eurostat code from discovery, e.g. prc_hicp_minr. Separate DS-/Comext datasets are not supported.");
  return id.toLowerCase();
}
export function buildEurostatStructureUrl(datasetId: string): URL {
  return new URL(`${BASE}/sdmx/2.1/dataflow/ESTAT/${dataset(datasetId).toUpperCase()}/1.0?references=descendants&detail=referencepartial&compressed=true`);
}
export function buildEurostatDataUrl(params: EurostatDataParams): URL {
  const url = new URL(`${BASE}/statistics/1.0/data/${dataset(params.datasetId)}`);
  url.searchParams.set("lang","EN");
  if (!params.filters || !Object.keys(params.filters).length) throw new Error("Supply explicit filters for every non-time dimension; inspect eurostat_get_structure first.");
  const names = new Set<string>();
  let combinations = 1;
  for (const [name,codes] of Object.entries(params.filters).sort(([a],[b])=>a.localeCompare(b))) {
    const dim = name.toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(dim) || ["time","time_period","lang","geolevel","lasttimeperiod","sincetimeperiod","untiltimeperiod","format"].includes(dim) || names.has(dim)) throw new Error(`Invalid or duplicate dimension filter: ${name}`);
    names.add(dim);
    if (!Array.isArray(codes) || !codes.length || codes.length > 50 || codes.some(c=>typeof c!=="string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(c))) throw new Error(`Invalid codes for ${name}. Specify exact codes from eurostat_get_structure; no wildcards.`);
    const selected = [...new Set(codes)].sort();
    combinations *= selected.length;
    for (const code of selected) url.searchParams.append(dim,code);
  }
  if (combinations > 50) throw new Error("Selection exceeds 50 series. Narrow the filters.");
  const limit = params.limit ?? 36;
  if (!Number.isInteger(limit) || limit < 1 || limit > 120) throw new Error("limit must be an integer from 1 to 120.");
  for (const p of [params.startPeriod,params.endPeriod]) {
    if (p && !/^\d{4}(?:-(?:0[1-9]|1[0-2]|Q[1-4]|S[12]))?$/.test(p)) throw new Error("Invalid period. Use YYYY, YYYY-MM, YYYY-Qq or YYYY-Ss.");
  }
  const periodOrder = (p: string, end = false) => {
    const [year,part] = p.split("-");
    const month = !part ? (end ? 12 : 1) : part.startsWith("Q") ? Number(part.slice(1))*3-(end ? 0 : 2) : part.startsWith("S") ? Number(part.slice(1))*6-(end ? 0 : 5) : Number(part);
    return Number(year)*12+month;
  };
  if (params.startPeriod && params.endPeriod && periodOrder(params.startPeriod) > periodOrder(params.endPeriod,true)) throw new Error("start_period must not be after end_period.");
  if (params.startPeriod) url.searchParams.set("sinceTimePeriod",params.startPeriod);
  if (params.endPeriod) url.searchParams.set("untilTimePeriod",params.endPeriod);
  if (!params.startPeriod && !params.endPeriod) url.searchParams.set("lastTimePeriod",String(limit));
  return url;
}

export function formatEurostatDatasets(tsv: string, query = "", offset = 0, limit = 20): string {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid catalogue pagination.");
  const rows = parse(tsv,{delimiter:"\t",columns:true,bom:true,skip_empty_lines:true}) as Record<string,string>[];
  if (!rows.length || !["title","code","type","data end"].every(c=>c in rows[0])) throw new Error("Unexpected Eurostat catalogue response.");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const synonyms: Record<string,string[]> = {inflation:["inflation","hicp","consumer price"],gdp:["gdp","gross domestic product"]};
  const unique = new Map<string,Record<string,string>>();
  for (const row of rows) {
    if (!["dataset","table"].includes(row.type) || !/^[a-z][a-z0-9_]{1,100}$/i.test(row.code)) continue;
    const text = `${row.code} ${row.title}`.toLowerCase();
    if (terms.every(t=>(synonyms[t]??[t]).some(word=>text.includes(word)))) unique.set(row.code,row);
  }
  const matches = [...unique.values()].sort((a,b)=>(b["data end"]??"").localeCompare(a["data end"]??""));
  const found = matches.slice(offset,offset+limit);
  return `${found.map(r=>`${r.code}: ${r.title.trim()} | coverage ${r["data start"]} to ${r["data end"]} | data updated ${r["last update of data"]}`).join("\n") || "No matching Eurostat datasets on this page."}\nShowing ${found.length} of ${matches.length} matches (offset ${offset}). Use offset to continue. Inspect eurostat_get_structure before querying.\nSource: ${EUROSTAT_CATALOG_URL}`;
}

export function getEurostatDefinition(xml: string, datasetId: string) {
  const id = dataset(datasetId).toUpperCase();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected XML document type in Eurostat response.");
  const s = new XMLParser({ignoreAttributes:false,attributeNamePrefix:"",removeNSPrefix:true,processEntities:false,parseTagValue:false}).parse(xml).Structure?.Structures;
  const flow = list(s?.Dataflows?.Dataflow).find(f=>f.id===id&&f.agencyID==="ESTAT");
  const ref = flow?.Structure?.Ref;
  const dsd = list(s?.DataStructures?.DataStructure).find(d=>d.id===ref?.id&&d.agencyID===ref?.agencyID&&d.version===ref?.version);
  if (!flow || !dsd) throw new Error("Unexpected Eurostat metadata: requested dataset or referenced structure is missing.");
  const dimensions = list(dsd.DataStructureComponents?.DimensionList?.Dimension).sort((a,b)=>Number(a.position)-Number(b.position)).map(d=>{
    const ref = d.ConceptIdentity?.Ref;
    const scheme = list(s.Concepts?.ConceptScheme).find(c=>c.id===ref?.maintainableParentID&&c.agencyID===ref?.agencyID&&c.version===ref?.maintainableParentVersion);
    const concept = list(scheme?.Concept).find(c=>c.id===ref?.id);
    const enumeration = d.LocalRepresentation?.Enumeration?.Ref ?? concept?.CoreRepresentation?.Enumeration?.Ref;
    const cl = list(s.Codelists?.Codelist).find(c=>c.id===enumeration?.id&&c.agencyID===enumeration?.agencyID&&c.version===enumeration?.version);
    return {id:String(d.id).toLowerCase(),label:english(concept),codes:list(cl?.Code).map(c=>({code:String(c.id),label:english(c)}))};
  });
  if (!dimensions.length || dimensions.some(d=>!d.codes.length)) throw new Error("Eurostat metadata has missing dimension codelists.");
  const annotations = list(flow.Annotations?.Annotation);
  const annotation = (type: string) => annotations.find(a=>a.AnnotationType===type)?.AnnotationTitle;
  return {label:english(flow),description:plainHtml(english(flow,"Description")),dimensions,first:annotation("OBS_PERIOD_OVERALL_OLDEST"),last:annotation("OBS_PERIOD_OVERALL_LATEST"),updated:annotation("UPDATE_DATA")};
}
export function formatEurostatStructure(xml: string, datasetId: string, dimensionId?: string, query = ""): string {
  const def = getEurostatDefinition(xml,datasetId);
  const selected = dimensionId?.toLowerCase();
  if (selected && !def.dimensions.some(d=>d.id===selected)) throw new Error(`Unknown dimension ${dimensionId}. Available: ${def.dimensions.map(d=>d.id).join(", ")}`);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const details = def.dimensions.filter(d=>!selected||d.id===selected).map(d=>{
    const codes = d.codes.filter(c=>terms.every(t=>`${c.code} ${c.label}`.toLowerCase().includes(t)));
    const count = selected ? 60 : 5;
    return `${d.id}${d.label ? ` (${d.label})` : ""}: ${codes.slice(0,count).map(c=>`${c.code}=${c.label}`).join("; ")}\nShowing ${Math.min(count,codes.length)} of ${codes.length} codes.`;
  });
  return `Dataset ${dataset(datasetId)}: ${def.label}\nRequired non-time filters: ${def.dimensions.map(d=>d.id).join(", ")}\nCoverage: ${def.first??"unknown"} to ${def.last??"unknown"}; data updated ${def.updated??"unknown"}.\n${def.description ? `Dataset notes: ${def.description}\n` : ""}\n${details.join("\n\n")}\n\nSource: ${buildEurostatStructureUrl(datasetId)}`;
}
export function validateEurostatFilters(xml: string, params: EurostatDataParams): void {
  const def = getEurostatDefinition(xml,params.datasetId);
  const filters = Object.fromEntries(Object.entries(params.filters).map(([d,c])=>[d.toLowerCase(),c]));
  for (const dim of Object.keys(filters)) if (!def.dimensions.some(d=>d.id===dim)) throw new Error(`Unknown filter ${dim}. Inspect eurostat_get_structure.`);
  for (const dim of def.dimensions) {
    if (!filters[dim.id]?.length) throw new Error(`Missing filter ${dim.id}. Specify every non-time dimension to avoid broad downloads.`);
    for (const code of filters[dim.id]) if (!dim.codes.some(c=>c.code===code)) throw new Error(`Unknown code ${code} for ${dim.id}. Inspect eurostat_get_structure with dimension_id=${dim.id}.`);
  }
}

export function formatEurostatJson(data: any, url: URL, params: EurostatDataParams): string {
  if (data?.error) throw new Error(`Eurostat API error: ${JSON.stringify(data.error).slice(0,400)}`);
  if (data?.class!=="dataset" || data.version!=="2.0" || !Array.isArray(data.id) || !Array.isArray(data.size) || data.id.length!==data.size.length || !data.id.includes("time") || new Set(data.id).size!==data.id.length) throw new Error("Unexpected Eurostat JSON-stat response.");
  if (data.extension?.id && data.extension.id.toLowerCase()!==dataset(params.datasetId)) throw new Error("Eurostat returned a different dataset.");
  const ids = data.id as string[], sizes = data.size as number[];
  if (sizes.some(n=>!Number.isInteger(n)||n<0)) throw new Error("Invalid Eurostat dimension sizes.");
  const total = sizes.reduce((a,b)=>a*b,1);
  if (!Number.isSafeInteger(total) || total>1_000_000) throw new Error("Eurostat response has too many cells. Narrow filters and period range.");
  const dimensions = ids.map((id,i)=>{
    const category = data.dimension?.[id]?.category;
    const raw = category?.index;
    const codes: string[] = [];
    for (const [code,position] of Array.isArray(raw) ? raw.map((code,i)=>[code,i]) : Object.entries(raw??{})) {
      if (typeof code!=="string" || !Number.isInteger(position) || (position as number)<0 || (position as number)>=sizes[i] || codes[position as number]!==undefined) throw new Error("Invalid Eurostat category index.");
      codes[position as number]=code;
    }
    if (codes.filter(c=>c!==undefined).length!==sizes[i]) throw new Error("Incomplete Eurostat category index.");
    const selected = Object.entries(params.filters).find(([key])=>key.toLowerCase()===id)?.[1];
    if (id!=="time" && (!selected || codes.some(c=>!selected.includes(c)))) throw new Error(`Eurostat returned unrequested dimension codes for ${id}.`);
    return {id,codes,labels:category?.label??{},units:category?.unit};
  });
  if (data.value==null || typeof data.value!=="object") throw new Error("Eurostat observation values are missing or malformed.");
  const groups = new Map<string,Map<string,string>>();
  let numericCount = 0;
  for (const [key,value] of Object.entries(data.value)) {
    const index = Number(key);
    if (!/^(?:0|[1-9]\d*)$/.test(key) || !Number.isInteger(index) || index>=total) throw new Error("Eurostat observation index is outside its dimension grid.");
    if (value==null) continue;
    if (typeof value!=="number" || !Number.isFinite(value)) throw new Error("Eurostat returned a non-numeric observation value.");
    let remaining = index;
    const positions: number[] = [];
    for (let i=ids.length-1;i>=0;i--) {positions[i]=remaining%sizes[i];remaining=Math.floor(remaining/sizes[i]);}
    const selected = dimensions.map((d,i)=>({d,code:d.codes[positions[i]]}));
    const period = selected.find(x=>x.d.id==="time")!.code;
    const title = selected.filter(x=>x.d.id!=="time").map(({d,code})=>`${d.id}=${code}${d.labels[code] ? ` (${d.labels[code]})` : ""}${d.units?.[code] ? ` [unit metadata=${JSON.stringify(d.units[code])}]` : ""}`).join(" | ");
    const status = typeof data.status==="string" ? data.status : data.status?.[key];
    if (!groups.has(title)) groups.set(title,new Map());
    groups.get(title)!.set(period,`${value}${status ? ` [STATUS=${status}]` : ""}`);
    numericCount++;
  }
  if (groups.size>50) throw new Error("Eurostat returned more than 50 series. Narrow filters.");
  const output = [...groups].map(([title,obs])=>`## Eurostat: ${data.label}\n${title}\n${[...obs].sort(([a],[b])=>a.localeCompare(b)).slice(-(params.limit??36)).map(([p,v])=>`${p}: ${v}`).join("\n")}`).join("\n\n");
  return `${output || "No numeric Eurostat observations for this selection."}\n${total-numericCount} missing cells omitted; missing values are not zero.\n${data.extension?.description ? `Dataset notes: ${plainHtml(data.extension.description)}\n` : ""}\nSource: Eurostat\nURL: ${url}\nData browser: https://ec.europa.eu/eurostat/databrowser/view/${dataset(params.datasetId)}/default/table?lang=en\nDataset updated: ${data.updated??"unknown"}\nRetrieved: ${new Date().toISOString()}\nValues retain reported units, rate/index definitions, adjustment and status flags. Cite the exact series, observation date and source URL. The latest time positions may have missing values for some countries; Eurostat data can be revised and this API is not a vintage archive.`;
}

export async function requestEurostat(url: string | URL, timeoutMs = 40000): Promise<string> {
  const res = await fetch(url,{signal:AbortSignal.timeout(timeoutMs)});
  if (res.status===202) throw new Error("Eurostat queued this large query. Narrow the filters and date range; no observations returned yet.");
  if (res.status===429) throw new Error("Eurostat rate limit reached. Retry later; no observations returned.");
  if (res.status===404) throw new Error("Eurostat dataset or selection not found. Recheck dataset discovery and filters.");
  if (!res.ok) throw new Error(`Eurostat API HTTP ${res.status}. Recheck dataset and dimension codes.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length>20_000_000) throw new Error("Eurostat response exceeds 20 MB. Narrow your query.");
  const decoded = bytes[0]===0x1f&&bytes[1]===0x8b ? gunzipSync(bytes,{maxOutputLength:20_000_000}) : bytes;
  return new TextDecoder().decode(decoded);
}
