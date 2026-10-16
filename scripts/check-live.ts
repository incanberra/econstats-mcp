import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const reportDir=resolve(process.argv[2]||'../econstats-install');await mkdir(reportDir,{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')) as Record<string,string>;
env.MCP_PORT='0';env.PORT='0';env.PREFETCH_HOT_SERIES='false';env.ECONSTATS_CACHE_DIR=resolve(reportDir,'v3-runtime-cache');
const transport=new StdioClientTransport({command:process.execPath,args:['run',resolve('src/index.ts')],env,stderr:'pipe'});
const c=new Client({name:'v3-validation',version:'1.0.0'});const results:any[]=[];await c.connect(transport);
const inventory=await c.listTools();console.log(JSON.stringify({version:c.getServerVersion(),tools:inventory.tools.length,instructionsDelivered:!!c.getInstructions()?.includes('SOURCE ROUTING')}));
const cases:[string,Record<string,unknown>][]=[
['abs_list_datasets',{query:'national accounts',limit:5}],['abs_get_structure',{dataset_id:'LF',dimension_id:'MEASURE',query:'unemployment rate'}],
['abs_get_data',{dataset_id:'ANA_AGG',series_key:'M1.GPM.20.AUS.Q',limit:4}],
['abs_get_data',{dataset_id:'ANA_AGG',series_key:'M2.GPM.20.AUS.Q',limit:4}],
['abs_get_data',{dataset_id:'CPI',series_key:'3.10001.10.50.M',limit:4}],
['abs_get_data',{dataset_id:'LF',series_key:'M13.3.1599.20.AUS.M',limit:4}],
['abs_get_data',{dataset_id:'ITGS',series_key:'M1.1000+2000.20.AUS.M',limit:4}],
['fred_get_series',{series_id:'UNRATE',units:'lin',limit:4}],
['bls_get_series',{series_ids:['LNS14000000'],start_year:'2026',end_year:'2026'}],
['bea_get_data',{dataset:'NIPA',table_name:'T10101',frequency:'Q',year:'2026'}],
['imf_get_data',{database_id:'CPI',series_key:'USA.CPI._T.YOY_PCH_PA_PT.M',limit:4}],
['oecd_get_data',{dataset_id:'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL',series_key:'USA.M.N.CPI.PA._T.N.GY',limit:4}],
['eurostat_get_data',{dataset_id:'prc_hicp_minr',filters:{freq:['M'],unit:['RCH_A'],coicop18:['TOTAL'],geo:['DE']},limit:4}],
['bis_get_data',{dataset_id:'WS_CBPOL',series_key:'M.US',limit:4}],
['eia_get_data',{route:'electricity/retail-sales',frequency:'monthly',data_fields:['price'],facets:{stateid:['US'],sectorid:['RES']},length:4}],
['worldbank_get_data',{country_codes:['AU'],indicator:'SP.POP.TOTL',start_year:2023,end_year:2025}],
['ecb_get_data',{flow_ref:'FM',key:'D.U2.EUR.4F.KR.DFR.LEV',start_period:'2026-09',end_period:'2026-10'}]
];
for(const [tool,args]of cases.filter(([tool])=>!process.env.ECONSTATS_LIVE_TOOLS||process.env.ECONSTATS_LIVE_TOOLS.split(',').includes(tool))){try{const r:any=await c.callTool({name:tool,arguments:args}),s=r.structuredContent;const isData=tool.endsWith('_get_data')||tool==='fred_get_series'||tool==='bls_get_series';const passed=!r.isError&&!!s&&(!isData||s.schemaVersion==='1.0'&&s.series.length>0&&s.series.every((x:any)=>x.observations.length&&x.urls.length&&x.id));results.push({tool,args,passed,result:s??r.content});console.log(JSON.stringify({tool,passed,series:s?.series?.length,observations:s?.coverage?.returnedObservations}));}catch{results.push({tool,args,passed:false,error:'SDK call failed'});console.log(JSON.stringify({tool,passed:false}));}}
const a:any=results.find(r=>r.tool==='abs_get_data'&&r.args.dataset_id==='LF')?.result;if(a){const cached:any=await c.callTool({name:'abs_get_data',arguments:{dataset_id:'LF',series_key:'M13.3.1599.20.AUS.M',limit:4}});results.push({tool:'abs-cache-replay',passed:cached.structuredContent?.retrievedAt===a.retrievedAt&&cached.structuredContent?.series[0].revision.status==='cached_or_older_snapshot'});const refreshed:any=await c.callTool({name:'abs_get_data',arguments:{dataset_id:'LF',series_key:'M13.3.1599.20.AUS.M',limit:4,fresh:true}});const afterFresh:any=await c.callTool({name:'abs_get_data',arguments:{dataset_id:'LF',series_key:'M13.3.1599.20.AUS.M',limit:4}});results.push({tool:'abs-explicit-refresh',passed:!refreshed.isError&&Date.parse(refreshed.structuredContent.retrievedAt)>Date.parse(a.retrievedAt)&&afterFresh.structuredContent.retrievedAt===refreshed.structuredContent.retrievedAt});const h:any=await c.callTool({name:'revision_history',arguments:{series_id:a.series[0].id}});results.push({tool:'revision_history',passed:h.structuredContent?.status==='found'&&h.structuredContent?.history.length>=1});}
for(const measure of ['headline_cpi_yoy','unemployment_rate','real_gdp_growth_qoq']){const r:any=await c.callTool({name:'select_source',arguments:{measure,countries:['AU'],observations:4,preferred_source:'ABS'}});let s;try{s=JSON.parse(r.content[0].text);}catch{}results.push({tool:'select_source',measure,passed:s?.status==='verified_recommendation'&&s?.selected?.source==='ABS',result:s});console.log(JSON.stringify({tool:'select_source',measure,passed:results.at(-1).passed}));}
await writeFile(resolve(reportDir,'v3-live-results.json'),JSON.stringify({testedAt:new Date().toISOString(),inventory:{server:c.getServerVersion(),tools:inventory.tools.map(t=>t.name)},results},null,2));await c.close();console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length}));if(results.some(x=>!x.passed))process.exitCode=1;
