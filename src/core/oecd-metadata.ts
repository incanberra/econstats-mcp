import type {LayeredCache} from './cache';
import type {SdmxDefinition} from './abs';
import {buildOecdStructureUrl,requestOecd,type OecdSpace} from './oecd';
import {parseOecdJob} from './oecd-parse-client';
import {phase} from './request-context';
import {oecdStages} from './oecd-stage';

/** Discovery and retrieval share a single compact, validated definition and in-flight parse. */
export async function getOecdDefinition(cache:LayeredCache,datasetId:string,version?:string,space?:OecdSpace):Promise<SdmxDefinition>{
  const url=buildOecdStructureUrl(datasetId,version,space);
  return cache.getOrCompute(`oecd:definition:v2:${url}`,86400,()=>oecdStages.run(async()=>{
    const xml=await phase('oecd.metadata.download',()=>requestOecd(url,true));
    return phase('oecd.metadata.parse',()=>parseOecdJob<SdmxDefinition>({kind:'definition',xml,datasetId,version}));
  }));
}
