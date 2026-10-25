import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {faostatCodes,faostatDomains,fetchFaostat,validateFaostat,type FaostatParams} from '../src/core/faostat';
import {normalizedCsv,buildSnapshot} from '../scripts/build-faostat';
const old=process.env.ECONSTATS_FAOSTAT_DIR;afterEach(()=>{if(old===undefined)delete process.env.ECONSTATS_FAOSTAT_DIR;else process.env.ECONSTATS_FAOSTAT_DIR=old;});
const p:FaostatParams={domain:'QCL',area_codes:['10'],item_codes:['15'],element_codes:['5510'],start_year:2022,end_year:2024,limit:10};
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'econstats-faostat-'));process.env.ECONSTATS_FAOSTAT_DIR=dir;const db=new Database(join(dir,'QCL.sqlite'));
  db.exec('CREATE TABLE codes(dimension TEXT,code TEXT,label TEXT); CREATE TABLE observations(area INTEGER,item INTEGER,element INTEGER,year INTEGER,unit TEXT,value REAL,flag TEXT,note TEXT); CREATE TABLE manifest(json TEXT);');
  for(const row of [['area','10','Australia'],['item','15','Wheat'],['element','5510','Production']])db.run('INSERT INTO codes VALUES(?,?,?)',row);
  db.run('INSERT INTO observations VALUES(10,15,5510,2022,\'t\',0,\'A\',\'\'),(10,15,5510,2023,\'t\',123,\'E\',\'Estimate\'),(10,15,5510,2024,\'t\',NULL,\'M\',\'\')');
  db.run('INSERT INTO manifest VALUES(?)',[JSON.stringify({schemaVersion:1,domain:'QCL',retrievedAt:'2026-10-20T00:00:00Z',sourceUpdatedAt:'2026-07-01T00:00:00',sourceSha256:'fixture',startYear:1990,endYear:2024})]);db.close();return dir;
}
test('FAOSTAT validates exact native codes and bounded years locally',()=>{
  for(const bad of [{domain:'../QCL'},{area_codes:['AU']},{area_codes:['010']},{item_codes:['15 OR 1=1']},{start_year:1961},{end_year:1980},{limit:5001}])expect(()=>validateFaostat({...p,...bad} as any)).toThrow();
});
test('FAOSTAT returns explicit snapshot provenance, flags, units, zero/null and partial query coverage',async()=>{
  await fixture();const result=fetchFaostat(p);expect(result.series[0].observations.map(o=>o.value)).toEqual([0,123,null]);expect(result.series[0].observations[1].attributes).toEqual({flag:'E',note:'Estimate'});expect(result.series[0].labels.item).toBe('Wheat');expect(result.series[0].unit).toBe('t');expect(result.notes.join(' ')).toContain('not refreshed by fresh=true');expect(fetchFaostat({...p,limit:1}).coverage.truncated).toBe(true);expect(()=>fetchFaostat({...p,item_codes:['99']})).toThrow('Unknown');
  expect(faostatCodes('QCL','item','wheat').codes).toEqual([{code:'15',label:'Wheat'}]);expect(faostatDomains().domains.find(d=>d.domain==='RFN')!.installed).toBe(false);
});
test('FAOSTAT code searches bind input literally and missing snapshots are actionable',async()=>{
  await fixture();expect(faostatCodes('QCL','area',"' OR 1=1").total).toBe(0);expect(()=>fetchFaostat({...p,domain:'RFN'})).toThrow('snapshot is not installed');
});
test('snapshot builder rejects malformed archives instead of publishing partial data',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'econstats-faostat-bad-')),path=join(dir,'bad.zip');await writeFile(path,'not a ZIP');await expect(normalizedCsv(path)).rejects.toThrow('ZIP');await expect(buildSnapshot('QCL',path,dir,null,'fixture')).rejects.toThrow();
});
