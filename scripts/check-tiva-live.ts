import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';

// Opt-in live requests, no provider keys required. Keep reports/caches outside the checkout.
const root=resolve(import.meta.dir,'..');
if(!process.argv[2])throw new Error('Usage: bun run scripts/check-tiva-live.ts <report-directory-outside-repository>');
const reportDir=resolve(process.argv[2]),location=relative(root,reportDir);
if(!location||(!isAbsolute(location)&&location!=='..'&&!location.startsWith('..\\')&&!location.startsWith('../')))throw new Error('Report directory must be outside the repository.');
await mkdir(reportDir,{recursive:true});
const transport=new StdioClientTransport({command:process.execPath,args:['run',resolve(root,'src/index.ts')],env:{MCP_PORT:'0',PORT:'0',PREFETCH_HOT_SERIES:'false',ECONSTATS_DISK_CACHE:'false'},stderr:'pipe'});
const client=new Client({name:'tiva-live-validation',version:'1.0'});
const checks:any[]=[];
function require(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
try{
 await client.connect(transport);
 const inventory=await client.listTools();
 require(inventory.tools.find(t=>t.name==='oecd_get_data')?.inputSchema.properties?.space,'Server does not expose OECD service selection.');
 const dataset='OECD.STI.PIE,DSD_TIVA_MAINSH@DF_MAINSH';
 const cases:[string,Record<string,unknown>][]=[
  ['oecd_list_datasets',{query:'TiVA',space:'sti-public',limit:10}],
  ['oecd_get_structure',{dataset_id:dataset,version:'1.1',dimension_id:'MEASURE',query:'EXGR_DVA'}],
  ['oecd_get_data',{dataset_id:dataset,version:'1.1',series_key:'EXGR_DVA.AUS._T.W.PT_EXGR.A',start_period:'2020',end_period:'2022',limit:3,fresh:true}],
  ['oecd_get_data',{dataset_id:'OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL',series_key:'USA.M.N.CPI.PA._T.N.GY',start_period:'2024-01',end_period:'2024-02',limit:2,fresh:true}]
 ];
 for(const [name,args] of cases){
  const response=await client.callTool({name,arguments:args});
  require(!response.isError,`${name} returned an MCP error: ${JSON.stringify(response.content)}`);
  const data=response.structuredContent as any;
  if(name==='oecd_get_data'){
   require(data?.schemaVersion==='1.0'&&data.source==='OECD'&&data.series?.length===1,'Missing/invalid structured OECD results.');
   const series=data.series[0],space=args.dataset_id===dataset?'sti-public':'public';
   require(series.observations.length>0&&series.observations.some((o:any)=>typeof o.value==='number'),'No numeric observations.');
   require(series.observations.every((o:any)=>o.period>=String(args.start_period)&&o.period<=String(args.end_period)),'Returned periods exceed the requested range.');
   require(series.urls.every((u:string)=>new URL(u).pathname.startsWith(`/${space}/rest/data/`)),'Incorrect source service in citations.');
   require(series.urls.every((u:string)=>!new URL(u).searchParams.has('lastNObservations')),'Blocked latest-observation parameter was sent.');
  }else{
   require(JSON.stringify(response.content).includes('/sti-public/rest/'),'Discovery/structure used the wrong service.');
  }
  checks.push({tool:name,arguments:args,response});
 }
 const missingBounds=await client.callTool({name:'oecd_get_data',arguments:{dataset_id:dataset,series_key:'EXGR_DVA.AUS._T.W.PT_EXGR.A'}});
 require(missingBounds.isError&&JSON.stringify(missingBounds.content).includes('requires both start_period and end_period'),'Missing date bounds did not return an actionable error.');
 await writeFile(resolve(reportDir,'tiva-live.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,missingBounds},null,2));
 console.log(JSON.stringify({passed:checks.length+1,report:resolve(reportDir,'tiva-live.json'),observations:checks.filter(c=>c.response.structuredContent).map(c=>({dataset:c.arguments.dataset_id,coverage:c.response.structuredContent.coverage}))}));
}finally{await client.close();}
