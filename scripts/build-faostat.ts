// Public bulk files are processed at build time, never inside a hosted tool call.
import {Database} from 'bun:sqlite';
import {createReadStream} from 'node:fs';
import {mkdir,open,rename,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createInflateRaw} from 'node:zlib';
import {Readable} from 'node:stream';
import {parse} from 'csv-parse';
import {createHash} from 'node:crypto';
import {FAOSTAT_DOMAINS,FAOSTAT_CATALOG,FAOSTAT_START_YEAR,faostatSource,type FaostatDomain} from '../src/core/faostat-catalog';

export async function normalizedCsv(zipPath:string){
  const file=await open(zipPath,'r');
  try{
    const {size}=await file.stat(),tail=Buffer.alloc(Math.min(size,65557));await file.read(tail,0,tail.length,size-tail.length);
    let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0||tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0)throw new Error('Unsupported ZIP directory.');
    const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count>100||length>1_000_000||offset+length>size)throw new Error('ZIP directory limit exceeded.');
    const directory=Buffer.alloc(length);await file.read(directory,0,length,offset);let at=0,selected:any;
    for(let i=0;i<count;i++){
      if(at+46>length||directory.readUInt32LE(at)!==0x02014b50)throw new Error('Invalid ZIP entry.');
      const n=directory.readUInt16LE(at+28),extra=directory.readUInt16LE(at+30),comment=directory.readUInt16LE(at+32),name=directory.subarray(at+46,at+46+n).toString();
      if(/\(Normalized\)\.csv$/i.test(name)){
        if(selected)throw new Error('Multiple normalized CSVs.');
        selected={method:directory.readUInt16LE(at+10),flags:directory.readUInt16LE(at+8),compressed:directory.readUInt32LE(at+20),expanded:directory.readUInt32LE(at+24),offset:directory.readUInt32LE(at+42)};
      }at+=46+n+extra+comment;
    }
    if(!selected||selected.flags&1||![0,8].includes(selected.method)||selected.expanded>2_000_000_000||!selected.compressed)throw new Error('Unsupported or oversized normalized CSV.');
    const local=Buffer.alloc(30);await file.read(local,0,30,selected.offset);
    if(local.readUInt32LE(0)!==0x04034b50)throw new Error('Invalid local ZIP entry.');
    const start=selected.offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);
    if(start+selected.compressed>size)throw new Error('Truncated ZIP.');
    const source=createReadStream(zipPath,{start,end:start+selected.compressed-1});
    const inflated=selected.method===8?source.pipe(createInflateRaw()):source;
    source.on('error',e=>inflated.destroy(e));
    let expanded=0;
    const bounded=Readable.from((async function*(){for await(const chunk of inflated){expanded+=chunk.length;if(expanded>selected.expanded||expanded>2_000_000_000)throw new Error('Expanded CSV limit exceeded.');yield chunk;}if(expanded!==selected.expanded)throw new Error('Incomplete normalized CSV.');})());
    const parser=parse({columns:true,bom:true,skip_empty_lines:true,max_record_size:100_000});bounded.on('error',e=>parser.destroy(e));return bounded.pipe(parser);
  }finally{await file.close();}
}
export async function download(url:string,path:string){
  const res=await fetch(url,{signal:AbortSignal.timeout(180000),redirect:'error'});if(!res.ok||!res.body)throw new Error(`FAOSTAT download HTTP ${res.status}.`);
  const file=await open(path,'w');let size=0;const hash=createHash('sha256');
  try{for await(const chunk of res.body){size+=chunk.length;if(size>96_000_000)throw new Error('FAOSTAT archive exceeds 96 MB.');hash.update(chunk);await file.writeFile(chunk);}return hash.digest('hex');}finally{await file.close();}
}
export async function buildSnapshot(domain:FaostatDomain,zipPath:string,output:string,updated:string|null,sha256:string){
  const temporary=join(output,domain+'.sqlite.partial'),target=join(output,domain+'.sqlite');await rm(temporary,{force:true});
  const db=new Database(temporary);let count=0,min=9999,max=0;const known=new Map<string,string>();
  try{
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192; CREATE TABLE codes(dimension TEXT,code TEXT,label TEXT,PRIMARY KEY(dimension,code)) WITHOUT ROWID; CREATE TABLE observations(area INTEGER,item INTEGER,element INTEGER,year INTEGER,unit TEXT,value REAL,flag TEXT,note TEXT,PRIMARY KEY(area,item,element,year,unit)) WITHOUT ROWID;');
    const code=db.prepare('INSERT INTO codes VALUES(?,?,?)'),insert=db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for await(const row of await normalizedCsv(zipPath)){
      if(!/^\d{4}$/.test(row.Year))throw new Error('Unexpected FAOSTAT period.');const year=Number(row.Year);
      if(year<FAOSTAT_START_YEAR)continue;
      for(const dimension of ['Area','Item','Element']){
        const id=row[dimension+' Code'],label=row[dimension];if(!/^\d+$/.test(id)||!label)throw new Error('Missing FAOSTAT dimension.');
        const key=dimension+':'+id;if(!known.has(key)){known.set(key,label);code.run(dimension.toLowerCase(),id,label);}else if(known.get(key)!==label)throw new Error('Conflicting FAOSTAT dimension labels.');
      }
      if(!row.Unit||row.Value!==''&&!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row.Value))throw new Error('Invalid FAOSTAT unit/value.');
      const value=row.Value===''?null:Number(row.Value);if(value!==null&&!Number.isFinite(value))throw new Error('Non-finite FAOSTAT value.');
      insert.run(Number(row['Area Code']),Number(row['Item Code']),Number(row['Element Code']),year,row.Unit,value,row.Flag??'',row.Note??'');
      count++;min=Math.min(min,year);max=Math.max(max,year);if(count%10000===0)db.exec('COMMIT; BEGIN');
    }
    db.exec('COMMIT');code.finalize();insert.finalize();if(!count)throw new Error('Empty FAOSTAT snapshot.');
    db.exec('PRAGMA optimize');
    const manifest={schemaVersion:1,domain,name:FAOSTAT_DOMAINS[domain].name,sourceUrl:faostatSource(domain),sourceUpdatedAt:updated,retrievedAt:new Date().toISOString(),sourceSha256:sha256,rows:count,startYear:min,endYear:max,earliestIncludedYear:FAOSTAT_START_YEAR};
    db.exec('CREATE TABLE manifest(json TEXT NOT NULL)');db.run('INSERT INTO manifest VALUES(?)',[JSON.stringify(manifest)]);db.close(true);
    await rename(temporary,target);await writeFile(join(output,domain+'.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
  }catch(error){try{db.exec('ROLLBACK');}catch{}try{db.close(true);}catch{}await rm(temporary,{force:true}).catch(()=>{});throw error;}
}
if(import.meta.main){
  const index=process.argv.indexOf('--output');if(index>=0&&!process.argv[index+1])throw new Error('Missing --output directory.');
  const output=resolve(index<0?'faostat-data':process.argv[index+1]);await mkdir(output,{recursive:true});
  const domains=(process.env.FAOSTAT_BUILD_DOMAINS??Object.keys(FAOSTAT_DOMAINS).join(',')).split(',') as FaostatDomain[];
  if(domains.some(d=>!Object.hasOwn(FAOSTAT_DOMAINS,d)))throw new Error('Unsupported build domain.');
  const res=await fetch(FAOSTAT_CATALOG,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!res.ok)throw new Error('FAOSTAT catalogue unavailable.');
  const catalog:any=await res.json();if(!Array.isArray(catalog.Datasets?.Dataset))throw new Error('Invalid FAOSTAT catalogue.');
  for(const domain of domains){
    console.log(`Building FAOSTAT ${domain} from official public CSV...`);const zip=join(output,domain+'.zip');
    try{const sha=await download(faostatSource(domain),zip),entry=catalog.Datasets.Dataset.find((d:any)=>d.DatasetCode===domain);const manifest=await buildSnapshot(domain,zip,output,entry?.DateUpdate??null,sha);console.log(`${domain}: ${manifest.rows} observations, ${manifest.startYear}–${manifest.endYear}`);}finally{await rm(zip,{force:true});}
  }
}
