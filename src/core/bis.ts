import { parse } from "csv-parse/sync";
import {providerFetch} from "./access";
import { XMLParser } from "fast-xml-parser";

const BASE = "https://stats.bis.org/api/v2";
export const BIS_CATALOG_URL = `${BASE}/structure/dataflow/BIS/all/+?references=none&format=sdmx-2.1`;
export interface BisDataParams {
  datasetId: string;
  version?: string;
  seriesKey: string;
  startPeriod?: string;
  endPeriod?: string;
  limit?: number;
}
function dataset(id: string, version = "latest") {
  if (!/^WS_[A-Z0-9_]{1,80}$/.test(id)) throw new Error("Invalid BIS dataset_id. Use a WS_ code from bis_list_datasets, e.g. WS_CBPOL or WS_TC.");
  if (!/^(?:latest|\d+(?:\.\d+){0,2})$/.test(version)) throw new Error("Invalid BIS version. Use latest or the version from discovery.");
  return {id,version:version === "latest" ? "+" : version};
}
export function buildBisStructureUrl(id: string, version?: string): URL {
  const d = dataset(id,version);
  return new URL(`${BASE}/structure/dataflow/BIS/${d.id}/${d.version}?references=all&format=sdmx-2.1`);
}
function periodDate(p: string, end = false): number {
  if (!/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|-(?:Q[1-4]|S[12]))?$/.test(p)) throw new Error("Invalid BIS period. Use YYYY, YYYY-MM, YYYY-Qq, YYYY-Ss or YYYY-MM-DD.");
  const [y,part,day] = p.split("-");
  if (day && (!/^\d{2}$/.test(part) || new Date(`${p}T00:00:00Z`).toISOString().slice(0,10)!==p)) throw new Error("Invalid BIS calendar date.");
  const month = !part ? (end ? 12 : 1) : part.startsWith("Q") ? Number(part.slice(1))*3-(end ? 0 : 2) : part.startsWith("S") ? Number(part.slice(1))*6-(end ? 0 : 5) : Number(part);
  return Date.UTC(Number(y),month-1,day ? Number(day) : end ? new Date(Date.UTC(Number(y),month,0)).getUTCDate() : 1);
}
export function buildBisDataUrl(params: BisDataParams): URL {
  const d = dataset(params.datasetId,params.version);
  if (typeof params.seriesKey!=="string" || params.seriesKey.length>1000 || !/^[A-Z0-9_-]+(?:\+[A-Z0-9_-]+)*(?:\.[A-Z0-9_-]+(?:\+[A-Z0-9_-]+)*)+$/.test(params.seriesKey)) throw new Error("Invalid BIS series_key. Specify every dimension explicitly using dots and +; no wildcards. Inspect bis_get_structure first.");
  if (params.seriesKey.split(".").reduce((n,p)=>n*new Set(p.split("+")).size,1)>50) throw new Error("BIS selection exceeds 50 series. Narrow your query.");
  const limit = params.limit ?? 36;
  if (!Number.isInteger(limit) || limit<1 || limit>120) throw new Error("BIS limit must be an integer from 1 to 120.");
  if (params.startPeriod) periodDate(params.startPeriod);
  if (params.endPeriod) periodDate(params.endPeriod,true);
  if (params.startPeriod && params.endPeriod && periodDate(params.startPeriod)>periodDate(params.endPeriod,true)) throw new Error("start_period must not be after end_period.");
  const url = new URL(`${BASE}/data/dataflow/BIS/${d.id}/${d.version}/${params.seriesKey}`);
  url.searchParams.set("format","csv");
  url.searchParams.set("labels","both");
  // SDMX REST v2 filters time with component constraints, not v1 startPeriod.
  const time = [params.startPeriod ? `ge:${params.startPeriod}` : "",params.endPeriod ? `le:${params.endPeriod}` : ""].filter(Boolean);
  if (time.length) url.searchParams.set("c[TIME_PERIOD]",time.join("+"));
  else url.searchParams.set("lastNObservations",String(limit));
  return url;
}
const list = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
function english(v: any, property = "Name"): string {
  const names = list(v?.[property]);
  const n = names.find(n=>n.lang==="en") ?? names[0];
  const text = typeof n==="string" ? n : String(n?.["#text"] ?? "");
  return text.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
function structures(xml: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected XML document type in BIS response.");
  const s = new XMLParser({ignoreAttributes:false,attributeNamePrefix:"",removeNSPrefix:true,processEntities:false,parseTagValue:false}).parse(xml).Structure?.Structures;
  if (!s) throw new Error("Unexpected BIS metadata response.");
  return s;
}
export function formatBisDatasets(xml: string, query = "", offset = 0, limit = 20): string {
  if (!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50) throw new Error("Invalid BIS catalogue pagination.");
  const synonyms: Record<string,string[]> = {inflation:["consumer price","inflation","cpi"],housing:["property","housing"],forex:["exchange rate"],banking:["banking"]};
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const flows = list(structures(xml).Dataflows?.Dataflow).filter(f=>f.agencyID==="BIS" && /^WS_[A-Z0-9_]+$/.test(f.id) && terms.every(t=>(synonyms[t]??[t]).some(word=>`${f.id} ${english(f)} ${english(f,"Description")}`.toLowerCase().includes(word))));
  const rows = flows.slice(offset,offset+limit).map(f=>`${f.id} (version ${f.version}): ${english(f)}`);
  return `${rows.join("\n") || "No matching BIS datasets on this page."}\nShowing ${rows.length} of ${flows.length} matches (offset ${offset}). Inspect bis_get_structure before constructing a key.\nSource: ${BIS_CATALOG_URL}`;
}
export function getBisDefinition(xml: string, datasetId: string, version?: string) {
  const d = dataset(datasetId,version), s = structures(xml);
  const flow = list(s.Dataflows?.Dataflow).find(f=>f.agencyID==="BIS"&&f.id===d.id&&(d.version==="+"||f.version===d.version));
  const ref = flow?.Structure?.Ref;
  const dsd = list(s.DataStructures?.DataStructure).find(x=>x.agencyID===ref?.agencyID&&x.id===ref?.id&&x.version===ref?.version);
  if (!flow||!dsd) throw new Error("BIS metadata is missing the requested dataset or referenced structure.");
  const components = dsd.DataStructureComponents;
  const dimensions = list(components?.DimensionList?.Dimension).sort((a,b)=>Number(a.position)-Number(b.position)).map(x=>{
    const r = x.ConceptIdentity?.Ref;
    const scheme = list(s.Concepts?.ConceptScheme).find(c=>c.agencyID===r?.agencyID&&c.id===r?.maintainableParentID&&c.version===r?.maintainableParentVersion);
    const concept = list(scheme?.Concept).find(c=>c.id===r?.id);
    const enumeration = x.LocalRepresentation?.Enumeration?.Ref ?? concept?.CoreRepresentation?.Enumeration?.Ref;
    const cl = list(s.Codelists?.Codelist).find(c=>c.agencyID===enumeration?.agencyID&&c.id===enumeration?.id&&c.version===enumeration?.version);
    return {id:String(x.id),label:english(concept),codes:list(cl?.Code).map(c=>({code:String(c.id),label:english(c)}))};
  });
  if (!dimensions.length || dimensions.some(d=>!d.codes.length) || new Set(dimensions.map(d=>d.id)).size!==dimensions.length) throw new Error("BIS metadata has missing or invalid dimension codelists.");
  return {id:d.id,version:String(flow.version),label:english(flow),description:english(flow,"Description"),dimensions,attributes:list(components?.AttributeList?.Attribute).map(a=>String(a.id))};
}
export function formatBisStructure(xml: string, id: string, version?: string, dimensionId?: string, query = ""): string {
  const def = getBisDefinition(xml,id,version);
  if (dimensionId && !def.dimensions.some(d=>d.id===dimensionId)) throw new Error(`Unknown BIS dimension ${dimensionId}. Available: ${def.dimensions.map(d=>d.id).join(", ")}`);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const details = def.dimensions.filter(d=>!dimensionId||d.id===dimensionId).map(d=>{
    const codes = d.codes.filter(c=>terms.every(t=>`${c.code} ${c.label}`.toLowerCase().includes(t)));
    const count = dimensionId ? 60 : 5;
    return `${d.id}${d.label ? ` (${d.label})` : ""}: ${codes.slice(0,count).map(c=>`${c.code}=${c.label}`).join("; ")}\nShowing ${Math.min(count,codes.length)} of ${codes.length} codes.`;
  });
  return `Dataset ${def.id} (version ${def.version}): ${def.label}\n${def.description}\nseries_key dimension order: ${def.dimensions.map(d=>d.id).join(".")}\nCodelists do not guarantee observations. Check units, borrower/lender sectors, valuation, adjustments, nominal/real definition, basket and country coverage.\n\n${details.join("\n\n")}\n\nSource: ${buildBisStructureUrl(id,def.version)}`;
}
export function validateBisKey(def: ReturnType<typeof getBisDefinition>, key: string): void {
  const parts = key.split(".");
  if (parts.length!==def.dimensions.length) throw new Error(`BIS key needs ${def.dimensions.length} dimensions in order ${def.dimensions.map(d=>d.id).join(".")}.`);
  def.dimensions.forEach((d,i)=>{
    for (const code of parts[i].split("+")) if (!d.codes.some(c=>c.code===code)) throw new Error(`Unknown BIS code ${code} for ${d.id}. Inspect bis_get_structure.`);
  });
}
export function formatBisCsv(csv: string, url: URL, params: BisDataParams, def: ReturnType<typeof getBisDefinition>): string {
  const header = parse(csv,{bom:true,to:1})[0] as string[] | undefined;
  if (!header?.includes("TIME_PERIOD") || !header.includes("OBS_VALUE") || !def.dimensions.every(d=>header.includes(d.id)) || new Set(header).size!==header.length) throw new Error("Unexpected BIS CSV observation columns.");
  const rows = parse(csv,{columns:true,bom:true,skip_empty_lines:true}) as Record<string,string>[];
  const dims = def.dimensions.map(d=>d.id), selections = params.seriesKey.split(".").map(p=>p.split("+"));
  const reserved = new Set([...dims,"TIME_PERIOD","OBS_VALUE","DATAFLOW","STRUCTURE","STRUCTURE_ID","ACTION"]);
  // BIS CSV puts dataset/series attributes BEFORE time; the DSD defines dimensions.
  const attrs = header.filter(c=>/^[A-Z][A-Z0-9_]*$/.test(c)&&!reserved.has(c));
  const label = (row: Record<string,string>,column: string) => {
    const next = header[header.indexOf(column)+1];
    return next && !/^[A-Z][A-Z0-9_]*$/.test(next) && row[next] ? `${row[column]} (${row[next]})` : row[column];
  };
  type Observation = {value:string,attrs:Record<string,string>};
  const groups = new Map<string,{title:string,observations:Map<string,Observation>}>();
  let missing = 0;
  for (const row of rows) {
    if (dims.some((d,i)=>!selections[i].includes(row[d]))) throw new Error("BIS returned unrequested dimension codes.");
    if (row.DATAFLOW && row.DATAFLOW!==`BIS:${def.id}(${def.version})`) throw new Error("BIS returned a different dataflow.");
    if (!row.OBS_VALUE?.trim()) {missing++;continue;}
    if (!Number.isFinite(Number(row.OBS_VALUE))) throw new Error("BIS returned a non-numeric observation.");
    if (!row.TIME_PERIOD) throw new Error("BIS returned an observation without a time period.");
    const id = dims.map(d=>row[d]).join(".");
    if (!groups.has(id)) groups.set(id,{title:dims.map(d=>`${d}=${label(row,d)}`).join(" | "),observations:new Map()});
    const observation = {value:row.OBS_VALUE,attrs:Object.fromEntries(attrs.filter(a=>row[a]?.trim()).map(a=>[a,label(row,a)]))};
    const group = groups.get(id)!;
    const old = group.observations.get(row.TIME_PERIOD);
    if (old && JSON.stringify(old)!==JSON.stringify(observation)) throw new Error("BIS returned conflicting observations for the same series and period.");
    group.observations.set(row.TIME_PERIOD,observation);
  }
  if (groups.size>50) throw new Error("BIS returned too many series. Narrow your query.");
  const output = [...groups].map(([key,g])=>{
    const all = [...g.observations.values()];
    for (const unit of ["UNIT_MEASURE","UNIT_MULT","BASE_PER","BASE_PERIOD"]) if (new Set(all.map(o=>o.attrs[unit])).size>1) throw new Error(`BIS series has inconsistent ${unit}; cannot combine definitions.`);
    const constant = attrs.filter(a=>!a.startsWith("OBS_")&&all[0].attrs[a]&&all.every(o=>o.attrs[a]===all[0].attrs[a]));
    const selected = [...g.observations].sort(([a],[b])=>a.localeCompare(b)).slice(-(params.limit??36));
    const lines = selected.map(([p,o])=>{
      const flags = Object.entries(o.attrs).filter(([a])=>!constant.includes(a)).map(([a,v])=>`${a}=${v}`).join(", ");
      return `${p}: ${o.value}${flags ? ` [${flags}]` : ""}`;
    });
    return `## BIS: ${def.label}\nDataset ${def.id} (version ${def.version}); series ${key}\n${g.title}\n${constant.map(a=>`${a}=${all[0].attrs[a]}`).join("\n")}\n${lines.join("\n")}`;
  }).join("\n\n");
  return `${output || "No numeric BIS observations for this selection."}\n${missing} missing observations omitted; missing values are not zero.\n\nSource: Bank for International Settlements (BIS)\nURL: ${url}\nData portal: https://data.bis.org/topics\nRetrieved: ${new Date().toISOString()}\nRetain units, UNIT_MULT (power of ten), base periods, adjustments, compilation notes and breaks. Cite the dataset, series key, observation date and exact query URL. Country coverage and latest dates can differ. This API returns current revised data, not historical vintages.`;
}
export async function requestBis(url: string | URL): Promise<string> {
  const res = await providerFetch(url,{signal:AbortSignal.timeout(35000)});
  if (res.status===429) throw new Error(`BIS rate limit reached. Retry later${res.headers.get("Retry-After") ? `; Retry-After: ${res.headers.get("Retry-After")}` : ""}.`);
  if (res.status===404) throw new Error("BIS dataset or selection not found. Recheck discovery, version and key.");
  if (res.status===413 || res.status===202) throw new Error("BIS query is too large or queued. Narrow the key and period range.");
  if (!res.ok) throw new Error(`BIS API HTTP ${res.status}. No observations returned.`);
  const text = await res.text();
  if (text.length>20_000_000) throw new Error("BIS response exceeds 20 MB. Narrow your selection.");
  return text;
}
