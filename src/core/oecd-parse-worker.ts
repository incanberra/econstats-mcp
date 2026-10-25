// Only invoked as an isolated parser subprocess, never as an MCP service.
import {XMLValidator} from 'fast-xml-parser';
import {sdmxDefinition} from './abs';
import {parseSdmxCsv} from './sdmx-csv';
import type {ParseJob} from './oecd-parse-client';

try{
  const job=JSON.parse(await Bun.stdin.text()) as ParseJob;
  let value;
  if(job.kind==='definition'){
    if(XMLValidator.validate(job.xml)!==true)throw new Error('Incomplete XML.');
    const [agency,id]=job.datasetId.split(',');
    value=sdmxDefinition(job.xml,id,agency,job.version);
  }else if(job.kind==='data'){
    value=parseSdmxCsv('OECD',job.csv,new URL(job.url),job.query,job.definition,job.key,job.retrievedAt,job.limit);
  }else throw new Error('Invalid parser job.');
  process.stdout.write(JSON.stringify({ok:true,value}));
}catch{
  // Neither stdout nor stderr may reveal provider content or raw parser exceptions.
  process.stdout.write('{"ok":false}');process.exitCode=1;
}
