import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicWrite,readStored,storageDirectory,storagePath,withFileLock} from './storage';
import {stable,type DataResult,type DataSeries,type DataObservation} from './result';
import {MemoryCacheBackend} from './cache';

type Snapshot={retrievedAt:string;definition:Record<string,unknown>;observations:DataObservation[];urls:string[]};
type Change={kind:string;period?:string;before:unknown;after:unknown};
type Vintage=Snapshot&{changes:Change[]};
type RecordState={version:1;id:string;source:string;lastCheckedAt:string;definition:Record<string,unknown>;observations:Record<string,DataObservation>;history:Vintage[];droppedVintages:number};
const definition=(s:DataSeries)=>({dataset:s.dataset,dimensions:s.dimensions,frequency:s.frequency,unit:s.unit,unitMultiplier:s.unitMultiplier,adjustment:s.adjustment,transformation:s.transformation,attributes:Object.fromEntries(Object.entries(s.attributes).filter(([k])=>!['last_updated','retrievedAt','updated'].includes(k)))});
const comparableObservation=(o:DataObservation)=>({...o,attributes:Object.fromEntries(Object.entries(o.attributes).filter(([k])=>!['realtime_start','realtime_end'].includes(k)))});

/** Observation snapshots from this installation, never a reconstructed release-vintage archive. */
export class RevisionTracker {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private directory:string|undefined=process.env.ECONSTATS_REVISION_DIR||(storageDirectory()?join(storageDirectory()!,'revisions-v1'):undefined),private retain=50,private memory=new MemoryCacheBackend(256,16*1024*1024)) {
    if(!Number.isInteger(retain)||retain<2||retain>200)throw new Error('Retain 2-200 revision vintages.');
  }
  private async state<T>(id:string,work:(state:RecordState|undefined)=>Promise<{state?:RecordState;value:T}>):Promise<T>{
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Use a series_id returned by a data tool.');
    const apply=async()=>{
      const file=this.directory?storagePath(this.directory,id):undefined;
      const current=file?await readStored(file,true):await this.memory.get(id);
      if(current&&(current.version!==1||current.id!==id||!Array.isArray(current.history)||!current.observations||!Number.isFinite(Date.parse(current.lastCheckedAt))))throw new Error('Revision history is corrupt; it was not overwritten.');
      const next=await work(current);if(next.state){if(file)await atomicWrite(file,next.state);else{
        await this.memory.set(id,next.state,30*86400);
        if(await this.memory.get(id)===null)throw new Error('Revision snapshot exceeds the memory budget.');
      }}return next.value;
    };
    const run=async()=>{if(!this.directory)return apply();await mkdir(this.directory,{recursive:true});return withFileLock(storagePath(this.directory,id),apply);};
    const pending=this.queue.then(run,run);this.queue=pending.catch(()=>{});return pending;
  }
  async track(result:DataResult):Promise<DataResult>{
    // Never mutate the shared cache entry with caller-specific history state.
    const r=structuredClone(result);
    for(const series of r.series){
      try{series.revision=await this.state<Record<string,unknown>>(series.id,async old=>{
        if(old&&Date.parse(r.retrievedAt)<=Date.parse(old.lastCheckedAt))return {value:{status:'cached_or_older_snapshot',storage:this.directory?'persistent':'memory',seriesId:series.id,lastCheckedAt:old.lastCheckedAt,changes:[]}};
        const def=definition(series),changes:Change[]=[];
        const changedDefinition=!!old&&stable(old.definition)!==stable(def);
        if(old){
          if(changedDefinition)changes.push({kind:'metadata_changed',before:old.definition,after:def});
          for(const o of changedDefinition?[]:series.observations){
            const previous=old.observations[o.period];
            if(!previous)changes.push({kind:'new_observation',period:o.period,before:null,after:o});
            else if(stable(comparableObservation(previous))!==stable(comparableObservation(o)))changes.push({kind:previous.value!==o.value?(previous.value===null?'missing_to_value':o.value===null?'value_to_missing':'value_changed'):'status_changed',period:o.period,before:previous,after:o});
          }
        }
        const current:RecordState=old??{version:1,id:series.id,source:r.source,lastCheckedAt:r.retrievedAt,definition:def,observations:{},history:[],droppedVintages:0};
        const needsSnapshot=!old||changes.length>0;
        if(needsSnapshot)current.history.push({retrievedAt:r.retrievedAt,definition:def,observations:series.observations,urls:series.urls,changes});
        const dropped=Math.max(0,current.history.length-this.retain);current.droppedVintages+=dropped;current.history=current.history.slice(-this.retain);
        current.lastCheckedAt=r.retrievedAt;current.definition=def;
        // Retain only observations present in retained snapshots; query-window omissions are not deletions.
        current.observations=Object.fromEntries(current.history.filter(v=>stable(v.definition)===stable(def)).flatMap(v=>v.observations.map(o=>[o.period,o])));
        return {state:current,value:{status:!old?'baseline':changes.length?'changes_detected':'unchanged',storage:this.directory?'persistent':'memory',seriesId:series.id,changes,retainedVintages:current.history.length,droppedVintages:current.droppedVintages}};
      });}catch{series.revision={status:'unavailable',changes:[],message:'Revision storage is unavailable or exceeds its memory budget; data retrieval succeeded, but no tracking claim is made.'};}
    }
    r.notes.push('Revision history records snapshots retrieved by this installation. Cached replays create no vintage; absent periods in narrower queries are not deletions. New observations are distinct from revisions. Older publication vintages are not reconstructed.');
    if(!this.directory)r.notes.push('In-memory revision history is bounded and may evict older series; it is not a durable archive.');
    return r;
  }
  async history(id:string,limit=10){
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error('History limit must be 1-50.');
    return this.state(id,async s=>({value:s?{status:'found',seriesId:id,source:s.source,lastCheckedAt:s.lastCheckedAt,storage:this.directory?'persistent':'memory',retainedVintages:s.history.length,droppedVintages:s.droppedVintages,history:s.history.slice(-limit),notes:['Snapshots are observed retrievals, not official historical release vintages. Missing periods in a query do not imply withdrawal. History retention is bounded.']}:{status:'not_found',seriesId:id,history:[]}}));
  }
}
