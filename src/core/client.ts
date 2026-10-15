import { createLayeredCache, type LayeredCache } from "./cache";
import {checkedJson,legacyFailure,worldBankPages,worldBankUrl,formatWorldBank,ecbUrl,formatEcb} from "./legacy";
import {AccessError,accessGovernor,type Provider} from "./access";
import {connectionHealth} from "./health";
import { buildImfDataUrl, fetchImfData, fetchImfDatasets, fetchImfStructure, type ImfDataParams } from "./imf";
import { OECD_CATALOG_URL, buildOecdDataUrl, buildOecdStructureUrl, formatOecdCsv, formatOecdDatasets, formatOecdStructure, requestOecd, type OecdDataParams } from "./oecd";
import { EUROSTAT_CATALOG_URL, buildEurostatDataUrl, buildEurostatStructureUrl, formatEurostatDatasets, formatEurostatStructure, formatEurostatJson, validateEurostatFilters, requestEurostat, type EurostatDataParams } from "./eurostat";
import { BIS_CATALOG_URL, buildBisDataUrl, buildBisStructureUrl, formatBisDatasets, formatBisStructure, getBisDefinition, validateBisKey, formatBisCsv, requestBis, type BisDataParams } from "./bis";
import {selectionEvidence,eiaObservationResponse} from "./selection-data";
import {selectSource, type SelectionParams} from "./selection";
import {buildEiaMetadataUrl,buildEiaDataUrl,validateEiaMetadata,validateEiaSelection,formatEiaRoutes,formatEiaMetadata,formatEiaFacets,formatEiaData,requestEia,type EiaDataParams} from "./eia";
import {fetchStructured} from './structured-data';
import {RevisionTracker} from './revisions';
import {ABS_CATALOG_URL,absCatalogue,absStructure,buildAbsStructureUrl,requestAbs,sdmxDefinition} from './abs';
import {dataSeries,finishResult} from './result';
import type {Retrieval} from './selection';

type FredUnits = "lin" | "pc1" | "pch" | "ch1" | "chg";

const CITATION_RULE =
  `CITATION RULE: Any number you state MUST come from this tool's data — NEVER from your training data. After every number, cite the source and date: (Source Name, Mon YYYY). Example: "unemployment was 4.3% (FRED: Unemployment Rate, Mar 2026)". If a number is not in the data above, do not state it.`;

const TTL = {
  fredSearch: 24 * 60 * 60,
  fredSeriesMeta: 24 * 60 * 60,
  fredSeriesHot: 15 * 60,
  fredSeriesStandard: 6 * 60 * 60,
  blsSeries: 6 * 60 * 60,
  blsLookup: 30 * 24 * 60 * 60,
  beaData: 12 * 60 * 60,
  imfData: 24 * 60 * 60,
  oecdData: 24 * 60 * 60,
  oecdMetadata: 7 * 24 * 60 * 60,
  eurostatData: 6 * 60 * 60,
  eurostatMetadata: 24 * 60 * 60,
  bisData: 6 * 60 * 60,
  bisMetadata: 7 * 24 * 60 * 60,
  eiaData: 60 * 60,
  eiaMetadata: 24 * 60 * 60,
  worldBankData: 7 * 24 * 60 * 60,
  worldBankSearch: 7 * 24 * 60 * 60,
  ecbData: 24 * 60 * 60,
  inflationAdjust: 30 * 24 * 60 * 60,
  releaseCalendar: 15 * 60,
} as const;

const HOT_FRED_SERIES = new Set([
  "PAYEMS",
  "UNRATE",
  "CPIAUCSL",
  "CPILFESL",
  "GDPC1",
  "A191RL1Q225SBEA",
  "JTSJOL",
  "PCEPILFE",
]);

function cited(source: string, title: string, data: string): string {
  return `SOURCE: ${title}\nURL: ${source}\n\n${data}\n\n${CITATION_RULE}`;
}

export class EconStatsCoreClient {
  private cache: LayeredCache;
  private revisions=new RevisionTracker();

  constructor(
    private env: {FRED_KEY?:string;BLS_KEY?:string;BEA_KEY?:string;EIA_KEY?:string} = {
      FRED_KEY: process.env.FRED_API_KEY,
      BLS_KEY: process.env.BLS_API_KEY,
      BEA_KEY: process.env.BEA_API_KEY,
      EIA_KEY: process.env.EIA_API_KEY,
    },
    cache = createLayeredCache(),
  ) {
    this.cache = cache;
  }


  private async legacyCall(provider:Provider,work:()=>Promise<string>):Promise<string>{
    try{return await work();}catch(error){
      const kind=error instanceof AccessError?error.kind:"invalid_response";
      if(kind!=="budget_exhausted"&&kind!=="rate_limited")await accessGovernor().record(provider,kind).catch(()=>{});
      return `${provider} error: ${error instanceof AccessError?error.message:"Invalid response or request; check parameters and provider metadata."}`;
    }
  }
  async connectionHealth(sources?:Provider[],probe=false){return JSON.stringify(await connectionHealth(this.env,sources,probe),null,2);}
  async fredSearch(query:string){return this.legacyCall("FRED",()=>this.fredSearchUnsafe(query));}
  async fredGetSeries(seriesId:string,limit:number,units:FredUnits){return this.legacyCall("FRED",()=>this.fredGetSeriesUnsafe(seriesId,limit,units));}
  async blsGetSeries(seriesIds:string[],startYear?:string,endYear?:string){return this.legacyCall("BLS",()=>this.blsGetSeriesUnsafe(seriesIds,startYear,endYear));}
  async beaGetData(dataset:"NIPA"|"Regional"|"GDPbyIndustry",tableName:string,frequency:"A"|"Q"|"M",year:string){return this.legacyCall("BEA",()=>this.beaGetDataUnsafe(dataset,tableName,frequency,year));}
  async inflationAdjust(amount:number,fromDate:string,toDate:string){return this.legacyCall("FRED",()=>this.inflationAdjustUnsafe(amount,fromDate,toDate));}
  async checkReleaseCalendar(){return this.legacyCall("FRED",()=>this.checkReleaseCalendarUnsafe());}

  private fredSeriesTtl(seriesId: string): number {
    return HOT_FRED_SERIES.has(seriesId) ? TTL.fredSeriesHot : TTL.fredSeriesStandard;
  }

  async selectSource(params: SelectionParams): Promise<string> {
    return JSON.stringify(await selectSource(params,{FRED:!!this.env.FRED_KEY,BEA:!!this.env.BEA_KEY,EIA:!!this.env.EIA_KEY},async r=>{
      const e=await selectionEvidence(r,this.env,this.cache);
      const s=dataSeries(`verified:${e.measure}`,{...e.dimensions,country:e.country},e.urls[0],{frequency:e.frequency,unit:e.unit,unitMultiplier:e.unitMultiplier,adjustment:e.adjustment,transformation:e.transformation,urls:e.urls,notes:e.notes,observations:e.observations.map(o=>({...o,attributes:o.attributes??{}}))});
      const tracked=await this.revisions.track(finishResult(e.source,{},[s],e.retrievedAt,120));
      return {...e,revision:tracked.series[0].revision};
    }),null,2);
  }

  async getStructuredData(request:Retrieval,fresh=false){return this.revisions.track(await fetchStructured(request,this.env,this.cache,fresh));}
  async revisionHistory(seriesId:string,limit=10){return this.revisions.history(seriesId,limit);}
  async absListDatasets(query?:string,offset=0,limit=20){
    const xml=await this.cache.getOrCompute('abs:catalog:v1',86400,async()=>{const xml=await requestAbs(ABS_CATALOG_URL);absCatalogue(xml);return xml;});return absCatalogue(xml,query,offset,limit);
  }
  async absGetStructure(id:string,version?:string,dimensionId?:string,query?:string,offset=0,limit=50){
    const url=buildAbsStructureUrl(id,version),xml=await this.cache.getOrCompute(`abs:structure:v1:${url}`,86400,async()=>{const xml=await requestAbs(url);sdmxDefinition(xml,id,'ABS',version);return xml;});
    return absStructure(xml,id,version,dimensionId,query,offset,limit);
  }

  private async fredSearchUnsafe(query: string): Promise<string> {
    if (!this.env.FRED_KEY) throw new AccessError("FRED","missing_key","FRED_API_KEY is not configured.");

    const key = `fred:search:${query.trim().toLowerCase()}`;
    return this.cache.getOrCompute(key, TTL.fredSearch, async () => {
      const res = await checkedJson(
        `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(query)}&api_key=${this.env.FRED_KEY}&file_type=json&limit=8`,
      );
      const data = res;
      if(!Array.isArray(data.seriess))legacyFailure("FRED","invalid_response","Missing FRED search results.");
      return (
        data.seriess
          ?.map(
            (s: { id: string; title: string; frequency: string; units: string }) =>
              `${s.id}: ${s.title} (${s.frequency}, ${s.units})`,
          )
          .join("\n") ?? "No results"
      );
    });
  }

  private async fredGetSeriesUnsafe(
    seriesId: string,
    limit: number,
    units: FredUnits,
  ): Promise<string> {
    if (!this.env.FRED_KEY) throw new AccessError("FRED","missing_key","FRED_API_KEY is not configured.");

    if(!/^[A-Za-z0-9_]{1,100}$/.test(seriesId)||!Number.isInteger(limit)||limit<1||limit>5000||!["lin","pc1","pch","ch1","chg"].includes(units))throw new Error("Invalid FRED series, transformation or observation limit.");
    const obsKey = `fred:obs:v3:${seriesId}:limit=${limit}:units=${units}`;
    const infoKey = `fred:info:v3:${seriesId}`;

    const [obsText, infoText] = await Promise.all([
      this.cache.getOrCompute(obsKey, this.fredSeriesTtl(seriesId), async () => {
        const res = await checkedJson(
          `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${this.env.FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}&units=${units}`,
        );
        if(!Array.isArray(res.observations)||res.observations.some((r:any)=>typeof r.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||r.value!=="."&&!Number.isFinite(Number(r.value))))legacyFailure("FRED","invalid_response","Invalid FRED observation schema.");
        return JSON.stringify(res);
      }),
      this.cache.getOrCompute(infoKey, TTL.fredSeriesMeta, async () => {
        const res = await checkedJson(
          `https://api.stlouisfed.org/fred/series?series_id=${seriesId}&api_key=${this.env.FRED_KEY}&file_type=json`,
        );
        if(!Array.isArray(res.seriess)||res.seriess[0]?.id!==seriesId)legacyFailure("FRED","invalid_response","Missing or unexpected FRED series metadata.");
        return JSON.stringify(res);
      }),
    ]);

    const data = JSON.parse(obsText);
    if (data.error_code) return data.error_message || "FRED error";

    let title = seriesId;
    try {
      const info = JSON.parse(infoText);
      const series = info.seriess?.[0];
      if (series?.title) title = series.title;
    } catch {}

    const suffixes: Partial<Record<FredUnits, string>> = {
      pc1: " (YoY % Change)",
      pch: " (% Change)",
      chg: " (Change)",
      ch1: " (Change from Year Ago)",
    };
    if (units !== "lin" && suffixes[units]) title += suffixes[units];

    const observations = (data.observations ?? []) as { date: string; value: string }[];
    const lines = observations
      .filter((observation) => observation.value !== ".")
      .map((observation) => `${observation.date}: ${observation.value}`)
      .join("\n");

    return cited(
      `https://fred.stlouisfed.org/series/${seriesId}`,
      `FRED: ${title}`,
      lines,
    );
  }

  private async blsGetSeriesUnsafe(
    seriesIds: string[],
    startYear?: string,
    endYear?: string,
  ): Promise<string> {
    const currentYear = new Date().getFullYear();
    const sy = startYear ?? String(currentYear - 3);
    const ey = endYear ?? String(currentYear);
    if(!seriesIds.length||seriesIds.length>50||seriesIds.some(s=>!/^[A-Za-z0-9]{8,35}$/.test(s))||!/^\d{4}$/.test(sy)||!/^\d{4}$/.test(ey)||Number(sy)>Number(ey))throw new Error("Invalid BLS series IDs or years.");
    const key = `bls:series:v3:${seriesIds.join(",")}:start=${sy}:end=${ey}`;

    return this.cache.getOrCompute(key, TTL.blsSeries, async () => {
      const body: Record<string, unknown> = {
        seriesid: seriesIds,
        startyear: sy,
        endyear: ey,
        calculations: true,
        catalog: !seriesIds.some((id) => id.startsWith("JT")),
      };
      if (this.env.BLS_KEY) body.registrationkey = this.env.BLS_KEY;

      const res = await checkedJson("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = res;
      if (data.status !== "REQUEST_SUCCEEDED") {
        legacyFailure("BLS","request_rejected","BLS rejected the query.");
      }

      if(!Array.isArray(data.Results?.series))legacyFailure("BLS","invalid_response","Missing BLS series array.");
      const results = data.Results.series.map(
        (series: {
          seriesID: string;
          catalog?: { series_title?: string };
          data: {
            year: string;
            period: string;
            value: string;
            calculations?: {
              pct_changes?: Record<string, string>;
              net_changes?: Record<string, string>;
            };
          }[];
        }) => {
          const sid = series.seriesID;
          if(!seriesIds.includes(sid)||!Array.isArray(series.data))legacyFailure("BLS","invalid_response","Unexpected BLS series or missing observations.");
          const isIndex = sid.startsWith("CU") || sid.startsWith("WP") || sid.startsWith("PC");
          const isEmployment = sid.startsWith("CE") || sid.startsWith("SM");
          const title = series.catalog?.series_title ?? sid;

          const lines = series.data
            .filter((row) => row.period !== "M13" && row.value !== "-" && row.value !== "")
            .map((row) => {
              if(!/^\d{4}$/.test(row.year)||!Number.isFinite(Number(row.value)))legacyFailure("BLS","invalid_response","Invalid BLS year or numeric observation.");
              const date = row.period.startsWith("M")
                ? `${row.year}-${row.period.slice(1)}`
                : row.year;
              let display = row.value;
              if (isIndex) {
                const yoy = row.calculations?.pct_changes?.["12"];
                if (yoy && yoy !== "") display = `${yoy}% YoY (index: ${row.value})`;
              } else if (isEmployment) {
                const change = row.calculations?.net_changes?.["1"];
                if (change && change !== "") display = `${change} change (level: ${row.value})`;
              }
              return `${date}: ${display}`;
            })
            .join("\n");

          let label = title;
          if (isIndex) label += " (YoY % Change)";
          else if (isEmployment) label += " (Monthly Change)";

          return `## ${label} (${sid})\nSource: https://data.bls.gov/timeseries/${sid}\nYears: ${sy}–${ey}; series definitions and units are identified by the catalogue title/series ID.\nRetrieved: ${new Date().toISOString()}\n\n${lines}`;
        },
      );

      return results.join("\n\n---\n\n") + "\n\n" + CITATION_RULE;
    });
  }

  async blsSeriesLookup(query: string): Promise<string> {
    const key = `bls:lookup:${query.trim().toLowerCase()}`;
    return this.cache.getOrCompute(key, TTL.blsLookup, async () => {
      const catalog: Record<string, string> = {
        CUSR0000SA0: "CPI All items, US, SA",
        CUSR0000SA0L1E: "CPI Core (less food and energy), US, SA",
        CUSR0000SAH1: "CPI Shelter, US, SA",
        CUSR0000SAF11: "CPI Food at home, US, SA",
        CUSR0000SAM: "CPI Medical care, US, SA",
        CUSR0000SAT: "CPI Transportation, US, SA",
        CUSR0000SETB01: "CPI Gasoline, US, SA",
        CUSR0000SEHA: "CPI Rent of primary residence, US, SA",
        CUSR0000SEHC: "CPI Owners equivalent rent, US, SA",
        CES0000000001: "Total nonfarm employment, SA",
        CES0500000003: "Avg hourly earnings, all private, SA",
        CES2000000001: "Construction employment, SA",
        CES3000000001: "Manufacturing employment, SA",
        CES6562000001: "Health care employment, SA",
        CES7000000001: "Leisure and hospitality employment, SA",
        LNS14000000: "Unemployment rate (U-3), SA",
        LNS13327709: "U-6 underemployment rate, SA",
        LNS12300060: "Prime-age (25-54) EPOP, SA",
        LNS14000006: "Unemployment rate, Black, SA",
        LNS14000009: "Unemployment rate, Hispanic, SA",
        JTS000000000000000JOL: "Job openings, total nonfarm",
        JTS000000000000000QUL: "Quits, total nonfarm",
      };

      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
      const matches = Object.entries(catalog)
        .filter(([, title]) => terms.every((term) => title.toLowerCase().includes(term)))
        .map(([id, title]) => `${id}: ${title}`);

      const cpiRef =
        "CPI area codes: S12A=NYC, S11A=Boston, S23A=Chicago, S23B=Detroit, S35A=DC, S35B=Miami, S37A=Dallas, S37B=Houston, S49A=LA, S49B=SF, S49D=Seattle. Format: CU+UR/SR+area+item. Example: CUURS12ASAF11 = NYC Food at home";

      return matches.length > 0
        ? matches.join("\n") + "\n\n" + cpiRef
        : "No matches in quick catalog.\n\n" + cpiRef;
    });
  }

  private async beaGetDataUnsafe(
    dataset: "NIPA" | "Regional" | "GDPbyIndustry",
    tableName: string,
    frequency: "A" | "Q" | "M",
    year: string,
  ): Promise<string> {
    if (!this.env.BEA_KEY) throw new AccessError("BEA","missing_key","BEA_API_KEY is not configured.");

    if(!/^[A-Za-z0-9_]{1,100}$/.test(tableName)||!/^[AQM]$/.test(frequency)||!(/^(?:ALL|LAST5|\d{4}(?:,\d{4})*)$/.test(year)))throw new Error("Invalid BEA table, frequency or years.");
    const resolvedYear=year==="LAST5"?Array.from({length:5},(_,i)=>String(new Date().getUTCFullYear()-i)).join(","):year;
    const key = `bea:data:v3:${dataset}:table=${tableName}:freq=${frequency}:year=${resolvedYear}`;
    return this.cache.getOrCompute(key, TTL.beaData, async () => {
      const params = new URLSearchParams({
        UserID: this.env.BEA_KEY!,
        method: "GetData",
        DataSetName: dataset,
        TableName: tableName,
        Frequency: frequency,
        Year: resolvedYear,
        ResultFormat: "JSON",
      });
      const res = await checkedJson(`https://apps.bea.gov/api/data/?${params}`);
      const data = res;
      const beaData = data?.BEAAPI?.Results;
      if (beaData?.Error) {
        legacyFailure("BEA","request_rejected","BEA rejected the query.");
      }

      if(!Array.isArray(beaData?.Data))legacyFailure("BEA","invalid_response","Missing BEA Data array.");
      const rows = beaData.Data as {
        LineDescription: string;
        TimePeriod: string;
        DataValue: string;
      }[];
      const byLine = new Map<string, {unit:string;values:string[]}>();let missing=0;
      for (const row of rows) {
        const line = row.LineDescription ?? "Data";
        const unit=["CL_UNIT","UNIT_MULT","METRIC_NAME"].filter(k=>(row as any)[k]!==undefined).map(k=>`${k}=${(row as any)[k]}`).join("; ")||"Units not supplied on row; inspect the table definition.";
        if (!byLine.has(line)) byLine.set(line, {unit,values:[]});
        if(byLine.get(line)!.unit!==unit)legacyFailure("BEA","invalid_response","BEA line units changed within this query.");
        const value = row.DataValue?.replace(/,/g, "");
        if (value && value !== "---") {
          if(!Number.isFinite(Number(value))||!row.TimePeriod)legacyFailure("BEA","invalid_response","Invalid BEA numeric observation or time period.");
          byLine.get(line)!.values.push(`${row.TimePeriod}: ${value}`);
        }else missing++;
      }

      return Array.from(byLine.entries())
        .slice(0, 15)
        .map(([line, observations]) => `## BEA: ${line}\n${observations.unit}\n${observations.values.sort().join("\n")}`)
        .join("\n\n")+`\nSource: Bureau of Economic Analysis\nDataset: ${dataset}; table=${tableName}; frequency=${frequency}; years=${resolvedYear}\nURL: https://apps.bea.gov/api/data/?method=GetData&DataSetName=${encodeURIComponent(dataset)}&TableName=${encodeURIComponent(tableName)}&Frequency=${frequency}&Year=${encodeURIComponent(resolvedYear)}&ResultFormat=JSON (API key omitted)\nRetrieved: ${new Date().toISOString()}\nShowing up to 15 table lines; units/scaling: ${JSON.stringify((beaData.Dimensions??[]).filter((d:any)=>/unit|metric/i.test(d.Name??"")))}. Retain the table definition; no automatic unit conversion.`;
    });
  }

  async imfGetData(params: ImfDataParams): Promise<string> {
    try {
      const url = buildImfDataUrl(params);
      return await this.cache.getOrCompute(`imf:sdmx21:v1:${url}`, TTL.imfData, () => fetchImfData(params));
    } catch (error) {
      return `IMF error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async imfListDatasets(query?: string): Promise<string> {
    try {
      return await this.cache.getOrCompute(`imf:catalog:v1:${query ?? ""}`, TTL.imfData, () => fetchImfDatasets(query));
    } catch (error) {
      return `IMF error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async imfGetStructure(databaseId: string, dimensionId?: string, query?: string): Promise<string> {
    try {
      const key = JSON.stringify([databaseId, dimensionId, query]);
      return await this.cache.getOrCompute(`imf:structure:v1:${key}`, TTL.imfData, () => fetchImfStructure(databaseId, dimensionId, query));
    } catch (error) {
      return `IMF error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async oecdListDatasets(query?: string, offset = 0, limit = 20): Promise<string> {
    try {
      // Cache the catalogue once; different searches share the same upstream download.
      const xml = await this.cache.getOrCompute("oecd:catalog:v1", TTL.oecdMetadata, async () => {
        const text = await requestOecd(OECD_CATALOG_URL, true);
        formatOecdDatasets(text); // Reject malformed responses before caching.
        return text;
      });
      return formatOecdDatasets(xml, query, offset, limit);
    } catch (error) {
      return `OECD error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async oecdGetStructure(datasetId: string, version?: string, dimensionId?: string, query?: string): Promise<string> {
    try {
      const url = buildOecdStructureUrl(datasetId, version);
      const xml = await this.cache.getOrCompute(`oecd:structure:v1:${url}`, TTL.oecdMetadata, async () => {
        const text = await requestOecd(url, true);
        formatOecdStructure(text, datasetId, version);
        return text;
      });
      return formatOecdStructure(xml, datasetId, version, dimensionId, query);
    } catch (error) {
      return `OECD error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async oecdGetData(params: OecdDataParams): Promise<string> {
    try {
      const url = buildOecdDataUrl(params);
      return await this.cache.getOrCompute(`oecd:data:v1:${url}:limit=${params.limit ?? 36}`, TTL.oecdData, async () => formatOecdCsv(await requestOecd(url), url, params.limit));
    } catch (error) {
      return `OECD error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async eurostatListDatasets(query?: string, offset = 0, limit = 20): Promise<string> {
    try {
      const tsv = await this.cache.getOrCompute("eurostat:catalog:v1", TTL.eurostatMetadata, async () => {
        // The complete English catalogue is slower than filtered metadata/data.
        const text = await requestEurostat(EUROSTAT_CATALOG_URL,55000);
        formatEurostatDatasets(text);
        return text;
      });
      return formatEurostatDatasets(tsv,query,offset,limit);
    } catch (error) {
      return `Eurostat error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  private async eurostatStructureXml(datasetId: string): Promise<string> {
    const url = buildEurostatStructureUrl(datasetId);
    return this.cache.getOrCompute(`eurostat:structure:v1:${url}`,TTL.eurostatMetadata,async()=>{
      const text = await requestEurostat(url);
      formatEurostatStructure(text,datasetId);
      return text;
    });
  }

  async eurostatGetStructure(datasetId: string, dimensionId?: string, query?: string): Promise<string> {
    try {
      return formatEurostatStructure(await this.eurostatStructureXml(datasetId),datasetId,dimensionId,query);
    } catch (error) {
      return `Eurostat error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async eurostatGetData(params: EurostatDataParams): Promise<string> {
    try {
      const url = buildEurostatDataUrl(params);
      return await this.cache.getOrCompute(`eurostat:data:v1:${url}:limit=${params.limit??36}`,TTL.eurostatData,async()=>{
        validateEurostatFilters(await this.eurostatStructureXml(params.datasetId),params);
        return formatEurostatJson(JSON.parse(await requestEurostat(url)),url,params);
      });
    } catch (error) {
      return `Eurostat error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async bisListDatasets(query?: string, offset = 0, limit = 20): Promise<string> {
    try {
      const xml = await this.cache.getOrCompute("bis:catalog:v1",TTL.bisMetadata,async()=>{
        const text = await requestBis(BIS_CATALOG_URL);
        formatBisDatasets(text);
        return text;
      });
      return formatBisDatasets(xml,query,offset,limit);
    } catch (error) {
      return `BIS error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  private async bisStructureXml(id: string, version?: string): Promise<string> {
    const url = buildBisStructureUrl(id,version);
    return this.cache.getOrCompute(`bis:structure:v1:${url}`,TTL.bisMetadata,async()=>{
      const text = await requestBis(url);
      getBisDefinition(text,id,version);
      return text;
    });
  }

  async bisGetStructure(id: string, version?: string, dimensionId?: string, query?: string): Promise<string> {
    try {
      return formatBisStructure(await this.bisStructureXml(id,version),id,version,dimensionId,query);
    } catch (error) {
      return `BIS error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  async bisGetData(params: BisDataParams): Promise<string> {
    try {
      buildBisDataUrl(params);
      const def = getBisDefinition(await this.bisStructureXml(params.datasetId,params.version),params.datasetId,params.version);
      validateBisKey(def,params.seriesKey);
      const url = buildBisDataUrl({...params,version:def.version});
      return await this.cache.getOrCompute(`bis:data:v1:${url}:limit=${params.limit??36}`,TTL.bisData,async()=>
        formatBisCsv(await requestBis(url),url,params,def));
    } catch (error) {
      return `BIS error: ${error instanceof Error ? error.message : "Request failed"}`;
    }
  }

  private async eiaMetadata(route:string):Promise<any>{
    if(!this.env.EIA_KEY)throw new Error("EIA_API_KEY is not configured. Get a free key at https://www.eia.gov/opendata/register.php and save it in the local .env file.");
    const url=buildEiaMetadataUrl(route);
    return this.cache.getOrCompute(`eia:metadata:v1:${url}`,TTL.eiaMetadata,async()=>{
      const data=await requestEia(url,this.env.EIA_KEY);validateEiaMetadata(data);return data;
    });
  }

  async eiaListRoutes(route="",query?:string,offset=0,limit=20):Promise<string>{
    try{return formatEiaRoutes(await this.eiaMetadata(route),route,query,offset,limit);}
    catch(e){return `EIA error: ${e instanceof Error?e.message:"Lookup failed"}`;}
  }

  async eiaGetMetadata(route:string,facet?:string,query?:string,offset=0,limit=30):Promise<string>{
    try{
      const meta=await this.eiaMetadata(route);
      if(!facet)return formatEiaMetadata(meta,route);
      if(!meta.facets?.some((f:any)=>f.id===facet))throw new Error("Unknown EIA facet. Inspect route metadata.");
      const url=buildEiaMetadataUrl(route,facet);
      const data=await this.cache.getOrCompute(`eia:facet:v1:${url}`,TTL.eiaMetadata,async()=>{
        const response=await requestEia(url,this.env.EIA_KEY);formatEiaFacets(response,url);return response;
      });
      return formatEiaFacets(data,url,query,offset,limit);
    }catch(e){return `EIA error: ${e instanceof Error?e.message:"Lookup failed"}`;}
  }

  async eiaGetData(params:EiaDataParams):Promise<string>{
    try{
      const url=buildEiaDataUrl(params),meta=await this.eiaMetadata(params.route);
      validateEiaSelection(meta,params);
      return await this.cache.getOrCompute(`eia:data:v2:${url}`,TTL.eiaData,async()=>formatEiaData((await eiaObservationResponse(this.cache,url,params,meta,this.env.EIA_KEY)).data,url,params,meta));
    }catch(e){return `EIA error: ${e instanceof Error?e.message:"Lookup failed"}`;}
  }


  async worldBankGetData(params:{countryCodes:string[];indicator:string;startYear?:number;endYear?:number}):Promise<string>{
    return this.legacyCall("WORLD_BANK",async()=>{
      const url=worldBankUrl(params);
      return this.cache.getOrCompute(`worldbank:data:v3:${url}`,TTL.worldBankData,async()=>{
        const metaUrl=new URL(`https://api.worldbank.org/v2/indicator/${params.indicator}?format=json&source=2&per_page=100`);
        const meta=await this.cache.getOrCompute(`worldbank:definition:v3:${metaUrl}`,TTL.worldBankData,async()=>{
          const result=await worldBankPages(metaUrl),definition=result.rows.find((r:any)=>r.id===params.indicator);
          if(!definition)legacyFailure("WORLD_BANK","request_rejected","Indicator is not in World Development Indicators (source 2).");return definition;
        });
        const page=await worldBankPages(url);return formatWorldBank(page.rows,meta,url,page.updated,page.pages);
      });
    });
  }
  async worldBankSearch(query:string):Promise<string>{
    return this.legacyCall("WORLD_BANK",async()=>{
      const url=new URL("https://api.worldbank.org/v2/indicator?format=json&source=2&per_page=1000");
      const catalogue=await this.cache.getOrCompute("worldbank:catalog:v3",TTL.worldBankSearch,()=>worldBankPages(url));
      const terms=query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches=catalogue.rows.filter((r:any)=>terms.every(t=>`${r.id} ${r.name} ${r.sourceNote??""}`.toLowerCase().includes(t)));
      const score=(r:any)=>(String(r.name).toLowerCase().replace(/[^a-z0-9]+/g," ").trim()===terms.join(" ")?1000:0)+terms.reduce((s,t)=>s+(`${r.id} ${r.name}`.toLowerCase().includes(t)?10:0),0);
      matches.sort((a:any,b:any)=>score(b)-score(a)||a.id.localeCompare(b.id));
      return `${matches.slice(0,30).map((r:any)=>`${r.id}: ${r.name}`).join("\n")||"No matching WDI indicators."}\nShowing ${Math.min(30,matches.length)} of ${matches.length} matches across the complete downloaded WDI catalogue (${catalogue.pages} pages).\nSource: ${url}\nCatalogue updated: ${catalogue.updated}`;
    });
  }
  async ecbGetData(params:{flowRef:string;key:string;startPeriod?:string;endPeriod?:string}):Promise<string>{
    return this.legacyCall("ECB",async()=>{
      const url=ecbUrl(params);
      return this.cache.getOrCompute(`ecb:data:v3:${url}`,TTL.ecbData,async()=>formatEcb(await checkedJson(url,{headers:{Accept:"application/json"}}),url));
    });
  }

  private async inflationAdjustUnsafe(
    amount: number,
    fromDate: string,
    toDate: string,
  ): Promise<string> {
    if (!this.env.FRED_KEY) throw new AccessError("FRED","missing_key","FRED_API_KEY is not configured.");

    const key = `inflation:adjust:${amount}:from=${fromDate}:to=${toDate}`;
    return this.cache.getOrCompute(key, TTL.inflationAdjust, async () => {
      const [fromRes, toRes] = await Promise.all([
        checkedJson(
          `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${this.env.FRED_KEY}&file_type=json&observation_start=${fromDate}&observation_end=${fromDate}&limit=1`,
        ),
        checkedJson(
          `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${this.env.FRED_KEY}&file_type=json&observation_start=${toDate}&observation_end=${toDate}&limit=1`,
        ),
      ]);

      const fromData = fromRes;
      const toData = toRes;
      const fromCpi = parseFloat(fromData.observations?.[0]?.value);
      const toCpi = parseFloat(toData.observations?.[0]?.value);
      if (isNaN(fromCpi) || isNaN(toCpi)) {
        legacyFailure("FRED","request_rejected","CPI data not available for requested dates.");
      }

      const adjusted = amount * (toCpi / fromCpi);
      const cumulativeInflation = ((toCpi / fromCpi) - 1) * 100;
      return `$${amount} from ${fromDate} = $${adjusted.toFixed(2)} in ${toDate} dollars\nCPI ${fromDate}: ${fromCpi}\nCPI ${toDate}: ${toCpi}\nCumulative inflation: ${cumulativeInflation.toFixed(1)}%`;
    });
  }

  private async checkReleaseCalendarUnsafe(): Promise<string> {
    if (!this.env.FRED_KEY) throw new AccessError("FRED","missing_key","FRED_API_KEY is not configured.");

    const key = `fred:release-calendar:${new Date().toISOString().slice(0, 10)}`;
    return this.cache.getOrCompute(key, TTL.releaseCalendar, async () => {
      const releases = [
        { id: 50, name: "Employment Situation", source: "BLS" },
        { id: 10, name: "CPI", source: "BLS" },
        { id: 46, name: "PPI", source: "BLS" },
        { id: 53, name: "GDP", source: "BEA" },
        { id: 54, name: "Personal Income", source: "BEA" },
        { id: 127, name: "JOLTS", source: "BLS" },
      ];
      const today = new Date().toISOString().slice(0, 10);
      const results: string[] = [];

      for (const release of releases) {
        try {
          const res = await checkedJson(
            `https://api.stlouisfed.org/fred/release/dates?release_id=${release.id}&api_key=${this.env.FRED_KEY}&file_type=json&sort_order=desc&limit=3`,
          );
          const data = res;
          const dates = data.release_dates?.map((item: { date: string }) => item.date) ?? [];
          const isToday = dates.includes(today);
          results.push(
            `${release.name}: last=${dates[0] ?? "?"}${isToday ? ` ** RELEASED TODAY — use ${release.source} direct **` : ""}`,
          );
        } catch(error) {throw error;}
      }

      return `Today: ${today}\n\n${results.join("\n")}`;
    });
  }

  async prefetchReleaseDaySeries(): Promise<void> {
    if (!this.env.FRED_KEY) return;

    const hotSeries = [
      { id: "PAYEMS", units: "chg" as const },
      { id: "UNRATE", units: "lin" as const },
      { id: "CPIAUCSL", units: "pc1" as const },
      { id: "CPILFESL", units: "pc1" as const },
      { id: "GDPC1", units: "lin" as const },
      { id: "A191RL1Q225SBEA", units: "lin" as const },
      { id: "JTSJOL", units: "lin" as const },
      { id: "PCEPILFE", units: "pc1" as const },
    ];

    console.error(`Pre-fetching ${hotSeries.length} release-day series...`);
    for (const series of hotSeries) {
      try {
        await this.fredGetSeries(series.id, 36, series.units);
      } catch {}
    }
    console.error("Pre-fetch complete.");
  }
}
