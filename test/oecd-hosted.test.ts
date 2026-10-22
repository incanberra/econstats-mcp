import {expect,test} from 'bun:test';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {checkOecdHosted} from '../scripts/check-oecd-hosted';

test('production HTTP entrypoint handles real OECD metadata, adding the US, shared cancellation and recovery',async()=>{
  const reservation=createServer();await new Promise<void>(r=>reservation.listen(0,'127.0.0.1',r));
  const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const token='test-only-oecd-'+crypto.randomUUID()+'-'+crypto.randomUUID();
  const child=Bun.spawn([process.execPath,'--no-env-file','--preload',resolve(import.meta.dir,'fixtures/oecd-provider.ts'),resolve(import.meta.dir,'../src/index.ts')],{
    cwd:resolve(import.meta.dir,'..'),stdout:'ignore',stderr:'pipe',env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,
      NODE_ENV:'production',PORT:String(port),MCP_HOST:'127.0.0.1',MCP_AUTH_MODE:'bearer',MCP_AUTH_TOKEN:token,
      ECONSTATS_DISK_CACHE:'false',PREFETCH_HOT_SERIES:'false'},
  });
  const logPromise=new Response(child.stderr).text();
  try{
    const base=`http://127.0.0.1:${port}`;let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await Bun.sleep(50);}
    expect(ready).toBe(true);
    const result=await checkOecdHosted(base,token);expect(result.cancellationRecovery).toBe(true);
  }finally{child.kill();await child.exited;}
  const logs=await logPromise;
  expect(logs).toContain('[oecd_fixture] metadata=1');expect(logs).not.toContain('[oecd_fixture] metadata=2');
  expect(logs).toContain('[oecd_fixture] body_cancelled');expect(logs).not.toContain(token);
  const phases=logs.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));
  for(const name of ['oecd.metadata.download','oecd.metadata.parse','oecd.data.download','oecd.data.parse','result.revisions','result.render'])
    expect(phases.some(p=>p.phase===name&&p.state==='complete')).toBe(true);
  expect(phases.every(p=>/^[a-f0-9-]{36}$/.test(p.request_id)&&typeof p.rss_bytes==='number')).toBe(true);
  expect(phases.some(p=>p.phase==='oecd.data.download'&&p.state==='cancelled')).toBe(true);
},30000);
