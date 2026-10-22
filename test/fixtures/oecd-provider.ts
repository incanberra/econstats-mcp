// Test-only preload. Never copied into the production image or enabled by its entrypoint.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve(process.cwd(),'package.json'));
const {parse}=require('csv-parse/sync');
const xml=gunzipSync(readFileSync(new URL('./oecd-government/structure.xml.gz',import.meta.url))).toString();
const raw=readFileSync(new URL('./oecd-government/observations.csv',import.meta.url),'utf8');
const rows=parse(raw,{columns:true,bom:true}) as Record<string,string>[];
const columns=Object.keys(rows[0]),quote=(v:string)=>'"'+String(v??'').replaceAll('"','""')+'"';
const fetchOriginal=globalThis.fetch;let metadata=0,data=0;
globalThis.fetch=(async(input:any,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(url.hostname!=='sdmx.oecd.org')return fetchOriginal(input,init);
  if(url.pathname.includes('/dataflow/')){
    console.error(`[oecd_fixture] metadata=${++metadata}`);return new Response(xml);
  }
  console.error(`[oecd_fixture] data=${++data}`);
  if(url.searchParams.get('endPeriod')==='2022'){
    return new Response(new ReadableStream<Uint8Array>({
      start(controller){
        controller.enqueue(new TextEncoder().encode(columns.join(',')+'\n'));
        const abort=()=>{console.error('[oecd_fixture] body_cancelled');try{controller.error(new DOMException('Cancelled','AbortError'));}catch{}};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      },
    }));
  }
  const countries=url.pathname.split('/').at(-1)!.split('.')[1].split('+');
  const selected=rows.filter(r=>countries.includes(r.REF_AREA)&&r.TIME_PERIOD>=(url.searchParams.get('startPeriod')??'')&&r.TIME_PERIOD<=(url.searchParams.get('endPeriod')??'9999'));
  return new Response([columns.map(quote).join(','),...selected.map(r=>columns.map(c=>quote(r[c])).join(','))].join('\n'));
}) as typeof fetch;
