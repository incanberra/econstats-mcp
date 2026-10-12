import { Redis } from "@upstash/redis";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {atomicWrite,readStored,storageDirectory,storagePath} from "./storage";

export interface CacheBackend {
  get(key: string): Promise<any | null>;
  set(key: string, value: any, ttlSeconds: number): Promise<void>;
  getEntry?(key:string):Promise<{value:any;ttlSeconds:number}|null>;
}

type CacheEntry = {
  value: any;
  expiresAt: number;
};

export class MemoryCacheBackend implements CacheBackend {
  private store = new Map<string, CacheEntry>();

  async get(key: string): Promise<any | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
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
  private inFlight = new Map<string, Promise<any>>();

  constructor(
    private l1: CacheBackend,
    private l2?: CacheBackend,
    private l1MaxTtlSeconds = 900,
  ) {}

  async getOrCompute<T>(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const localHit = await this.l1.get(key);
    if (localHit !== null) return localHit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const work = (async () => {
      if (this.l2) {
        try {
          const entry=this.l2.getEntry?await this.l2.getEntry(key):undefined;
          const sharedHit = this.l2.getEntry?entry?.value??null:await this.l2.get(key);
          if (sharedHit !== null) {
            await this.l1.set(key, sharedHit, Math.min(ttlSeconds, this.l1MaxTtlSeconds,entry?.ttlSeconds??ttlSeconds));
            return sharedHit;
          }
        } catch (error) {
          console.error("[cache] Persistent cache read failed; using source.");
        }
      }

      const value = await compute();
      await this.l1.set(key, value, Math.min(ttlSeconds, this.l1MaxTtlSeconds));
      if (this.l2) {
        try {
          await this.l2.set(key, value, ttlSeconds);
        } catch (error) {
          console.error("[cache] Persistent cache write failed; using memory.");
        }
      }
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, work);
    return work;
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
