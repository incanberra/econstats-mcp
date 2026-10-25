import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {DataResult} from '../src/core/result';

const args={dataset_id:'OECD.GOV.GIP,DSD_GOV@DF_GOV_PF_YU',version:'1.0',
  series_key:'A.FRA+AUS+USA.GE.PT_B1GQ.S13.YU.PF',start_period:'2007',end_period:'2024',limit:100};
const ensure=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
/** Exercises the real production entrypoint with the captured OECD provider preload. */
export async function checkOecdHosted(base:string,token:string){
  const origin=new URL(base);
  if(!['localhost','127.0.0.1'].includes(origin.hostname)||origin.username||origin.password)throw new Error('OECD fixture checks require a loopback service.');
  let ready=false;
  for(let i=0;i<100;i++){
    try{if((await fetch(new URL('/health',origin),{signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{}
    await Bun.sleep(100);
  }
  ensure(ready,'OECD fixture service did not become ready');
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const clients=Array.from({length:3},(_,i)=>new Client({name:`oecd-resource-check-${i}`,version:'1'}));
  let polling=true,healthChecks=0,maxHealthMs=0;
  const health=async()=>{
    const started=performance.now(),r=await fetch(new URL('/health',origin),{signal:AbortSignal.timeout(4000)});
    ensure(r.status===200&&await r.text()==='ok','Health failed during OECD processing');
    maxHealthMs=Math.max(maxHealthMs,performance.now()-started);healthChecks++;
  };
  const poll=(async()=>{while(polling){await health();await Bun.sleep(100);}})();
  // Attach a handler immediately; failures are checked again after the requests.
  void poll.catch(()=>{});
  const call=async(client:Client,parameters= args)=>{
    const r=await client.callTool({name:'oecd_get_data',arguments:parameters},undefined,{timeout:60000});
    ensure(!r.isError,'OECD retrieval returned an error');return r.structuredContent as unknown as DataResult;
  };
  try{
    await Promise.all(clients.map(c=>c.connect(new StreamableHTTPClientTransport(new URL('/mcp',origin),{requestInit:{headers}}))));
    const cold=performance.now();
    const two={...args,series_key:'A.FRA+AUS.GE.PT_B1GQ.S13.YU.PF'};
    const [structure,first,parallel]=await Promise.all([
      clients[0].callTool({name:'oecd_get_structure',arguments:{dataset_id:args.dataset_id,version:'1.0',dimension_id:'REF_AREA',query:'United States'}}),
      call(clients[1],two),call(clients[2],two),
    ]);
    ensure(!structure.isError&&first.coverage.returnedObservations===36&&parallel.coverage.returnedObservations===36,'Cold/coalesced discovery or retrieval failed');
    const coldMs=Math.round(performance.now()-cold);
    const added=await call(clients[1]);
    ensure(added.coverage.returnedSeries===3&&added.coverage.returnedObservations===54&&!added.coverage.truncated,'Three-country coverage changed');
    const expected:Record<string,number>={AUS:39.636,FRA:57.286,USA:39.566};
    for(const s of added.series)ensure(s.unit==='PT_B1GQ'&&s.unitMultiplier===0&&s.observations.at(-1)?.value===expected[s.dimensions.REF_AREA],'Units, scaling or values changed');
    const warm=performance.now();await call(clients[2]);const warmMs=Math.round(performance.now()-warm);

    const controllers=[new AbortController(),new AbortController()];let secondSettled=false;
    const stalled=controllers.map((c,i)=>fetch(new URL('/mcp',origin),{method:'POST',headers,signal:c.signal,
      body:JSON.stringify({jsonrpc:'2.0',id:i+100,method:'tools/call',params:{name:'oecd_get_data',arguments:{...args,end_period:'2022'}}})
    }).then(async r=>{await r.text();if(i===1)secondSettled=true;return 'completed';},()=>{if(i===1)secondSettled=true;return 'aborted';}));
    await Bun.sleep(750);await health();controllers[0].abort();ensure(await stalled[0]==='aborted','Client cancellation failed');
    await Bun.sleep(100);ensure(!secondSettled,'One cancelled client cancelled another subscriber');
    controllers[1].abort();ensure(await stalled[1]==='aborted','Last client cancellation failed');
    await Bun.sleep(100);
    const recovered=await call(clients[0],{...args,limit:99});
    ensure(recovered.coverage.returnedObservations===54,'Service failed to recover after cancellation');
    await health();
    return {coldMs,warmMs,healthChecks,maxHealthMs:Math.round(maxHealthMs),countries:3,observations:54,cancellationRecovery:true};
  }finally{polling=false;await Promise.all(clients.map(c=>c.close()));await poll;}
}
if(import.meta.main){
  const base=process.env.ECONSTATS_CHECK_URL,token=process.env.ECONSTATS_CHECK_TOKEN;
  if(!base||!token)throw new Error('Set ECONSTATS_CHECK_URL and ECONSTATS_CHECK_TOKEN for the fixture service.');
  console.log(JSON.stringify(await checkOecdHosted(base,token)));
}
