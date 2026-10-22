import {rankCatalogue} from './catalogue-search';
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import countries from "i18n-iso-countries";
import { fetchRetry } from "./http";

const BASE = "https://api.imf.org/external/sdmx/2.1";
const CSV_TYPE = "application/vnd.sdmx.data+csv;version=2.0.0";
const XML_TYPE = "application/vnd.sdmx.structure+xml;version=2.1";
const CPI_INDICATORS: Record<string, string> = {
  PCPI_IX: "CPI._T.IX",
  PCPI_PC_CP_A_PT: "CPI._T.YOY_PCH_PA_PT",
  PCPI_PC_PP_PT: "CPI._T.POP_PCH_PA_PT",
};

export interface ImfDataParams {
  databaseId: string;
  frequency?: "A" | "Q" | "M";
  countryCodes?: string[];
  indicator?: string;
  seriesKey?: string;
  startPeriod?: string;
  endPeriod?: string;
  limit?: number;
}

function flow(databaseId: string): { agency: string; id: string } {
  if (!/^(?:[A-Z][A-Z0-9_.]*:)?[A-Z][A-Z0-9_]*$/.test(databaseId)) {
    throw new Error("Invalid IMF dataset ID. Use CPI or a qualified ID such as IMF.RES:WEO.");
  }
  const [agency, id] = databaseId.includes(":")
    ? databaseId.split(":")
    : [databaseId === "WEO" ? "IMF.RES" : "IMF.STA", databaseId];
  if (id === "IFS") {
    throw new Error("IFS was discontinued as a single dataset. Use imf_list_datasets and imf_get_structure to select CPI, ER, ANEA, QNEA, or another current dataset.");
  }
  return { agency, id: id === "DOT" ? "IMTS" : id };
}

export function buildImfDataUrl(params: ImfDataParams): URL {
  const legacyCpi = params.databaseId === "IFS" && !!CPI_INDICATORS[params.indicator ?? ""];
  const dataset = flow(legacyCpi ? "CPI" : params.databaseId);
  let key = params.seriesKey;
  if (key && (params.indicator || params.countryCodes?.length)) {
    throw new Error("Use either series_key or country_codes/indicator, not both.");
  }
  if (!key) {
    if (dataset.id !== "CPI") {
      throw new Error("This dataset requires series_key in its current dimension order. Call imf_get_structure first; legacy indicator codes are not interchangeable with current IMF codes.");
    }
    if (!params.countryCodes?.length || params.countryCodes.length > 20) {
      throw new Error("CPI convenience queries require 1–20 country_codes (ISO2 or ISO3).");
    }
    const codes = params.countryCodes.map(code => {
      const upper = code.toUpperCase();
      const iso3 = upper.length === 2 ? countries.alpha2ToAlpha3(upper) : upper;
      if (!iso3 || !countries.isValid(iso3)) throw new Error(`Invalid ISO country code: ${code}`);
      return iso3;
    });
    const indicator = CPI_INDICATORS[params.indicator ?? ""] ?? params.indicator ?? "CPI._T.YOY_PCH_PA_PT";
    if (!/^(?:CPI|CCPI|HICP)\.[A-Z0-9_]+\.[A-Z0-9_]+$/.test(indicator)) {
      throw new Error("For CPI, use PCPI_IX, PCPI_PC_CP_A_PT, PCPI_PC_PP_PT, or current middle dimensions such as CPI._T.YOY_PCH_PA_PT.");
    }
    key = `${[...new Set(codes)].join("+")}.${indicator}.${params.frequency ?? "A"}`;
  }
  if (key.length > 1000 || !/^[A-Z0-9_]+(?:\+[A-Z0-9_]+)*(?:\.[A-Z0-9_]+(?:\+[A-Z0-9_]+)*)+$/.test(key)) {
    throw new Error("Invalid series_key. Specify explicit dimension codes separated by dots; combine codes with +. Wildcard dimensions are not supported.");
  }
  if(key.split('.').reduce((n,k)=>n*new Set(k.split('+')).size,1)>50)throw new Error('IMF selection exceeds 50 series; narrow the query before downloading.');
  for (const period of [params.startPeriod, params.endPeriod]) {
    if (period && !/^\d{4}(?:-(?:0[1-9]|1[0-2]|M(?:0[1-9]|1[0-2])|Q[1-4]))?$/.test(period)) {
      throw new Error("Invalid period. Use YYYY, YYYY-MM, YYYY-Mmm, or YYYY-Qq.");
    }
  }
  const limit = params.limit ?? 36;
  const order=(p:string)=>p.replace('-M','-').replace(/-Q([1-4])/,(_,q)=>'-'+String(Number(q)*3).padStart(2,'0'));
  if(params.startPeriod&&params.endPeriod&&order(params.startPeriod)>order(params.endPeriod))throw new Error('start_period must not be after end_period.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 120) throw new Error("limit must be an integer from 1 to 120.");
  const url = new URL(`${BASE}/data/${dataset.agency},${dataset.id}/${key}`);
  if (params.startPeriod) url.searchParams.set("startPeriod", params.startPeriod);
  if (params.endPeriod) url.searchParams.set("endPeriod", params.endPeriod);
  url.searchParams.set("lastNObservations", String(limit));
  return url;
}

export function formatImfCsv(csv: string, url: URL, limit = 36): string {
  const header = parse(csv, { bom: true, to: 1 })[0] as string[] | undefined;
  if (!header?.includes("TIME_PERIOD") || !header.includes("OBS_VALUE")) {
    throw new Error("Unexpected IMF response: SDMX-CSV observation columns are missing.");
  }
  const rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true }) as Record<string, string>[];
  if (!rows.length) return `No IMF observations for this selection. Source: ${url}`;
  const columns = Object.keys(rows[0]);
  if (!columns.includes("TIME_PERIOD") || !columns.includes("OBS_VALUE")) {
    throw new Error("Unexpected IMF response: SDMX-CSV observation columns are missing.");
  }
  const dimensions = columns.slice(0, columns.indexOf("TIME_PERIOD")).filter(c => !["DATAFLOW", "STRUCTURE", "STRUCTURE_ID", "ACTION"].includes(c));
  const grouped = new Map<string, { metadata: string; observations: Map<string, string> }>();
  for (const row of rows) {
    if (!row.OBS_VALUE?.trim()) continue;
    if(!Number.isFinite(Number(row.OBS_VALUE)))throw new Error('IMF returned a non-numeric observation.');
    const id = [row.DATAFLOW ?? row.STRUCTURE_ID, ...dimensions.map(c => `${c}=${row[c]}`)].join(" | ");
    const metadata = ["UNIT", "SCALE", "REFERENCE_PERIOD", "COMMON_REFERENCE_PERIOD"].filter(c => row[c] !== undefined && row[c] !== "").map(c => `${c}=${row[c]}`).join(", ");
    if (!grouped.has(id)) grouped.set(id, { metadata, observations: new Map() });
    const group = grouped.get(id)!;
    if (group.metadata !== metadata) throw new Error("IMF returned differing units or reference periods within one series.");
    const value = `${row.OBS_VALUE}${row.STATUS ? ` [STATUS=${row.STATUS}]` : ""}`;
    if (group.observations.has(row.TIME_PERIOD) && group.observations.get(row.TIME_PERIOD) !== value) {
      throw new Error("IMF returned conflicting values for the same series and period.");
    }
    group.observations.set(row.TIME_PERIOD, value);
  }
  if (!grouped.size) return `No numeric IMF observations for this selection. Source: ${url}`;
  if (grouped.size > 50) throw new Error("IMF returned more than 50 series. Narrow your selection.");
  return [...grouped].map(([id, group]) => {
    const values = [...group.observations].sort(([a], [b]) => a.localeCompare(b)).slice(-limit);
    return `## IMF: ${id}\n${group.metadata}\n${values.map(([date, value]) => `${date}: ${value}`).join("\n")}`;
  }).join("\n\n") + `\n\nSource: International Monetary Fund\nURL: ${url}\nValues retain the reported SCALE (power of ten) and reference period. Cite the series, units, observation date, and source URL; preserve provisional/estimated STATUS flags.`;
}

function xmlStructures(xml: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected XML document type in IMF response.");
  const result = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true, processEntities: false }).parse(xml);
  const structures = result.Structure?.Structures;
  if (!structures) throw new Error("Unexpected IMF metadata response.");
  return structures;
}
function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function name(item: any): string {
  const names = list<any>(item?.Name);
  const n = names.find(n => n.lang === "en") ?? names[0];
  return typeof n === "string" ? n : String(n?.["#text"] ?? "");
}

export function formatImfDatasets(xml: string, query = ""): string {
  const structures = xmlStructures(xml);
  const flows = list<any>(structures.Dataflows?.Dataflow);
  const topics: Record<string, string> = { CPI: "inflation", ER: "exchange rate currency", ANEA: "GDP national accounts output", QNEA: "GDP national accounts output", IMTS: "trade", BOP: "balance of payments", WEO: "economic outlook forecasts GDP inflation" };
  const matches = rankCatalogue(flows,query,f=>({id:`${f.agencyID}:${f.id}`,name:name(f),description:topics[String(f.id).split('_')[0]]}));
  if (!matches.length) return "No matching IMF datasets. Try inflation, exchange rate, GDP, trade, or balance of payments.";
  return matches.slice(0, 100).map(f => `${f.agencyID}:${f.id} (version ${f.version}): ${name(f)}`).join("\n") + `\nShowing ${Math.min(matches.length,100)} of ${matches.length} matches. Call imf_get_structure before constructing series_key.\nSource: ${BASE}/dataflow/all/all/latest?references=none`;
}

export function formatImfStructure(xml: string, databaseId: string, dimensionId?: string, query = ""): string {
  const structures = xmlStructures(xml);
  const dataflow = list<any>(structures.Dataflows?.Dataflow)[0];
  const dsdRef = dataflow?.Structure?.Ref;
  const dsd = list<any>(structures.DataStructures?.DataStructure).find(d => d.id === dsdRef?.id && d.agencyID === dsdRef?.agencyID && String(d.version) === String(dsdRef?.version));
  if (!dsd) throw new Error("IMF metadata does not include the referenced data structure.");
  const dimensions = list<any>(dsd.DataStructureComponents?.DimensionList?.Dimension).sort((a,b) => Number(a.position)-Number(b.position));
  if (dimensionId && !dimensions.some(d => d.id === dimensionId)) throw new Error(`Unknown dimension ${dimensionId}. Available: ${dimensions.map(d => d.id).join(", ")}`);
  const schemes = list<any>(structures.Concepts?.ConceptScheme);
  const codelists = list<any>(structures.Codelists?.Codelist);
  const details = dimensions.filter(d => !dimensionId || d.id === dimensionId).map(d => {
    const ref = d.ConceptIdentity?.Ref;
    const scheme = schemes.find(s => s.id === ref?.maintainableParentID && s.agencyID === ref?.agencyID && String(s.version) === String(ref?.maintainableParentVersion));
    const concept = list<any>(scheme?.Concept).find(c => c.id === ref?.id);
    const enumRef = d.LocalRepresentation?.Enumeration?.Ref ?? concept?.CoreRepresentation?.Enumeration?.Ref;
    const codes = codelists.find(c => c.id === enumRef?.id && c.agencyID === enumRef?.agencyID && String(c.version) === String(enumRef?.version));
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = list<any>(codes?.Code).filter(c => terms.every(t => `${c.id} ${name(c)}`.toLowerCase().includes(t)));
    const count = dimensionId ? 60 : 5;
    return `${d.id}: ${entries.slice(0,count).map(c => `${c.id}=${name(c)}`).join("; ")}\nShowing ${Math.min(count,entries.length)} of ${entries.length} codes${codes ? "" : " (codelist unavailable)"}.`;
  });
  return `Dataset ${dataflow.agencyID}:${dataflow.id} (${name(dataflow)}, version ${dataflow.version})\nseries_key dimension order: ${dimensions.map(d => d.id).join(".")}\nUse IMF country/area codes shown here (usually ISO3). Specify every dimension explicitly; combine codes with +.\n\n${details.join("\n\n")}\n\nSource: ${structureUrl(databaseId)}`;
}

function structureUrl(databaseId: string): URL {
  const dataset = flow(databaseId);
  return new URL(`${BASE}/dataflow/${dataset.agency}/${dataset.id}/latest?references=all`);
}

async function request(url: URL, accept: string): Promise<string> {
  const response = await fetchRetry(url, { headers: { Accept: accept } });
  if (response.status === 404 || response.status === 204) throw new Error("No IMF data for this selection. Check the current dataset and dimension codes with imf_get_structure.");
  if (!response.ok) throw new Error(`IMF API error: ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error("IMF returned an empty response.");
  return text;
}

export async function fetchImfData(params: ImfDataParams): Promise<string> {
  const url = buildImfDataUrl(params);
  return formatImfCsv(await request(url, CSV_TYPE), url, params.limit ?? 36);
}
export async function fetchImfDatasets(query?: string): Promise<string> {
  const url = new URL(`${BASE}/dataflow/all/all/latest?references=none`);
  return formatImfDatasets(await request(url, XML_TYPE), query);
}
export async function fetchImfStructure(databaseId: string, dimensionId?: string, query?: string): Promise<string> {
  return formatImfStructure(await request(structureUrl(databaseId), XML_TYPE), databaseId, dimensionId, query);
}
