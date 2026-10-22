import { Redis } from "@upstash/redis";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {atomicWrite,readStored,storageDirectory,storagePath} from "./storage";
import {abortable,cancellation,checkCancelled,requestSignal,withWorkSignal,phase} from './request-context';

export interface CacheBackend {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlSeconds: number): Promise<void>;
  getEntry?(key:string):Promise<{value:any;ttlSeconds:number}|null>;
}

type CacheEntry = {
  value: any;
  expiresAt: number;
  bytes:number;
};

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, CacheEntry>();
  private bytes=0;
  constructor(private maxEntries=256,private maxBytes=32*1024*1024,private clock=Date.now){
    if(!Number.isInteger(maxEntries)||maxEntries<1||!Number.isFinite(maxBytes)||maxBytes<1)throw new Error('Invalid memory cache limits.');
  }
  private remove(key:string){const old=this.store.get(key);if(old){this.bytes-=old.bytes;this.store.delete(key);}}
  private prune(){for(const [key,entry] of this.store)if(entry.expiresAt<=this.clock())this.remove(key);}
  stats(){this.prune();return {entries:this.store.size,bytes:this.bytes,maxBytes:this.maxBytes};}

  async get(key: string): Promise<any | null> {
    this.prune();
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);this.store.set(key,entry);
    return entry.value;
  }

  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    this.prune();this.remove(key);
    // A conservative bounded traversal avoids allocating another large JSON string.
    const seen=new Set<object>();let bytes=key.length*2+128;
    const count=(v:any):void=>{
      if(bytes>this.maxBytes)return;
      if(typeof v==='string'){bytes+=v.length*2+24;return;}
      if(v&&typeof v==='object'){
        if(seen.has(v))return;seen.add(v);bytes+=64;
        for(const k of Object.keys(v)){bytes+=k.length*2+16;count(v[k]);if(bytes>this.maxBytes)break;}
      }else bytes+=16;
    };
    count(value);
    if(bytes>this.maxBytes||ttlSeconds<=0)return;
    while(this.store.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)this.remove(this.store.keys().next().value!);
    this.store.set(key, {
      value,
      expiresAt: this.clock() + ttlSeconds * 1000,bytes,
    });
    this.bytes+=bytes;
  }
}

export class UpstashRedisCacheBackend implements CacheBackend {
  private redis: Redis;

  constructor(url: string, token: string, private namespace = "econstats:v3") {
    this.redis = new Redis({ url, token });
  }

  private key(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async get(key: string): Promise<any | null> {
    return (await this.getEntry(key))?.value??null;
  }
  async getEntry(key:string){
    const [record,ttl]=await Promise.all([this.redis.get<any>(this.key(key)),this.redis.ttl(this.key(key))]);
    return record?.version===1&&ttl>0?{value:record.value,ttlSeconds:ttl}:null;
  }

  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.key(key), {version:1,value}, { ex: ttlSeconds });
  }
}

export class FileCacheBackend implements CacheBackend {
  constructor(private directory:string,private clock=()=>Date.now()){}
  async get(key:string){
    return (await this.getEntry(key))?.value??null;
  }
  async getEntry(key:string){
    const record=await readStored(storagePath(this.directory,key));
    return record?.version===1&&Number.isFinite(record.expiresAt)&&record.expiresAt>this.clock()?{value:record.value,ttlSeconds:(record.expiresAt-this.clock())/1000}:null;
  }
  async set(key:string,value:any,ttlSeconds:number){
    await mkdir(this.directory,{recursive:true});
    await atomicWrite(storagePath(this.directory,key),{version:1,expiresAt:this.clock()+ttlSeconds*1000,value});
  }
}

export class LayeredCache {
  private inFlight = new Map<string,{promise:Promise<any>;controller:AbortController;waiters:number;settled:boolean}>();

  constructor(
    private l1: CacheBackend,
    private l2?: CacheBackend,
    private l1MaxTtlSeconds = 900,
    private l2TimeoutMs=5000,
  ) {}

  async getOrCompute<T>(
    key: string,
    ttlSeconds: number,
    compute: (signal:AbortSignal) => Promise<T>,
    refresh = false,
    signal = requestSignal(),
  ): Promise<T> {
    checkCancelled(signal);
    const localHit = refresh ? null : await abortable(this.l1.get(key),signal);
    checkCancelled(signal);
    if (localHit !== null) return localHit;
    let pending = this.inFlight.get(key);
    if(!pending){
      const entry={promise:undefined as unknown as Promise<T>,controller:new AbortController(),waiters:0,settled:false};
      const work=async()=>{
      checkCancelled();
      if (this.l2 && !refresh) {
        try {
          const ioSignal=AbortSignal.any([entry.controller.signal,AbortSignal.timeout(this.l2TimeoutMs)]);
          const stored=this.l2.getEntry?await phase('cache.read',()=>abortable(this.l2!.getEntry!(key),ioSignal)):undefined;
          const sharedHit = this.l2.getEntry?stored?.value??null:await phase('cache.read',()=>abortable(this.l2!.get(key),ioSignal));
          checkCancelled();
          if (sharedHit !== null) {
            await this.l1.set(key, sharedHit, Math.min(ttlSeconds, this.l1MaxTtlSeconds,stored?.ttlSeconds??ttlSeconds));
            return sharedHit;
          }
        } catch (error) {
          checkCancelled();
          console.error("[cache] Persistent cache read failed; using source.");
        }
      }

      const value = await abortable(compute(entry.controller.signal));
      checkCancelled();
      await this.l1.set(key, value, Math.min(ttlSeconds, this.l1MaxTtlSeconds));
      if (this.l2) {
        try {
          await phase('cache.write',()=>abortable(this.l2!.set(key, value, ttlSeconds),AbortSignal.any([entry.controller.signal,AbortSignal.timeout(this.l2TimeoutMs)])));
        } catch (error) {
          checkCancelled();
          console.error("[cache] Persistent cache write failed; using memory.");
        }
      }
      return value;
      };
      entry.promise=Promise.resolve().then(()=>withWorkSignal(entry.controller.signal,work)).finally(()=>{
        entry.settled=true;
        if(this.inFlight.get(key)===entry)this.inFlight.delete(key);
      });
      // A disconnected last subscriber must not leave an unhandled rejection.
      void entry.promise.catch(()=>{});
      this.inFlight.set(key,entry);pending=entry;
    }
    pending.waiters++;
    try{return await abortable(pending.promise,signal);}
    finally{
      pending.waiters--;
      if(!pending.settled&&pending.waiters===0){
        pending.controller.abort(cancellation('no_waiters'));
        if(this.inFlight.get(key)===pending)this.inFlight.delete(key);
      }
    }
  }
}

export function createLayeredCache(): LayeredCache {
  const l1 = new MemoryCacheBackend();
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const namespace = process.env.CACHE_NAMESPACE || "econstats:v3";

  if (url && token) {
    return new LayeredCache(
      l1,
      new UpstashRedisCacheBackend(url, token, namespace),
    );
  }
  const directory=storageDirectory();
  return new LayeredCache(l1,directory?new FileCacheBackend(join(directory,"data-v3")):undefined);
}
