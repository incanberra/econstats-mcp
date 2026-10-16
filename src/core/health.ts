import {PROVIDERS,accessGovernor,providerFetch,AccessError,type Provider} from "./access";
import {checkedJson} from "./legacy";
import {requestEurostat} from "./eurostat";
type Keys={FRED_KEY?:string;BLS_KEY?:string;BEA_KEY?:string;EIA_KEY?:string};
export async function connectionHealth(keys:Keys,sources:Provider[]= [...PROVIDERS],probe=false){
  if(!sources.length||sources.some(s=>!PROVIDERS.includes(s))||(probe&&sources.length>3))throw new Error("Choose valid providers; a live health check supports at most 3 sources per call.");
  const keyFor:Partial<Record<Provider,string|undefined>>={FRED:keys.FRED_KEY,BEA:keys.BEA_KEY,EIA:keys.EIA_KEY};
  const g=accessGovernor(),results=[];
  for(const provider of [...new Set(sources)]){
    const requiresKey=["FRED","BEA","EIA"].includes(provider),keyConfigured=provider==="BLS"?!!keys.BLS_KEY:requiresKey?!!keyFor[provider]:null;
    if(requiresKey&&!keyConfigured){results.push({...await g.snapshot(provider),status:"missing_key",keyConfigured,probed:false});continue;}
    let message:string|undefined;
    if(probe){
      try{
        if(provider==="FRED"){
          const url=new URL("https://api.stlouisfed.org/fred/series?series_id=UNRATE&file_type=json");url.searchParams.set("api_key",keys.FRED_KEY!);
          const data=await checkedJson(url);if(!data.seriess?.[0]?.id)throw new AccessError(provider,"invalid_response","Missing FRED series metadata.");
        }else if(provider==="BEA"){
          const url=new URL("https://apps.bea.gov/api/data/?method=GetDatasetList&ResultFormat=JSON");url.searchParams.set("UserID",keys.BEA_KEY!);
          const data=await checkedJson(url);if(!Array.isArray(data.BEAAPI?.Results?.Dataset))throw new AccessError(provider,"invalid_response","Missing BEA dataset metadata.");
        }else if(provider==="BLS"){
          const data=await checkedJson("https://api.bls.gov/publicAPI/v2/timeseries/data/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({seriesid:["LNS14000000"],startyear:String(new Date().getUTCFullYear()),endyear:String(new Date().getUTCFullYear()),...(keys.BLS_KEY?{registrationkey:keys.BLS_KEY}:{})})});
          if(!Array.isArray(data.Results?.series))throw new AccessError(provider,"invalid_response","Missing BLS series response.");
        }else if(provider==="WORLD_BANK"){
          const data=await checkedJson("https://api.worldbank.org/v2/country/US?format=json");if(!Array.isArray(data?.[1])||!data[1].length)throw new AccessError(provider,"invalid_response","Missing World Bank country metadata.");
        }else if(provider==="EIA"){
          const url=new URL("https://api.eia.gov/v2/");url.searchParams.set("api_key",keys.EIA_KEY!);
          const data=await checkedJson(url);if(data.error||!Array.isArray(data.response?.routes))throw new AccessError(provider,"invalid_response","Missing EIA route metadata.");
        }else{
          const urls:Partial<Record<Provider,string>>={
            IMF:"https://api.imf.org/external/sdmx/2.1/dataflow/IMF.STA/CPI/latest?references=none",
            OECD:"https://sdmx.oecd.org/public/rest/dataflow/OECD.SDD.TPS/DSD_PRICES@DF_PRICES_ALL/latest?references=none",
            BIS:"https://stats.bis.org/api/v2/structure/dataflow/BIS/WS_CBPOL/+?references=none&format=sdmx-2.1",
            EUROSTAT:"https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT/PRC_HICP_MINR/1.0?references=none&compressed=true",
            ECB:"https://data-api.ecb.europa.eu/service/dataflow/ECB/FM/latest?references=none",
          };
          const text=provider==="EUROSTAT"?await requestEurostat(urls[provider]!):await(await providerFetch(urls[provider]!,{headers:{Accept:"application/vnd.sdmx.structure+xml;version=2.1"}})).text();
          if(text.length>20_000_000||!/<(?:[\w.-]+:)?Structure[\s>]/.test(text)||!text.includes("Dataflow"))throw new AccessError(provider,"invalid_response","Unexpected SDMX metadata response.");
        }
        await g.record(provider,"healthy");
      }catch(error){
        if(error instanceof AccessError){if(!["budget_exhausted","rate_limited"].includes(error.kind))await g.record(provider,error.kind);message=error.message;}
        else{await g.record(provider,"invalid_response");message="Provider returned an unexpected response.";}
      }
    }
    results.push({...await g.snapshot(provider),keyConfigured,probed:probe,...(message?{message}:{})});
  }
  return {checkedAt:new Date().toISOString(),mode:probe?"live_access_probe":"saved_access_status",providers:results,
    notes:["No credentials or authenticated request URLs are returned.","A successful access probe confirms this endpoint/credential, not the availability, definition or freshness of every dataset.","Without probe=true, status is the last observed access result, not a new connectivity test.","Local budgets count every upstream attempt including probes/retries, not cache hits; other applications/IP users and upstream daily limits are not included.","Defaults: OECD 60 requests/hour; other providers 300 requests/hour as local operational caps, not promises about upstream quotas. Configure ECONSTATS_BUDGET_<PROVIDER>_PER_HOUR; zero disables the local cap."]};
}
