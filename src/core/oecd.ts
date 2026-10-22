import {rankCatalogue} from './catalogue-search';
import { parse } from "csv-parse/sync";
import {providerFetch, AccessError, accessGovernor} from "./access";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {checkCancelled,requestSignal} from './request-context';
import type {SdmxDefinition} from './abs';

export const OECD_SPACES = ["public", "sti-public"] as const;
export type OecdSpace = typeof OECD_SPACES[number];

export function resolveOecdSpace(datasetId?: string, space?: OecdSpace): OecdSpace {
  if (space !== undefined && !OECD_SPACES.includes(space)) throw new Error("Invalid OECD space. Use public or sti-public.");
  // TiVA dataflows can appear in the public catalogue but their retrieval service is separate.
  return space ?? (datasetId?.split(",")[1]?.startsWith("DSD_TIVA_") ? "sti-public" : "public");
}
function baseUrl(space: OecdSpace): string { return `https://sdmx.oecd.org/${space}/rest`; }
export function buildOecdCatalogUrl(space?: OecdSpace): URL {
  // Discovery only needs identifiers and names, not full annotations/descriptions.
  return new URL(`${baseUrl(resolveOecdSpace(undefined, space))}/dataflow/all/all/latest?references=none&detail=allstubs`);
}
export const OECD_CATALOG_URL = String(buildOecdCatalogUrl());
export interface OecdDataParams {
  datasetId: string;
  space?: OecdSpace;
  version?: string;
  seriesKey: string;
  startPeriod?: string;
  endPeriod?: string;
  limit?: number;
}

function dataset(datasetId: string, version = "latest") {
  if (!/^OECD(?:\.[A-Z0-9_]+)*,[A-Z0-9_]+(?:@[A-Z0-9_]+)?$/.test(datasetId)) {
    throw new Error("Invalid dataset_id. Use the agency,dataset returned by oecd_list_datasets, e.g. OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL.");
  }
  if (!/^(?:latest|\d+(?:\.\d+){0,2})$/.test(version)) throw new Error("Invalid OECD version. Use latest or the version returned by dataset discovery.");
  const [agency, id] = datasetId.split(",");
  return { agency, id, version };
}

export function buildOecdStructureUrl(datasetId: string, version?: string, space?: OecdSpace): URL {
  const d = dataset(datasetId, version);
  return new URL(`${baseUrl(resolveOecdSpace(datasetId, space))}/dataflow/${d.agency}/${d.id}/${d.version}?references=all`);
}

export function buildOecdDataUrl(params: OecdDataParams): URL {
  const d = dataset(params.datasetId, params.version);
  const space = resolveOecdSpace(params.datasetId, params.space);
  if ((space === "sti-public" || d.id.startsWith("DSD_TIVA_")) && (!params.startPeriod || !params.endPeriod)) {
    throw new Error("OECD TiVA (sti-public) requires both start_period and end_period. Latest-observation query parameters are blocked by OECD.");
  }
  if (params.seriesKey.length > 1000 || !/^[A-Z0-9_-]+(?:\+[A-Z0-9_-]+)*(?:\.[A-Z0-9_-]+(?:\+[A-Z0-9_-]+)*)+$/.test(params.seriesKey)) {
    throw new Error("Invalid series_key. Specify every dimension explicitly, separated by dots; combine codes with +. Wildcards and all are not supported. Inspect oecd_get_structure first.");
  }
  const combinations = params.seriesKey.split(".").reduce((n, part) => n * new Set(part.split("+")).size, 1);
  if (combinations > 50) throw new Error("Selection exceeds 50 series. Narrow the dimension codes.");
  const limit = params.limit ?? 36;
  if (!Number.isInteger(limit) || limit < 1 || limit > 120) throw new Error("limit must be an integer from 1 to 120.");
  for (const period of [params.startPeriod, params.endPeriod]) {
    if (period && !/^\d{4}(?:-(?:0[1-9]|1[0-2]|M(?:0[1-9]|1[0-2])|Q[1-4]|S[12]))?$/.test(period)) {
      throw new Error("Invalid period. Use YYYY, YYYY-MM, YYYY-Mmm, YYYY-Qq, or YYYY-Ss.");
    }
  }
  const periodOrder = (p: string) => p.replace("-M", "-").replace(/-Q([1-4])/, (_, q) => `-${String(Number(q)*3).padStart(2,"0")}`).replace(/-S([12])/, (_, s) => `-${String(Number(s)*6).padStart(2,"0")}`);
  if (params.startPeriod && params.endPeriod && periodOrder(params.startPeriod) > periodOrder(params.endPeriod)) throw new Error("start_period must not be after end_period.");
  // The data endpoint uses an omitted version for latest; literal "latest" is rejected.
  const flowRef = `${d.agency},${d.id}${d.version === "latest" ? "" : `,${d.version}`}`;
  const url = new URL(`${baseUrl(space)}/data/${flowRef}/${params.seriesKey}`);
  url.searchParams.set("dimensionAtObservation", "AllDimensions");
  url.searchParams.set("format", "csvfilewithlabels");
  if (params.startPeriod) url.searchParams.set("startPeriod", params.startPeriod);
  if (params.endPeriod) url.searchParams.set("endPeriod", params.endPeriod);
  // OECD blocks lastNObservations for some large datasets. Explicit ranges work there.
  if (!params.startPeriod) url.searchParams.set("lastNObservations", String(limit));
  return url;
}

const list = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
function english(value: any): string {
  const names = list(value?.Name);
  const n = names.find(n => n.lang === "en") ?? names[0];
  return typeof n === "string" ? n : String(n?.["#text"] ?? "");
}
function structures(xml: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected XML document type in OECD response.");
  const result = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, processEntities: false }).parse(xml).Structure?.Structures;
  if (!result) throw new Error("Unexpected OECD metadata response.");
  return result;
}

export type OecdDataset = { agency: string; id: string; version: string; name: string };

export function parseOecdCatalogue(xml: string): OecdDataset[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected XML document type in OECD response.");
  if (XMLValidator.validate(xml) !== true) throw new Error("Unexpected OECD catalogue response: incomplete or invalid XML.");
  const dataflows = structures(xml).Dataflows;
  if (!dataflows) throw new Error("Unexpected OECD catalogue response: dataflows are missing.");
  return list(dataflows.Dataflow).map(flow => {
    const name = english(flow);
    if (![flow.agencyID, flow.id, flow.version, name].every(value => typeof value === "string" && value.length > 0)) {
      throw new Error("OECD catalogue contains an incomplete dataset definition.");
    }
    return { agency: flow.agencyID, id: flow.id, version: flow.version, name };
  });
}

export function formatOecdCatalogue(catalogue: OecdDataset[], query = "", offset = 0, limit = 20, space?: OecdSpace): string {
  const catalogUrl = buildOecdCatalogUrl(space);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid catalogue pagination: offset >= 0, limit 1–50.");
  const flows = rankCatalogue(catalogue, query, f=>({id:`${f.agency},${f.id}`,name:f.name}));
  const rows = flows.slice(offset, offset+limit).map(f => `${f.agency},${f.id} (version ${f.version}): ${f.name} [space=${resolveOecdSpace(`${f.agency},${f.id}`, space)}]`);
  return `${rows.join("\n") || "No matching OECD datasets on this page."}\nShowing ${rows.length} of ${flows.length} matches (offset ${offset}). Use offset to continue. Inspect oecd_get_structure before constructing a series_key. TiVA requires explicit start_period and end_period.\nSource: ${catalogUrl}`;
}

// Compatibility entry point for callers that already have an XML response.
export function formatOecdDatasets(xml: string, query = "", offset = 0, limit = 20, space?: OecdSpace): string {
  return formatOecdCatalogue(parseOecdCatalogue(xml), query, offset, limit, space);
}

export function formatOecdStructure(xml: string, datasetId: string, version?: string, dimensionId?: string, query = "", space?: OecdSpace): string {
  const d = dataset(datasetId, version);
  const s = structures(xml);
  const flow = list(s.Dataflows?.Dataflow).find(f => f.id === d.id && f.agencyID === d.agency && (d.version === "latest" || f.version === d.version));
  const ref = flow?.Structure?.Ref;
  const dsd = list(s.DataStructures?.DataStructure).find(x => x.id === ref?.id && x.agencyID === ref?.agencyID && String(x.version) === String(ref?.version));
  if (!flow || !dsd) throw new Error("OECD metadata does not contain the requested dataset and its referenced data structure.");
  const dimensions = list(dsd.DataStructureComponents?.DimensionList?.Dimension).sort((a,b) => Number(a.position)-Number(b.position));
  if (!dimensions.length) throw new Error("OECD metadata has no series dimensions.");
  if (dimensionId && !dimensions.some(x => x.id === dimensionId)) throw new Error(`Unknown dimension ${dimensionId}. Available: ${dimensions.map(x=>x.id).join(", ")}`);
  const details = dimensions.filter(x => !dimensionId || x.id === dimensionId).map(x => {
    const r = x.ConceptIdentity?.Ref;
    const scheme = list(s.Concepts?.ConceptScheme).find(c => c.id === r?.maintainableParentID && c.agencyID === r?.agencyID && String(c.version) === String(r?.maintainableParentVersion));
    const concept = list(scheme?.Concept).find(c => c.id === r?.id);
    const enumeration = x.LocalRepresentation?.Enumeration?.Ref ?? concept?.CoreRepresentation?.Enumeration?.Ref;
    const cl = list(s.Codelists?.Codelist).find(c => c.id === enumeration?.id && c.agencyID === enumeration?.agencyID && String(c.version) === String(enumeration?.version));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const codes = list(cl?.Code).filter(c => terms.every(t => `${c.id} ${english(c)}`.toLowerCase().includes(t)));
    const count = dimensionId ? 60 : 5;
    return `${x.id}: ${codes.slice(0,count).map(c=>`${c.id}=${english(c)}`).join("; ")}\nShowing ${Math.min(count,codes.length)} of ${codes.length} codes${cl ? "" : " (codelist unavailable)"}.`;
  });
  const resolvedSpace = resolveOecdSpace(datasetId, space);
  return `Dataset ${datasetId} (version ${flow.version}): ${english(flow)}\nSpace: ${resolvedSpace}\nseries_key dimension order: ${dimensions.map(x=>x.id).join(".")}\nCodes in the structure are not a guarantee of available observations. Choose exact units, adjustment, methodology and transformation; do not equate national CPI, CPIH and HICP.${resolvedSpace === "sti-public" || d.id.startsWith("DSD_TIVA_") ? " TiVA requests require both start_period and end_period; latest-observation parameters are blocked by OECD." : ""}\n\n${details.join("\n\n")}\n\nSource: ${buildOecdStructureUrl(datasetId,version,space)}`;
}

/** Render only a compact validated definition; no XML parsing on a cache hit. */
export function formatOecdDefinition(def:SdmxDefinition,datasetId:string,dimensionId?:string,query='',space?:OecdSpace):string{
  if(dimensionId&&!def.dimensions.some(d=>d.id===dimensionId))throw new Error(`Unknown dimension ${dimensionId}. Available: ${def.dimensions.map(d=>d.id).join(', ')}`);
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean),resolved=resolveOecdSpace(datasetId,space);
  const details=def.dimensions.filter(d=>!dimensionId||d.id===dimensionId).map(d=>{
    const codes=d.codes.filter(c=>terms.every(t=>`${c.code} ${c.label}`.toLowerCase().includes(t))),count=dimensionId?60:5;
    return `${d.id}: ${codes.slice(0,count).map(c=>`${c.code}=${c.label}`).join('; ')}\nShowing ${Math.min(count,codes.length)} of ${codes.length} codes.`;
  });
  return `Dataset ${datasetId} (version ${def.version}): ${def.label}\nSpace: ${resolved}\nseries_key dimension order: ${def.dimensions.map(d=>d.id).join('.')}\nCodes in the structure are not a guarantee of available observations. Choose exact units, adjustment, methodology and transformation; do not equate national CPI, CPIH and HICP.${resolved==='sti-public'?' TiVA requests require both start_period and end_period; latest-observation parameters are blocked by OECD.':''}\n\n${details.join('\n\n')}\n\nSource: ${buildOecdStructureUrl(datasetId,def.version,space)}`;
}

export function formatOecdCsv(csv: string, url: URL, limit = 36): string {
  const header = parse(csv, { bom:true, to:1 })[0] as string[] | undefined;
  if (!header?.includes("TIME_PERIOD") || !header.includes("OBS_VALUE")) throw new Error("Unexpected OECD response: SDMX-CSV observation columns are missing.");
  if (new Set(header).size !== header.length) throw new Error("OECD CSV contains duplicate columns.");
  const rows = parse(csv, { columns:true, bom:true, skip_empty_lines:true }) as Record<string,string>[];
  const reserved = new Set(["DATAFLOW","STRUCTURE","STRUCTURE_ID","STRUCTURE_NAME","ACTION"]);
  const isCode = (column: string) => /^[A-Z][A-Z0-9_]*$/.test(column);
  const dims = header.slice(0,header.indexOf("TIME_PERIOD")).filter(c=>isCode(c)&&!reserved.has(c));
  if (!dims.length) throw new Error("OECD CSV has no series dimensions.");
  const label = (row: Record<string,string>, column: string) => {
    const next = header[header.indexOf(column)+1];
    return next && !isCode(next) && row[next] ? `${row[column]} (${row[next]})` : row[column];
  };
  const attrs = header.slice(header.indexOf("OBS_VALUE")+1).filter(isCode);
  const groups = new Map<string,{title:string, observations:Map<string,string>}>();
  let missing = 0;
  for (const row of rows) {
    if (!row.OBS_VALUE?.trim()) { missing++; continue; }
    if (!Number.isFinite(Number(row.OBS_VALUE))) throw new Error("OECD returned a non-numeric observation value.");
    if (!row.TIME_PERIOD) throw new Error("OECD returned an observation without a time period.");
    const id = [row.STRUCTURE_ID ?? row.DATAFLOW,...dims.map(c=>`${c}=${row[c]}`)].join(" | ");
    if (!groups.has(id)) groups.set(id,{title:[row.STRUCTURE_ID ?? row.DATAFLOW,row.STRUCTURE_NAME,...dims.map(c=>`${c}=${label(row,c)}`)].filter(Boolean).join(" | "),observations:new Map()});
    const meta = attrs.filter(c=>row[c]?.trim()).map(c=>`${c}=${label(row,c)}`).join(", ");
    const value = `${row.OBS_VALUE}${meta ? ` [${meta}]` : ""}`;
    const group = groups.get(id)!;
    if (group.observations.has(row.TIME_PERIOD) && group.observations.get(row.TIME_PERIOD) !== value) throw new Error("OECD returned conflicting values or attributes for the same series and period.");
    group.observations.set(row.TIME_PERIOD,value);
  }
  if (groups.size > 50) throw new Error("OECD returned more than 50 series. Narrow your selection.");
  const output = [...groups.values()].map(g=>`## OECD: ${g.title}\n${[...g.observations].sort(([a],[b])=>a.localeCompare(b)).slice(-limit).map(([p,v])=>`${p}: ${v}`).join("\n")}`).join("\n\n");
  return `${output || "No numeric OECD observations for this selection."}\n${missing ? `${missing} missing observations omitted; missing values are not zero.\n` : ""}\nSource: Organisation for Economic Co-operation and Development (OECD)\nURL: ${url}\nRetrieved: ${new Date().toISOString()}\nValues retain reported units and UNIT_MULT (power of ten), base periods, adjustment, transformation and observation-status flags. Cite the exact series, units, observation date and source URL. Do not infer definitions from the measure name alone.`;
}

function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function requestOecd(url: string | URL, metadata = false, timeoutMs = 30000): Promise<string> {
  const parent=requestSignal();
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs),...(parent?[parent]:[])]);
  const res = await providerFetch(url,{headers:{Accept:metadata ? "application/vnd.sdmx.structure+xml;version=2.1" : "text/csv"},signal});
  if (res.status === 429) throw new Error(`OECD rate limit reached (60 downloads/hour). Retry later${res.headers.get("Retry-After") ? `; Retry-After: ${res.headers.get("Retry-After")}` : ""}.`);
  if (res.status === 413) throw new Error("OECD rejected the query size or lastNObservations parameter. Specify start_period and end_period and narrow the series_key.");
  if (res.status === 404) throw new Error("OECD dataset/selection not found. Recheck discovery, version and series dimensions.");
  if (!res.ok) throw new Error(`OECD API HTTP ${res.status}. No data returned.`);
  const reader = res.body?.getReader();
  const maxBytes = 20_000_000;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(res.headers.get("content-length")) > maxBytes) {
      throw new AccessError("OECD", "invalid_response", "Response exceeds 20 MB. Narrow the selection and period range.");
    }
    if (!reader) throw new AccessError("OECD", "invalid_response", "Empty response body.");
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new AccessError("OECD", "invalid_response", "Response exceeds 20 MB. Narrow the selection and period range.");
      chunks.push(value);
    }
    const expected=res.headers.get('content-length'),encoding=res.headers.get('content-encoding');
    if(expected!==null&&(!encoding||encoding==='identity')&&Number(expected)!==size)
      throw new AccessError('OECD','invalid_response','Response length does not match its header; no data were returned.');
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    // Cancellation must not itself prolong a timed-out tool call.
    void reader?.cancel().catch(() => {});
    checkCancelled();
    const failure = error instanceof AccessError ? error : new AccessError("OECD", "unavailable", "Response body failed or timed out; no data returned.");
    await accessGovernor().record("OECD", failure.kind).catch(() => {});
    throw failure;
  }
}
