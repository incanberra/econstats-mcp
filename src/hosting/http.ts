import {EventEmitter} from "node:events";
import { randomUUID } from "node:crypto";
import {version} from '../../package.json';
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {WebStandardStreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthFailure, authConfig, challenge, createVerifier, resourceMetadata, type AuthConfig } from "./auth";
import {abortable,cancellation,withRequestContext,checkCancelled,phase} from '../core/request-context';

export type HttpConfig = { host: string; auth: AuthConfig; origins: Set<string>; maxConcurrent: number;requestTimeoutMs?:number };
const MAX_BODY = 1024 * 1024;
// Never log arbitrary params, tokens, exception messages or caller-supplied names.
const DIAGNOSTIC_TOOLS = new Set(["connection_health", "oecd_list_datasets", "oecd_get_structure", "oecd_get_data"]);

export function configuredPort(env: NodeJS.ProcessEnv): number {
  const raw = env.MCP_PORT || env.PORT || "0";
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new Error("MCP_PORT/PORT must be an integer from 0 to 65535.");
  if (Number(raw) === 0 && env.NODE_ENV === "production") throw new Error("Production requires an HTTP port greater than zero.");
  return Number(raw);
}

export function httpConfig(env: NodeJS.ProcessEnv): HttpConfig {
  const host = env.MCP_HOST || "127.0.0.1";
  const auth = authConfig(env, host);
  const origins = new Set<string>();
  for (const value of (env.MCP_ALLOWED_ORIGINS || "").split(",").filter(Boolean)) {
    const origin = value.trim();
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins."); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins.");
    origins.add(origin);
  }
  if (auth.mode === "oauth") origins.add(new URL(auth.publicUrl).origin);
  const maxConcurrent = Number(env.MCP_MAX_CONCURRENT || "4");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) throw new Error("MCP_MAX_CONCURRENT must be an integer from 1 to 128.");
  const requestTimeoutMs=Number(env.MCP_REQUEST_TIMEOUT_MS||'55000');
  if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1000||requestTimeoutMs>90000)throw new Error('MCP_REQUEST_TIMEOUT_MS must be an integer from 1000 to 90000.');
  return { host, auth, origins, maxConcurrent,requestTimeoutMs };
}

// Bun's native Request.signal reliably reports disconnects; the Node HTTP adapter
// does not do so for an abandoned response in the pinned runtime.
export class HostedServer extends EventEmitter {
  private server?:Bun.Server<undefined>;
  private closing=false;
  constructor(private handler:(request:Request,server:Bun.Server<undefined>)=>Promise<Response>,private drain:()=>void){super();}
  listen(port:number,host:string,callback:()=>void){
    try{
      this.server=Bun.serve({port,hostname:host,idleTimeout:10,maxRequestBodySize:MAX_BODY*2,
        fetch:(request,server)=>this.handler(request,server)});
      queueMicrotask(callback);
    }catch(error){queueMicrotask(()=>this.emit('error',error));}
    return this;
  }
  address(){return this.server?{address:this.server.hostname,port:this.server.port,family:'IPv4'}:null;}
  econstatsDrain(){this.drain();}
  close(callback?:(error?:Error)=>void){
    this.drain();this.server?.stop(false);
    if(this.closing){callback?.();return this;}this.closing=true;
    const wait=()=>{
      if(!this.server?.pendingRequests){this.emit('close');callback?.();}
      else setTimeout(wait,10).unref();
    };wait();return this;
  }
  closeAllConnections(){this.server?.stop(true);}
  closeIdleConnections(){/* stop(false) already closes idle connections. */}
}

async function body(request:Request):Promise<unknown>{
  if(Number(request.headers.get('content-length'))>MAX_BODY)throw 413;
  const reader=request.body?.getReader();if(!reader)throw 400;
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const r=await abortable(reader.read());if(r.done)break;size+=r.value.byteLength;
      if(size>MAX_BODY)throw 413;chunks.push(r.value);}
    try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw 400;}
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}

export function createHttpServer(factory:()=>McpServer,config:HttpConfig,verify=createVerifier(config.auth)):HostedServer{
  let active=0,draining=false;
  return new HostedServer(async(request,bunServer)=>{
    const requestId=randomUUID(),pathname=new URL(request.url).pathname,started=performance.now();
    const headers=new Headers({'X-Request-ID':requestId,'X-EconStats-Version':version,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    let status=500,reason='response_ready',operation='request',tool='other',maxLag=0;
    let admitted=false,mcp:McpServer|undefined,timer:ReturnType<typeof setTimeout>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
    const controller=new AbortController();
    const disconnected=()=>{reason='client_closed';controller.abort(cancellation('client_closed'));};
    const respond=(code:number,message:string,text=false)=>{
      status=code;headers.set('Content-Type',text?'text/plain':'application/json');
      return new Response(text?message:JSON.stringify({error:message}),{status:code,headers});
    };
    try{
      if(pathname==='/health'&&['GET','HEAD'].includes(request.method))return respond(draining?503:200,draining?'draining':'ok',true);
      const origin=request.headers.get('origin');
      if(origin&&!config.origins.has(origin)){reason='origin_not_allowed';return respond(403,'Origin not allowed');}
      if(origin){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');
        headers.set('Access-Control-Expose-Headers','WWW-Authenticate, MCP-Protocol-Version, X-Request-ID, X-EconStats-Version');}
      if(config.auth.mode==='oauth'&&['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(pathname)){
        if(request.method!=='GET'){headers.set('Allow','GET');return respond(405,'Method not allowed');}
        status=200;headers.set('Content-Type','application/json');return new Response(JSON.stringify(resourceMetadata(config.auth)),{headers});
      }
      if(pathname!=='/mcp')return respond(404,'Not found; use /mcp');
      if(request.method==='OPTIONS'){
        status=204;headers.set('Access-Control-Allow-Methods','POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers','Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
        headers.set('Access-Control-Max-Age','600');return new Response(null,{status,headers});
      }
      if(draining)return respond(503,'Server is restarting');
      if(active>=config.maxConcurrent){headers.set('Retry-After','1');return respond(429,'Server is busy; retry later');}
      active++;admitted=true;
      const timeout=config.requestTimeoutMs??55000;
      // A silent data query must reach our explicit deadline before Bun's idle timer.
      bunServer.timeout(request,Math.ceil(timeout/1000)+5);
      if(request.signal.aborted)disconnected();else request.signal.addEventListener('abort',disconnected,{once:true});
      timer=setTimeout(()=>{reason='request_deadline';controller.abort(cancellation('deadline'));},timeout);timer.unref();
      let lastTick=performance.now();
      heartbeat=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-lastTick-100);lastTick=now;},100);heartbeat.unref();
      return await withRequestContext({signal:controller.signal,requestId},async()=>{
        await phase('auth.verify',()=>verify(request.headers.get('authorization')??undefined));checkCancelled();
        if(request.method!=='POST'){headers.set('Allow','POST, OPTIONS');return respond(405,'Use POST for stateless MCP');}
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return respond(415,'Use application/json');
        const parsed=await phase('request.body',()=>body(request)),method=(parsed as {method?:unknown}|null)?.method;
        if(typeof method==='string'&&['initialize','notifications/initialized','tools/list','tools/call','ping'].includes(method))operation=method;
        const name=(parsed as {params?:{name?:unknown}}|null)?.params?.name;
        if(method==='tools/call'&&typeof name==='string'&&DIAGNOSTIC_TOOLS.has(name))tool=name;
        checkCancelled();mcp=factory();
        const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await mcp.connect(transport);
        const response=await phase('transport.handle',()=>transport.handleRequest(request,{parsedBody:parsed}));checkCancelled();
        status=response.status;
        const combined=new Headers(response.headers);for(const [key,value] of headers)combined.set(key,value);
        return new Response(response.body,{status:response.status,statusText:response.statusText,headers:combined});
      });
    }catch(error){
      if(controller.signal.aborted)return respond(reason==='request_deadline'?504:499,reason==='request_deadline'?'Request timed out':'Request cancelled');
      if(error instanceof AuthFailure){reason=error.reason;headers.set('WWW-Authenticate',challenge(config.auth,error.status));return respond(error.status,error.status===403?'Access denied':'Authentication required');}
      if(error===413||error===400)return respond(error,error===413?'Request too large':'Invalid JSON');
      reason='request_failed';return respond(500,'MCP request failed');
    }finally{
      clearTimeout(timer);clearInterval(heartbeat);request.signal.removeEventListener('abort',disconnected);
      if(admitted){active--;controller.abort(cancellation('client_closed'));void mcp?.close().catch(()=>{});}
      if(pathname==='/mcp'){
        const memory=process.memoryUsage();
        console.error(`[http] MCP ${operation} tool=${tool} status=${status} reason=${reason} request_id=${requestId} version=${version} duration_ms=${Math.round(performance.now()-started)} event_loop_lag_ms=${Math.round(maxLag)} rss_bytes=${memory.rss} heap_used_bytes=${memory.heapUsed}`);
      }
    }
  },()=>{draining=true;});
}

export function installShutdownHandlers(http:HostedServer){
  let stopping=false;
  const stop=()=>{
    if(stopping)return;stopping=true;http.econstatsDrain();console.error('[http] Draining requests before shutdown.');
    const deadline=setTimeout(()=>{http.closeAllConnections();process.exit(0);},10000);deadline.unref();
    http.close(()=>{clearTimeout(deadline);process.exit(0);});http.closeIdleConnections();
  };
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
