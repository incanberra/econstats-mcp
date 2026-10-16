import { afterEach, describe, expect, test } from "bun:test";
import { buildImfDataUrl, formatImfCsv, formatImfDatasets, formatImfStructure } from "../src/core/imf";
import { EconStatsCoreClient } from "../src/core/client";

const url = new URL("https://api.imf.org/external/sdmx/2.1/data/IMF.STA,CPI/USA.CPI._T.IX.M");
test('IMF bounds Cartesian selections and rejects reversed ranges before downloading',()=>{
 expect(()=>buildImfDataUrl({databaseId:'CPI',seriesKey:Array.from({length:51},(_,i)=>'A'+i).join('+')+'.CPI._T.IX.M'})).toThrow('50 series');
 expect(()=>buildImfDataUrl({databaseId:'CPI',seriesKey:'USA.CPI._T.IX.M',startPeriod:'2026-09',endPeriod:'2026-01'})).toThrow('start_period');
});
const header = "DATAFLOW,COUNTRY,INDEX_TYPE,COICOP_1999,TYPE_OF_TRANSFORMATION,FREQUENCY,TIME_PERIOD,OBS_VALUE,SCALE,UNIT,REFERENCE_PERIOD,STATUS,SERIES_NAME\n";
const csv = header +
  'IMF.STA:CPI(5.0.0),USA,CPI,_T,IX,M,2024-M03,141.9,0,IX,2010A,E,"Consumer prices, all items"\n' +
  'IMF.STA:CPI(5.0.0),GBR,CPI,_T,IX,M,2024-M01,135.1,0,IX,2010A,,"CPI with\na multiline label"\n' +
  'IMF.STA:CPI(5.0.0),USA,CPI,_T,IX,M,2024-M01,141.4,0,IX,2010A,,CPI\n' +
  'IMF.STA:CPI(5.0.0),USA,CPI,_T,IX,M,2024-M02,,0,IX,2010A,,CPI\n';
const xml = `<?xml version="1.0"?><mes:Structure xmlns:mes="m" xmlns:str="s" xmlns:com="c"><mes:Structures>
<str:Dataflows><str:Dataflow id="CPI" agencyID="IMF.STA" version="5.0.0"><com:Name xml:lang="fr">Prix</com:Name><com:Name xml:lang="en">Consumer prices</com:Name><str:Structure><Ref id="DSD_CPI" agencyID="IMF.STA" version="5.0.0"/></str:Structure></str:Dataflow></str:Dataflows>
<str:DataStructures><str:DataStructure id="OTHER" agencyID="IMF.STA" version="1.0.0"/><str:DataStructure id="DSD_CPI" agencyID="IMF.STA" version="5.0.0"><str:DataStructureComponents><str:DimensionList>
<str:Dimension id="FREQUENCY" position="1"><str:LocalRepresentation><str:Enumeration><Ref id="CL_FREQ" agencyID="IMF" version="1.0.0"/></str:Enumeration></str:LocalRepresentation></str:Dimension>
<str:Dimension id="COUNTRY" position="0"><str:ConceptIdentity><Ref id="COUNTRY" agencyID="IMF" maintainableParentID="CS" maintainableParentVersion="1.0.0"/></str:ConceptIdentity></str:Dimension>
</str:DimensionList></str:DataStructureComponents></str:DataStructure></str:DataStructures>
<str:Concepts><str:ConceptScheme id="CS" agencyID="IMF" version="1.0.0"><str:Concept id="COUNTRY"><str:CoreRepresentation><str:Enumeration><Ref id="CL_COUNTRY" agencyID="IMF" version="1.0.0"/></str:Enumeration></str:CoreRepresentation></str:Concept></str:ConceptScheme></str:Concepts>
<str:Codelists><str:Codelist id="CL_COUNTRY" agencyID="IMF" version="1.0.0"><str:Code id="USA"><com:Name xml:lang="en">United States</com:Name></str:Code><str:Code id="GBR"><com:Name xml:lang="en">United Kingdom</com:Name></str:Code></str:Codelist><str:Codelist id="CL_FREQ" agencyID="IMF" version="1.0.0"><str:Code id="M"><com:Name xml:lang="en">Monthly</com:Name></str:Code></str:Codelist></str:Codelists>
</mes:Structures></mes:Structure>`;

describe("current IMF request construction", () => {
  test("legacy CPI inflation maps to the observed current key and ISO3 codes", () => {
    const u = buildImfDataUrl({ databaseId: "IFS", countryCodes: ["US","GB","US"], indicator: "PCPI_PC_CP_A_PT", frequency: "M", startPeriod: "2024-01", endPeriod: "2024-03", limit: 3 });
    expect(u.pathname).toBe("/external/sdmx/2.1/data/IMF.STA,CPI/USA+GBR.CPI._T.YOY_PCH_PA_PT.M");
    expect(u.searchParams.get("startPeriod")).toBe("2024-01");
    expect(u.searchParams.get("endPeriod")).toBe("2024-03");
    expect(u.searchParams.get("lastNObservations")).toBe("3");
  });
  test("CPI index and period change remain distinct transformations", () => {
    for (const [indicator, part] of [["PCPI_IX", "IX"], ["PCPI_PC_PP_PT", "POP_PCH_PA_PT"]]) {
      expect(buildImfDataUrl({ databaseId:"CPI",countryCodes:["AU"],indicator }).pathname).toEndWith(`/AUS.CPI._T.${part}.A`);
    }
  });
  test("explicit current keys support arbitrary datasets and IMF area codes", () => {
    expect(buildImfDataUrl({ databaseId:"IMF.RES:WEO",seriesKey:"G001.NGDP_RPCH.A" }).pathname).toContain("IMF.RES,WEO/G001.NGDP_RPCH.A");
    expect(buildImfDataUrl({ databaseId:"DOT",seriesKey:"USA.CD_T.W00.USD.A" }).pathname).toContain("IMF.STA,IMTS/");
  });
  test("rejects unmapped old IFS and BOP indicator codes rather than guessing", () => {
    expect(() => buildImfDataUrl({databaseId:"IFS",countryCodes:["US"],indicator:"NGDP_XDC"})).toThrow("discontinued");
    expect(() => buildImfDataUrl({databaseId:"BOP",countryCodes:["US"],indicator:"BCA_BP6_USD"})).toThrow("series_key");
  });
  test("rejects ambiguous selectors, unknown ISO countries, invalid periods, and unsafe URLs", () => {
    expect(() => buildImfDataUrl({databaseId:"CPI",seriesKey:"USA.CPI._T.IX.M",countryCodes:["US"]})).toThrow("either");
    expect(() => buildImfDataUrl({databaseId:"CPI",countryCodes:["ZZ"]})).toThrow("country");
    for (const startPeriod of ["2024-13","2024-Q5","2024-01&x=1"]) expect(() => buildImfDataUrl({databaseId:"CPI",seriesKey:"USA.CPI._T.IX.M",startPeriod})).toThrow("period");
    expect(() => buildImfDataUrl({databaseId:"https://example.com",seriesKey:"USA.IX.M"})).toThrow("dataset");
    expect(() => buildImfDataUrl({databaseId:"CPI",seriesKey:"USA..IX.M"})).toThrow("series_key");
    expect(() => buildImfDataUrl({databaseId:"CPI",seriesKey:"USA+.CPI._T.IX.M"})).toThrow("series_key");
    expect(() => buildImfDataUrl({databaseId:"CPI",seriesKey:"USA.CPI._T.IX.M",limit:121})).toThrow("limit");
  });
});

describe("SDMX response handling", () => {
  test("parses quoted commas and multiline CSV without mixing countries, and preserves units/status", () => {
    const output = formatImfCsv(csv,url);
    expect(output).toContain("COUNTRY=USA"); expect(output).toContain("COUNTRY=GBR");
    for (const metadata of ["SCALE=0", "UNIT=IX", "REFERENCE_PERIOD=2010A"]) expect(output).toContain(metadata);
    expect(output).toContain("2024-M03: 141.9 [STATUS=E]");
    expect(output).not.toContain("2024-M02:");
    expect(output).toContain(`URL: ${url}`);
  });
  test("limits each series independently to its latest observations", () => {
    const output = formatImfCsv(csv,url,1);
    expect(output).not.toContain("2024-M01: 141.4");
    expect(output).toContain("2024-M03: 141.9");
    expect(output).toContain("2024-M01: 135.1");
  });
  test("reports missing observations but rejects HTML and malformed schemas", () => {
    expect(formatImfCsv(header,url)).toContain("No IMF observations");
    expect(formatImfCsv(header+'IMF.STA:CPI(5.0.0),USA,CPI,_T,IX,M,2024-M01,,0,IX,2010A,,CPI\n',url)).toContain("No numeric");
    expect(() => formatImfCsv('<html>error</html>',url)).toThrow("observation columns");
    expect(() => formatImfCsv('error,message\n500,Failure\n',url)).toThrow("observation columns");
  });
  test("rejects contradictory observations and units within a series", () => {
    const row = 'IMF.STA:CPI(5.0.0),USA,CPI,_T,IX,M,2024-M03,142.0,0,IX,2010A,E,CPI\n';
    expect(() => formatImfCsv(csv+row,url)).toThrow("conflicting values");
    expect(() => formatImfCsv(csv+row.replace(',0,IX,',',6,IX,'),url)).toThrow("differing units");
  });
  test("discovers datasets with English labels and query filtering", () => {
    expect(formatImfDatasets(xml,"consumer")).toContain("IMF.STA:CPI (version 5.0.0): Consumer prices");
    expect(formatImfDatasets(xml,"inflation")).toContain("IMF.STA:CPI");
    expect(formatImfDatasets(xml,"exchange")).toContain("No matching");
  });
  test("resolves the referenced DSD and inherited codelists in actual key order", () => {
    const output = formatImfStructure(xml,"CPI");
    expect(output).toContain("dimension order: COUNTRY.FREQUENCY");
    expect(output).toContain("USA=United States"); expect(output).toContain("M=Monthly");
    const filtered = formatImfStructure(xml,"CPI","COUNTRY","kingdom");
    expect(filtered).toContain("GBR=United Kingdom"); expect(filtered).not.toContain("USA=United States");
    expect(() => formatImfStructure(xml,"CPI","UNKNOWN")).toThrow("Unknown dimension");
  });
  test("rejects unexpected metadata and XML entity declarations", () => {
    expect(() => formatImfDatasets('<html/>')).toThrow("Unexpected IMF");
    expect(() => formatImfDatasets('<!DOCTYPE x [<!ENTITY y "z">]><x/>')).toThrow("document type");
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("public SDMX request negotiates CSV and transient failures are not cached", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    calls++;
    expect(String(input)).toStartWith("https://api.imf.org/external/sdmx/2.1/");
    expect(init.headers.Accept).toBe("application/vnd.sdmx.data+csv;version=2.0.0");
    return calls === 1 ? new Response('not found',{status:404}) : new Response(csv,{headers:{'Content-Type':'application/vnd.sdmx.data+csv;version=2.0.0'}});
  }) as typeof fetch;
  const client = new EconStatsCoreClient({FRED_KEY:undefined,BLS_KEY:undefined,BEA_KEY:undefined});
  const params = {databaseId:"CPI",seriesKey:"USA.CPI._T.IX.M"};
  expect(await client.imfGetData(params)).toStartWith("IMF error:");
  expect(await client.imfGetData(params)).toContain("2024-M03: 141.9");
  expect(await client.imfGetData(params)).toContain("2024-M03: 141.9");
  expect(calls).toBe(2);
});
