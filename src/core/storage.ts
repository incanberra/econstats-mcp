import {mkdir,readFile,writeFile,rename,rm,rmdir,stat} from "node:fs/promises";
import {join} from "node:path";
import {homedir} from "node:os";
import {createHash,randomUUID} from "node:crypto";

export function storageDirectory():string|undefined {
  return process.env.ECONSTATS_DISK_CACHE==="false"?undefined:process.env.ECONSTATS_CACHE_DIR||join(homedir(),".cache","econstats");
}
export function storagePath(directory:string,key:string):string {
  return join(directory,createHash("sha256").update(key).digest("hex")+".json");
}
export async function atomicWrite(path:string,value:unknown){
  const temporary=path+"."+randomUUID()+".tmp";
  try{await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);}
  finally{await rm(temporary,{force:true}).catch(()=>{});}
}
export async function readStored(path:string,strict=false):Promise<any>{
  try{return JSON.parse(await readFile(path,"utf8"));}catch(error:any){if(error.code==="ENOENT"||!strict&&error instanceof SyntaxError)return undefined;throw new Error("Local storage is unavailable or corrupt.");}
}
export async function withFileLock<T>(path:string,work:()=>Promise<T>):Promise<T>{
  const lock=path+".lock",started=Date.now();
  while(true){
    try{await mkdir(lock);break;}catch(error:any){
      if(error.code!=="EEXIST")throw new Error("Local request-budget storage is unavailable.");
      const info=await stat(lock).catch(()=>undefined);
      if(info&&Date.now()-info.mtimeMs>30000){await rmdir(lock).catch(()=>{});}
      if(Date.now()-started>2000)throw new Error("Local request-budget storage is busy; retry later.");
      await new Promise(r=>setTimeout(r,25));
    }
  }
  try{return await work();}finally{await rmdir(lock).catch(()=>{});}
}
