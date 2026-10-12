import iso from "i18n-iso-countries";

export const SOURCES = ["FRED","BLS","BEA","IMF","OECD","EUROSTAT","BIS","ECB","WORLD_BANK","EIA"] as const;
export const MEASURES = ["headline_cpi_yoy","core_cpi_yoy","hicp_yoy","cpih_yoy","real_gdp_level","real_gdp_growth_qoq","real_gdp_growth_annualized","unemployment_rate","nonfarm_jobs_change","private_credit_gdp","credit_gap","private_debt_service","crossborder_bank_claims","real_house_prices","nominal_house_prices","real_effective_exchange_rate","nominal_effective_exchange_rate","usd_exchange_rate","policy_rate","ecb_deposit_rate","population","gdp_per_capita_ppp","electricity_price","electricity_sales","wti_spot_price","gasoline_price","natural_gas_spot_price","residential_electricity_price","residential_electricity_sales","regular_gasoline_price","henry_hub_spot_price"] as const;
export type Source = typeof SOURCES[number];
export type Measure = typeof MEASURES[number];
export interface SelectionParams {
  measure: Measure;
  countries: string[];
  frequency?: "daily"|"weekly"|"monthly"|"quarterly"|"annual";
  purpose?: "latest"|"comparison"|"release";
  preferredSource?: Source;
  observations?: number;
  verify?: boolean;
  maxAgeDays?: number;
}
export interface Retrieval {tool:string;arguments:Record<string,any>}
export interface Candidate {
  source:Source;score:number;definition:string;reason:string;notes:string[];
  metadata?:Retrieval;requests:Retrieval[];countryTags?:string[];
  frequency:string;ready:boolean;
}
const european = new Set("AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE ISL NOR CHE".split(" "));
export function normaliseSelection(params: SelectionParams) {
  if (!MEASURES.includes(params.measure)) throw new Error("Unsupported measure. Select an exact measure from the tool schema; do not infer CPIH/HICP or growth conventions.");
  if (!Array.isArray(params.countries)||!params.countries.length||params.countries.length>5) throw new Error("Specify 1–5 countries using ISO2/ISO3 codes, or EA for the euro area.");
  const countries = [...new Set(params.countries.map(code=>{
    const c=code.toUpperCase();if(c==="EA")return c;
    const result=c.length===2 ? iso.alpha2ToAlpha3(c) : iso.isValid(c) ? c : undefined;
    if(!result)throw new Error(`Unknown country code ${code}. Use ISO codes, e.g. US/USA, GB/GBR.`);
    return result;
  }))];
  const n=params.observations??12;
  if(!Number.isInteger(n)||n<1||n>120)throw new Error("observations must be 1–120 per country.");
  if(params.maxAgeDays!==undefined&&(!Number.isInteger(params.maxAgeDays)||params.maxAgeDays<0))throw new Error("max_age_days must be a nonnegative integer.");
  if(params.preferredSource&&!SOURCES.includes(params.preferredSource))throw new Error("Unknown preferred source.");
  if(params.frequency&&!["daily","weekly","monthly","quarterly","annual"].includes(params.frequency))throw new Error("Unknown frequency.");
  const defaultFrequency=/gdp_growth|credit|debt_service|bank_claims|house_prices/.test(params.measure)?"quarterly":/population|capita/.test(params.measure)?"annual":params.measure==="ecb_deposit_rate"?"daily":"monthly";
  return {...params,countries,observations:n,frequency:params.frequency??defaultFrequency,purpose:params.purpose??(countries.length>1?"comparison":"latest"),verify:params.verify??true};
}
export function rankSources(input: SelectionParams, configured: Partial<Record<Source,boolean>> = {}) {
  const p=normaliseSelection(input),candidates:Candidate[]=[];
  const onlyUS=p.countries.length===1&&p.countries[0]==="USA";
  const allEurope=p.countries.every(c=>european.has(c));
  const code:Record<string,string>={daily:"D",weekly:"W",monthly:"M",quarterly:"Q",annual:"A"};
  const freq=code[p.frequency],alpha2=(c:string)=>iso.alpha3ToAlpha2(c)!;
  const limit=p.countries.length>1?Math.min(120,p.observations+12):p.observations;
  const add=(source:Source,score:number,definition:string,reason:string,requests:Retrieval[],metadata?:Retrieval,notes:string[]=[],countryTags?:string[])=>{
    const ready=!["FRED","BEA","EIA"].includes(source)||!!configured[source];
    candidates.push({source,score:score+(p.preferredSource===source?1000:0),definition,reason,requests,metadata,notes:[...notes,...(!ready?[`${source} API key is not configured.`]:[])],frequency:p.frequency,ready,countryTags});
  };
  const fred=(id:string,units="lin",score=90,definition:string)=>add("FRED",score,definition,"Convenient US series redistributed from its producer.",[{tool:"fred_get_series",arguments:{series_id:id,units,limit:p.observations}}],undefined,["Cite the underlying producer and transformation; FRED is a redistribution service."]);
  const bls=(id:string,definition:string)=>add("BLS",p.purpose==="release"?120:105,definition,"Original producer of US labour/CPI statistics.",[{tool:"bls_get_series",arguments:{series_ids:[id],start_year:String(new Date().getUTCFullYear()-Math.ceil(p.observations/12)-1),end_year:String(new Date().getUTCFullYear())}}],undefined,["BLS API observations can lag its release pages; check the returned dates."]);
  const bis=(id:string,key:(c:string)=>string,definition:string,countryDimension?:string)=>add("BIS",110,definition,"BIS supplies comparable financial definitions and preserves compilation/break notes.",p.countries.filter(c=>c!=="EA").map(c=>({tool:"bis_get_data",arguments:{dataset_id:id,series_key:key(alpha2(c)),limit}})),{tool:"bis_get_structure",arguments:{dataset_id:id}},["National compilation and coverage can still differ; inspect notes."],p.countries.map(c=>`${countryDimension??(/WS_TC|WS_DSR/.test(id)?"BORROWERS_CTY":"REF_AREA")}=${alpha2(c)}`));
  const eurostat=(id:string,filters:Record<string,string[]>,definition:string)=>add("EUROSTAT",115,definition,"Eurostat provides the requested European statistical definition.",p.countries.map(c=>({tool:"eurostat_get_data",arguments:{dataset_id:id,filters:{...filters,geo:[alpha2(c)]},limit}})),{tool:"eurostat_get_structure",arguments:{dataset_id:id}},["Current revised observations; check dataset notes and discontinued classifications."],p.countries.map(c=>`geo=${alpha2(c)}`));
  const allowed=(...f:string[])=>f.includes(p.frequency);
  if(p.measure==="headline_cpi_yoy"&&allowed("monthly")){
    if(onlyUS){bls("CUUR0000SA0","All-items CPI-U, not seasonally adjusted; year-on-year percentage change.");fred("CPIAUCNS","pc1",90,"All-items CPI-U, not seasonally adjusted; year-on-year percentage change.");}
    if(!p.countries.includes("EA")){
      const definition="National all-items CPI, year-on-year percentage change; national methodologies differ.";
      add("OECD",p.purpose==="comparison"?110:95,definition,"Explicit national CPI methodology, rate, adjustment and transformation dimensions.",p.countries.map(c=>({tool:"oecd_get_data",arguments:{dataset_id:"OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL",series_key:`${c}.M.N.CPI.PA._T.N.GY`,limit}})),{tool:"oecd_get_structure",arguments:{dataset_id:"OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL"}},["National CPI is not HICP or CPIH; it is not perfectly harmonised across countries."],p.countries.map(c=>`REF_AREA=${c}`));
      add("IMF",100,definition,"Current IMF CPI dataset supports monthly national inflation comparisons.",p.countries.map(c=>({tool:"imf_get_data",arguments:{database_id:"CPI",series_key:`${c}.CPI._T.YOY_PCH_PA_PT.M`,limit}})),{tool:"imf_get_structure",arguments:{database_id:"CPI"}},["Check country-specific coverage and compilation; do not substitute for HICP/CPIH."],p.countries.map(c=>`COUNTRY=${c}`));
    }
  }
  if(p.measure==="core_cpi_yoy"&&onlyUS&&allowed("monthly")){bls("CUUR0000SA0L1E","US CPI-U excluding food and energy, NSA; year-on-year percentage change.");fred("CPILFENS","pc1",90,"US CPI-U excluding food and energy, NSA; year-on-year percentage change.");}
  if(p.measure==="hicp_yoy"&&allEurope&&allowed("monthly"))eurostat("prc_hicp_minr",{freq:["M"],unit:["RCH_A"],coicop18:["TOTAL"]},"All-items HICP, ECOICOP v2; annual percentage change.");
  if(p.measure==="real_gdp_growth_qoq"&&allEurope&&allowed("quarterly"))eurostat("namq_10_gdp",{freq:["Q"],unit:["CLV_PCH_PRE"],s_adj:["SCA"],na_item:["B1GQ"]},"Real GDP quarter-on-quarter growth, seasonally/calendar adjusted, not annualized.");
  if(["real_gdp_growth_annualized","real_gdp_level"].includes(p.measure)&&onlyUS&&allowed("quarterly")){
    const growth=p.measure==="real_gdp_growth_annualized";
    const definition=growth?"US real GDP quarter-on-quarter growth at a seasonally adjusted annual rate (BEA).":"US real GDP in chained dollars, seasonally adjusted annual rate (BEA); not comparable currency levels across countries.";
    const year=Array.from({length:Math.ceil(p.observations/4)+1},(_,i)=>String(new Date().getUTCFullYear()-i)).join(",");
    add("BEA",115,definition,"Original producer of US national accounts.",[{tool:"bea_get_data",arguments:{dataset:"NIPA",table_name:growth?"T10101":"T10106",frequency:"Q",year}}],undefined,["Use the gross domestic product line; annualized growth differs from unannualized quarter-on-quarter growth."]);
    fred(growth?"A191RL1Q225SBEA":"GDPC1","lin",100,definition);
  }
  if(p.measure==="unemployment_rate"&&onlyUS&&allowed("monthly")){bls("LNS14000000","US unemployment U-3, percent, seasonally adjusted.");fred("UNRATE","lin",90,"US unemployment U-3, percent, seasonally adjusted.");}
  if(p.measure==="unemployment_rate"&&allEurope&&allowed("monthly"))eurostat("une_rt_m",{freq:["M"],unit:["PC_ACT"],s_adj:["SA"],sex:["T"],age:["Y15-74"]},"Unemployment rate, ages 15–74, both sexes, seasonally adjusted, percent of active population.");
  if(p.measure==="nonfarm_jobs_change"&&onlyUS&&allowed("monthly")){bls("CES0000000001","US total nonfarm payrolls, monthly change in thousands, seasonally adjusted.");fred("PAYEMS","chg",90,"US total nonfarm payrolls, monthly change in thousands, seasonally adjusted.");}
  if(!p.countries.includes("EA")){
    if(p.measure==="private_credit_gdp"&&allowed("quarterly"))bis("WS_TC",c=>`Q.${c}.P.A.M.770.A`,"Private non-financial credit from all lenders, market value, percent of GDP, adjusted for breaks.");
    if(p.measure==="credit_gap"&&allowed("quarterly"))bis("WS_CREDIT_GAP",c=>`Q.${c}.P.A.C`,"Private non-financial credit-to-GDP gap: actual ratio minus HP-filter trend, percentage points.","BORROWERS_CTY");
    if(p.measure==="private_debt_service"&&allowed("quarterly"))bis("WS_DSR",c=>`Q.${c}.P`,"Private non-financial debt service as a percentage of income.");
    if(p.measure==="crossborder_bank_claims"&&allowed("quarterly"))bis("WS_LBS_D_PUB",c=>`Q.S.C.A.TO1.A.5J.A.${c}.A.5J.N`,"Cross-border claims of reporting banks, all instruments/currencies/counterparties, stocks in USD with reported scaling.","L_REP_CTY");
    if(["real_house_prices","nominal_house_prices"].includes(p.measure)&&allowed("quarterly"))bis("WS_SPP",c=>`Q.${c}.${p.measure==="real_house_prices"?"R":"N"}.628`,`${p.measure==="real_house_prices"?"Real":"Nominal"} residential property prices, index 2010=100; no growth conversion.`);
    if(["real_effective_exchange_rate","nominal_effective_exchange_rate"].includes(p.measure)&&allowed("monthly"))bis("WS_EER",c=>`M.${p.measure==="real_effective_exchange_rate"?"R":"N"}.B.${c}`,`${p.measure==="real_effective_exchange_rate"?"Real":"Nominal"} effective exchange rate, broad basket; index, not bilateral currency value.`);
    if(p.measure==="policy_rate"&&allowed("monthly","daily"))bis("WS_CBPOL",c=>`${freq}.${c}`,"Central-bank policy rate in percent per year, end of period; BIS compilation defines each country's instrument.");
  }
  if(p.measure==="ecb_deposit_rate"&&p.countries.length===1&&p.countries[0]==="EA"&&allowed("daily"))add("ECB",120,"ECB deposit-facility rate, percent per annum.","ECB is the original producer of its policy-rate series.",[{tool:"ecb_get_data",arguments:{flow_ref:"FM",key:"D.U2.EUR.4F.KR.DFR.LEV",start_period:String(new Date().getUTCFullYear()-1)}}],undefined,["This is the deposit facility, not the main refinancing or marginal lending rate."]);
  if(onlyUS){
    const eia=(route:string,field:string,facets:Record<string,string[]>,definition:string)=>add("EIA",120,definition,"EIA is the original energy-statistics producer; inspect route, frequency and reported units.",[{tool:"eia_get_data",arguments:{route,frequency:p.frequency,data_fields:[field],facets,length:p.observations}}],{tool:"eia_get_metadata",arguments:{route}},["Route coverage does not guarantee selected-series coverage; data may be revised."],Object.entries(facets).map(([k,v])=>`${k}=${v[0]}`).slice(0,1));
    if(["residential_electricity_price","residential_electricity_sales"].includes(p.measure)&&allowed("monthly","quarterly","annual"))eia("electricity/retail-sales",p.measure==="residential_electricity_price"?"price":"sales",{stateid:["US"],sectorid:["RES"]},p.measure==="residential_electricity_price"?"US residential average retail electricity price, cents per kilowatt-hour.":"US residential electricity sales; retain reported energy units.");
    if(p.measure==="wti_spot_price"&&allowed("daily","weekly","monthly","annual"))eia("petroleum/pri/spt","value",{series:["RWTC"]},"Cushing WTI spot price FOB, dollars per barrel; not futures.");
    if(p.measure==="regular_gasoline_price"&&allowed("weekly","monthly","annual"))eia("petroleum/pri/gnd","value",{series:["EMM_EPMR_PTE_NUS_DPG"]},"US regular gasoline, all formulations, retail price in dollars per gallon; not all grades.");
    if(p.measure==="henry_hub_spot_price"&&allowed("daily","weekly","monthly","annual"))eia("natural-gas/pri/fut","value",{series:["RNGWHHD"]},"Henry Hub natural-gas spot price, dollars per million Btu; route also contains futures, selected series is spot.");
  }
  if(["population","gdp_per_capita_ppp"].includes(p.measure)&&allowed("annual")&&!p.countries.includes("EA")){
    const indicator=p.measure==="population"?"SP.POP.TOTL":"NY.GDP.PCAP.PP.KD";
    add("WORLD_BANK",110,p.measure==="population"?"Total population, persons.":"GDP per capita, PPP in constant international dollars; inspect current reference year.","World Bank is suited to long-run annual development comparisons.",p.countries.map(c=>({tool:"worldbank_get_data",arguments:{country_codes:[c],indicator,start_year:new Date().getUTCFullYear()-p.observations-3,end_year:new Date().getUTCFullYear()}})),undefined,["Annual data can lag; PPP reference years can change between revisions."]);
  }
  return {request:p,candidates:candidates.sort((a,b)=>b.score-a.score)};
}
export function observedPeriods(text:string,n:number,frequency?:string):string[]{
  const dates=[...text.matchAll(/^(\d{4}(?:(?:-?Q[1-4])|(?:-M?\d{2}(?:-\d{2})?))?):\s*(-?\d+(?:\.\d+)?)/gm)].map(m=>m[1].replace(/^(\d{4})Q/,"$1-Q").replace("-M","-"));
  const normalised=dates.map(d=>frequency==="quarterly"&&!d.includes("Q")&&d.includes("-")?`${d.slice(0,4)}-Q${Math.ceil(Number(d.slice(5,7))/3)}`:frequency==="monthly"?d.slice(0,7):frequency==="annual"?d.slice(0,4):d);
  return [...new Set(normalised)].sort().slice(-n);
}
function ageDays(period:string,now:Date):number{
  const [y,part,day]=period.split("-");
  const month=!part?12:part.startsWith("Q")?Number(part.slice(1))*3:Number(part);
  const end=day?Date.UTC(Number(y),month-1,Number(day)):Date.UTC(Number(y),month,0);
  return Math.max(0,Math.floor((now.getTime()-end)/86400000));
}
export async function selectSource(params:SelectionParams,configured:Partial<Record<Source,boolean>>,probe:(r:Retrieval)=>Promise<string>,now=new Date()){
  const ranked=rankSources(params,configured),p=ranked.request;
  const preferred=p.preferredSource;
  const candidates=ranked.candidates.slice(0,3);
  const results=await Promise.all(candidates.map(async c=>{
    const result:any={...c,verification:{status:p.verify?"not_checked":"unverified",countries:[],commonPeriods:[]}};
    if(!c.ready){result.verification.status="missing_key";return result;}
    if(!p.verify)return result;
    try{
      if(c.metadata){const text=await probe(c.metadata);if(/^(?:IMF|OECD|Eurostat|BIS|EIA) error:/.test(text))throw new Error("Metadata lookup failed.");}
      const countries=await Promise.all(c.requests.map(async(r,i)=>{
        const text=await probe(r);
        if(/^(?:IMF|OECD|Eurostat|BIS|EIA) error:|API error:|not configured/i.test(text))throw new Error("Data lookup failed.");
        if(c.countryTags&&!text.includes(c.countryTags[i]))throw new Error("Requested country was not confirmed in the returned data.");
        const numericText=c.source==="BLS"&&/cpi_yoy|nonfarm_jobs_change/.test(p.measure)?text.split("\n").filter(line=>!/^\d{4}-\d{2}:/.test(line)||(/cpi_yoy/.test(p.measure)?/% YoY/.test(line):/ change \(level:/.test(line))).join("\n"):text;
        const periods=observedPeriods(numericText,p.countries.length>1?Math.min(120,p.observations+12):p.observations,p.frequency);
        const urls=[...new Set(text.match(/https:\/\/[^\s<>]+/g)??[])].filter(u=>!/[?&]api_key=/i.test(u));
        return {country:p.countries[i],periods,latest:periods.at(-1)??null,observations:periods.length,urls};
      }));
      const common=(countries[0]?.periods.filter((d:string)=>countries.every(c=>c.periods.includes(d)))??[]).slice(-p.observations);
      const latest=common.at(-1);
      const age=latest?ageDays(latest,now):null;
      const status=countries.some(c=>!c.latest)?"no_data":common.length<p.observations?"partial_coverage":p.maxAgeDays!==undefined&&age!==null&&age>p.maxAgeDays?"stale":"verified";
      result.verification={status,countries,commonPeriods:common,latestCommonPeriod:latest??null,ageDays:age,checkedAt:now.toISOString()};
    }catch{result.verification={status:"lookup_failed",message:"Could not confirm this candidate's metadata, definition or observations. No source data were inferred."};}
    return result;
  }));
  const eligible=results.filter(r=>r.verification.status==="verified").sort((a,b)=>String(b.verification.latestCommonPeriod).localeCompare(String(a.verification.latestCommonPeriod))||b.score-a.score);
  let selected=preferred?eligible.find(r=>r.source===preferred):eligible[0];
  if(!p.verify)selected=preferred?results.find(r=>r.source===preferred&&r.ready):results.find(r=>r.ready);
  return {status:selected?(p.verify?"verified_recommendation":"unverified_recommendation"):preferred?"requested_source_not_verified":"no_verified_match",request:p,selected:selected??null,candidates:results,
    explanation:selected?`Selected ${selected.source}: ${selected.reason}${preferred?" User's source preference honored.":""}`:preferred?`No verified ${preferred} match for this exact request. Alternatives are shown; your preference was not overridden.`:"No candidate meets the requested definition, frequency, country and observation coverage. Refine the measure or use dataset discovery; do not substitute a different definition.",
    alignmentInstruction:"Retrieve the suggested calls and restrict comparisons to verification.commonPeriods. Extra observations are requested to accommodate different publication lags.",
    discovery:ranked.candidates.length?[]:[{tool:/capita|population/.test(p.measure)?"worldbank_search":/gdp|cpih|unemployment/.test(p.measure)?"oecd_list_datasets":/energy|electricity|gas|oil|spot/.test(p.measure)?"eia_list_routes":"bis_list_datasets",arguments:{query:p.measure.replaceAll("_"," ")}}],
    limitations:["Curated exact-measure registry, not an exhaustive search of every provider's catalogue.","Coverage checks sample returned observations and common periods; they do not establish historical vintages or guarantee release-page freshness.","Verification timestamps describe the check; cached source responses can be reused.","Metadata and observations can be revised. Cite the eventual retrieved data, not this recommendation as economic evidence."]};
}
