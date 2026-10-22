import {AsyncLocalStorage} from 'node:async_hooks';
import {version} from '../../package.json';

export type RequestContext={signal:AbortSignal;requestId?:string};
const contexts=new AsyncLocalStorage<RequestContext>();
export function requestSignal(){return contexts.getStore()?.signal;}
export function withRequestContext<T>(context:RequestContext,work:()=>T):T{return contexts.run(context,work);}
export function withWorkSignal<T>(signal:AbortSignal,work:()=>T):T{return contexts.run({...contexts.getStore(),signal},work);}
export function checkCancelled(signal=requestSignal()){signal?.throwIfAborted();}
export function cancellation(reason:'deadline'|'client_closed'|'no_waiters'){
  return new DOMException(reason==='deadline'?'Request deadline reached.':'Request cancelled.',reason==='deadline'?'TimeoutError':'AbortError');
}
/** Race even implementations which ignore AbortSignal; always detach listeners. */
export function abortable<T>(work:Promise<T>,signal=requestSignal()):Promise<T>{
  if(!signal)return work;
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
  });
}
export type Phase='auth.verify'|'request.body'|'transport.handle'|'cache.read'|'cache.write'|'oecd.queue'|
  'oecd.metadata.download'|'oecd.metadata.parse'|'oecd.data.download'|'oecd.data.parse'|'result.revisions'|'result.render';
export async function phase<T>(name:Phase,work:()=>T|Promise<T>):Promise<T>{
  const context=contexts.getStore(),started=performance.now();
  const log=(state:string)=>{
    if(!context?.requestId)return;
    const m=process.memoryUsage();
    console.error(JSON.stringify({event:'request_phase',request_id:context.requestId,version,phase:name,state,
      elapsed_ms:Math.round(performance.now()-started),rss_bytes:m.rss,heap_used_bytes:m.heapUsed}));
  };
  log('start');
  try{checkCancelled();const value=await abortable(Promise.resolve().then(work));checkCancelled();log('complete');return value;}
  catch(error){log(context?.signal.aborted?'cancelled':'failed');throw error;}
}
