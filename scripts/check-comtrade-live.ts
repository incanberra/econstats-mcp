import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolve} from 'node:path';
if(process.env.ECONSTATS_COMTRADE_LIVE!=='true')throw new Error('Opt in with ECONSTATS_COMTRADE_LIVE=true. This check makes four public upstream requests.');
const transport=new StdioClientTransport({command:process.execPath,args:['run',resolve(import.meta.dir,'../src/index.ts')],env:{MCP_PORT:'0',PORT:'0',PREFETCH_HOT_SERIES:'false',ECONSTATS_DISK_CACHE:'false'},stderr:'pipe'});
const client=new Client({name:'comtrade-public-live-check',version:'1.0'});
try{
 await client.connect(transport);
 const checks=[
  {name:'comtrade_list_reference',arguments:{reference:'reporters',query:'Australia',limit:5}},
  {name:'comtrade_search_products',arguments:{classification:'H6',query:'8703',limit:5}},
  {name:'comtrade_get_availability',arguments:{reporter_code:36,periods:['2023'],frequency:'A',classification:'HS',access_mode:'preview',fresh:true}},
  {name:'comtrade_get_data',arguments:{reporter_code:36,partner_code:0,periods:['2023'],frequency:'A',classification:'HS',product_codes:['8703'],flow_code:'X',fields:['primaryValue'],access_mode:'preview',max_records:5,fresh:true}},
 ];
 for(const [i,check] of checks.entries()){
  if(i)await new Promise(resolve=>setTimeout(resolve,1500));
  const result=await client.callTool(check),data=result.structuredContent as any;
  if(result.isError||!data)throw new Error(`Public live check failed: ${check.name}. Inspect provider availability; no raw upstream response is logged.`);
  if(check.name==='comtrade_list_reference'&&!data.results?.some((r:any)=>r.id===36||r.reporterCode===36))throw new Error('Australia reporter discovery failed.');
  if(check.name==='comtrade_search_products'&&!data.results?.some((r:any)=>r.id==='8703'))throw new Error('HS product discovery failed.');
  if(check.name==='comtrade_get_availability'&&!data.partitions?.[0]?.records?.length)throw new Error('Expected Australia 2023 availability.');
  if(check.name==='comtrade_get_data'&&(data.source!=='COMTRADE'||data.schemaVersion!=='1.0'||!data.series?.length||!data.coverage.truncated||data.series[0].observations[0].value===null||!data.series[0].revision))throw new Error('Public structured trade data contract failed.');
  console.log(JSON.stringify({tool:check.name,status:'passed',retrievedAt:data.retrievedAt,returnedSeries:data.coverage?.returnedSeries,returnedObservations:data.coverage?.returnedObservations,previewTruncated:data.coverage?.truncated}));
 }
}finally{await client.close();}
