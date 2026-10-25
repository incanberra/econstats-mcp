import {AccessError} from './access';
import {requestSignal} from './request-context';
import type {SdmxDefinition} from './abs';
import type {DataResult} from './result';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

export type ParseJob={kind:'definition';xml:string;datasetId:string;version?:string}|
  {kind:'data';csv:string;definition:SdmxDefinition;url:string;query:Record<string,unknown>;key:string;limit:number;retrievedAt:string};
type Value=SdmxDefinition|DataResult;
function spawnParser(){
  // No provider credentials, .env loading or network access are needed by a parser.
  return Bun.spawn([process.execPath,'--no-env-file','--smol',fileURLToPath(new URL('./oecd-parse-worker.ts',import.meta.url))],{
    stdin:'pipe',stdout:'pipe',stderr:'ignore',cwd:tmpdir(),
    env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,NODE_ENV:'production',ECONSTATS_DISK_CACHE:'false'},
  });
}
type Entry={job:ParseJob;signal:AbortSignal;bytes:number;resolve:(v:Value)=>void;reject:(e:unknown)=>void;abort:()=>void;child?:ReturnType<typeof spawnParser>;done:boolean};

/** A single OS-isolated parser, bounded queue and byte budget, killed on cancellation. */
export class OecdParser {
  private queue:Entry[]=[];
  private active?:Entry;
  private bytes=0;
  constructor(private maxJobs=16,private maxBytes=24*1024*1024){}
  stats(){return {active:!!this.active,queued:this.queue.length,inputBytes:this.bytes};}
  parse(job:ParseJob,parent=requestSignal()):Promise<Value>{
    const signal=AbortSignal.any([AbortSignal.timeout(30000),...(parent?[parent]:[])]);
    if(signal.aborted)return Promise.reject(signal.reason);
    // Count retained input strings conservatively; large jobs fail without risking the HTTP process.
    const bytes=(job.kind==='definition'?job.xml.length:job.csv.length+JSON.stringify(job.definition).length)*2;
    if(this.queue.length+(this.active?1:0)>=this.maxJobs||this.bytes+bytes>this.maxBytes)
      return Promise.reject(new AccessError('OECD','unavailable','Parsing capacity exceeded. Narrow the selection or retry after current requests finish.'));
    return new Promise((resolve,reject)=>{
      const entry:Entry={job,signal,bytes,resolve,reject,done:false,abort:()=>{}};
      entry.abort=()=>{
        if(entry.done)return;entry.done=true;reject(parent?.aborted?parent.reason:
          new AccessError('OECD','unavailable','Parsing exceeded its 30-second budget; retry a smaller selection.'));
        if(entry.child){try{entry.child.kill('SIGKILL');}catch{}}
        else{this.queue=this.queue.filter(x=>x!==entry);this.bytes-=bytes;signal.removeEventListener('abort',entry.abort);}
      };
      this.bytes+=bytes;this.queue.push(entry);signal.addEventListener('abort',entry.abort,{once:true});this.pump();
    });
  }
  private pump(){
    if(this.active)return;
    const entry=this.queue.shift();if(!entry)return;
    this.active=entry;
    void this.run(entry).finally(()=>{
      entry.signal.removeEventListener('abort',entry.abort);this.bytes-=entry.bytes;this.active=undefined;this.pump();
    });
  }
  private async run(entry:Entry){
    try{
      if(entry.signal.aborted)throw entry.signal.reason;
      let child:ReturnType<typeof spawnParser>;
      try{child=spawnParser();}catch{throw new AccessError('OECD','unavailable','Parser process could not start; check the Bun runtime and hosting permissions.');}
      entry.child=child;
      // Both operations may reject asynchronously when cancellation kills the child.
      const writing=(async()=>{await child.stdin.write(JSON.stringify(entry.job));await child.stdin.end();})();
      const written=writing.then(()=>true,()=>false);
      const reader=child.stdout.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{
        while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;
          if(size>8*1024*1024)throw new Error('Parser output exceeded its bound.');chunks.push(r.value);}
      }finally{reader.releaseLock();}
      const code=await child.exited;
      await written;
      if(entry.done)return;
      if(code!==0&&code!==1)throw new AccessError('OECD','unavailable','Parser process exited unexpectedly; retry the request.');
      const result=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
      if(!result.ok)throw new Error('Invalid provider response.');
      entry.done=true;entry.resolve(result.value);
    }catch(error){
      if(!entry.done){entry.done=true;entry.reject(error instanceof AccessError?error:new AccessError('OECD','invalid_response',
        entry.job.kind==='definition'?'Dataset metadata is invalid or incomplete; no definition was cached.':'Observations failed validation; no data were cached.'));}
    }finally{
      // Do not start another parser until the previous OS process has exited.
      if(entry.child){try{entry.child.kill('SIGKILL');}catch{}await entry.child.exited.catch(()=>{});}
    }
  }
}
const parser=new OecdParser();
export async function parseOecdJob<T extends Value>(job:ParseJob):Promise<T>{return await parser.parse(job) as T;}
export function oecdParserStats(){return parser.stats();}
