import {expect,test} from 'bun:test';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RevisionTracker} from '../src/core/revisions';
import {dataSeries,observation,finishResult} from '../src/core/result';
import {storagePath} from '../src/core/storage';
const make=(time:string,values:[string,number|null,string?][]= [['2026-07',1]],unit='percent')=>finishResult('ABS',{},[dataSeries('ABS:TEST(1.0)',{FREQ:'M',MEASURE:'TEST'},'https://example.org/data',{unit,unitMultiplier:0,observations:values.map(([p,v,status])=>observation(p,v,status?{OBS_STATUS:status}:{}))})],`2026-10-${time}T00:00:00.000Z`);
test('revision tracker distinguishes baseline, extensions, value revisions, missing changes and flag changes',async()=>{
  const t=new RevisionTracker(undefined),base=make('01');const first=await t.track(base);expect(first.series[0].revision!.status).toBe('baseline');expect(base.series[0].revision).toBeUndefined();
  const next=await t.track(make('02',[['2026-07',2],['2026-08',null]]));expect((next.series[0].revision!.changes as any[]).map(c=>c.kind)).toEqual(['value_changed','new_observation']);
  expect(((await t.track(make('03',[['2026-08',0,'P']]))).series[0].revision!.changes as any[])[0].kind).toBe('missing_to_value');
  expect(((await t.track(make('04',[['2026-08',0,'F']]))).series[0].revision!.changes as any[])[0].kind).toBe('status_changed');
  expect(((await t.track(make('05',[['2026-08',null,'F']]))).series[0].revision!.changes as any[])[0].kind).toBe('value_to_missing');
});
test('cached and older snapshots never roll the baseline backwards',async()=>{
  const t=new RevisionTracker(undefined),old=make('01'),fresh=make('03',[['2026-07',2]]);await t.track(old);await t.track(fresh);
  expect((await t.track(old)).series[0].revision!.status).toBe('cached_or_older_snapshot');expect((await t.track(fresh)).series[0].revision!.status).toBe('cached_or_older_snapshot');
  const history:any=await t.history(old.series[0].id);expect(history.retainedVintages).toBe(2);expect(history.history.at(-1).observations[0].value).toBe(2);
});
test('narrow windows are not withdrawals; metadata changes are explicit; identities ignore window and key order',async()=>{
  const t=new RevisionTracker(undefined);const a=make('01',[['2026-07',1],['2026-08',2]]);await t.track(a);
  expect((await t.track(make('02',[['2026-08',2]]))).series[0].revision!.status).toBe('unchanged');
  const b=await t.track(make('03',[['2026-07',1],['2026-08',2]],'AUD'));expect((b.series[0].revision!.changes as any[]).map(c=>c.kind)).toEqual(['metadata_changed']);
  const reordered=finishResult('ABS',{},[dataSeries('ABS:TEST(1.0)',{MEASURE:'TEST',FREQ:'M'},'https://example.org/other')],a.retrievedAt);expect(reordered.series[0].id).toBe(a.series[0].id);
});
test('persistent tracking survives restarts and concurrent writers and bounds retention',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'econstats-revisions-')),a=new RevisionTracker(dir,2),b=new RevisionTracker(dir,2),r=make('01');await a.track(r);
  await Promise.all([a.track(make('02',[['2026-07',2]])),b.track(make('03',[['2026-07',3]]))]);
  await a.track(make('04',[['2026-07',4]]));const h:any=await new RevisionTracker(dir,2).history(r.series[0].id);expect(h.storage).toBe('persistent');expect(h.retainedVintages).toBe(2);expect(h.history.at(-1).observations[0].value).toBe(4);expect(h.droppedVintages).toBeGreaterThan(0);
});
test('corrupt history is not overwritten and retrieval remains usable with a tracking warning',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'econstats-revisions-')),t=new RevisionTracker(dir),r=make('01'),p=storagePath(dir,r.series[0].id);await writeFile(p,'broken');
  expect((await t.track(r)).series[0].revision!.status).toBe('unavailable');expect(await readFile(p,'utf8')).toBe('broken');await expect(t.history(r.series[0].id)).rejects.toThrow();await expect(t.history('../x')).rejects.toThrow();
});
test('definition changes start a new comparison baseline; FRED realtime boundaries do not create spurious revisions',async()=>{
  const t=new RevisionTracker(undefined);await t.track(make('01',[['2026-07',1],['2026-08',2]]));
  const changed=await t.track(make('02',[['2026-08',200]],'AUD'));expect((changed.series[0].revision!.changes as any[]).map(c=>c.kind)).toEqual(['metadata_changed']);
  const later=await t.track(make('03',[['2026-07',100],['2026-08',200]],'AUD'));expect((later.series[0].revision!.changes as any[]).map(c=>c.kind)).toEqual(['new_observation']);
  const a=make('04',[['2026-07',100],['2026-08',200]],'AUD');a.series[0].observations[0].attributes.realtime_start='2026-10-04';expect((await t.track(a)).series[0].revision!.status).toBe('unchanged');
});
