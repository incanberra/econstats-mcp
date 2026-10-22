import {expect,test} from 'bun:test';
import {LayeredCache,MemoryCacheBackend} from '../src/core/cache';
import {requestSignal,withRequestContext,cancellation} from '../src/core/request-context';
import {OecdStageQueue} from '../src/core/oecd-stage';

const tick=()=>new Promise(r=>setTimeout(r,0));
test('memory cache evicts least recently used entries and prunes expired entries without revisiting their keys',async()=>{
  let now=0;const cache=new MemoryCacheBackend(2,2000,()=>now);
  await cache.set('a',1,1);await cache.set('b',2,10);expect(await cache.get('a')).toBe(1);
  await cache.set('c',3,10);expect(await cache.get('b')).toBeNull();
  now=1001;expect(cache.stats().entries).toBe(1);expect(await cache.get('a')).toBeNull();
  await cache.set('too_large','x'.repeat(2000),10);expect(await cache.get('too_large')).toBeNull();
  expect(cache.stats().bytes).toBeLessThanOrEqual(2000);expect(await cache.get('c')).toBe(3);
});
test('one cancelled subscriber cannot cancel a coalesced request needed by another subscriber',async()=>{
  const cache=new LayeredCache(new MemoryCacheBackend()),a=new AbortController(),b=new AbortController();
  let release!:(v:number)=>void,computeSignal!:AbortSignal,calls=0;
  const compute=async()=>{calls++;computeSignal=requestSignal()!;return await new Promise<number>(r=>release=r);};
  const first=withRequestContext({signal:a.signal},()=>cache.getOrCompute('key',60,compute));
  const second=withRequestContext({signal:b.signal},()=>cache.getOrCompute('key',60,compute));
  await tick();a.abort(cancellation('client_closed'));
  await expect(first).rejects.toMatchObject({name:'AbortError'});
  expect(computeSignal.aborted).toBe(false);release(7);expect(await second).toBe(7);expect(calls).toBe(1);
  expect(await cache.getOrCompute('key',60,async()=>99)).toBe(7);
});
test('last subscriber cancellation aborts work, avoids caching late completion, and permits an immediate retry',async()=>{
  const backend=new MemoryCacheBackend(),cache=new LayeredCache(backend),abort=new AbortController();
  let late!:(v:number)=>void,signal!:AbortSignal;
  const first=withRequestContext({signal:abort.signal},()=>cache.getOrCompute('same',60,async()=>{
    signal=requestSignal()!;return new Promise<number>(r=>late=r);
  }));
  await tick();abort.abort(cancellation('deadline'));
  await expect(first).rejects.toMatchObject({name:'TimeoutError'});expect(signal.aborted).toBe(true);
  expect(await cache.getOrCompute('same',60,async()=>11)).toBe(11);
  late(99);await tick();expect(await backend.get('same')).toBe(11);
});
test('already-cancelled requests do not start work or return a cached result',async()=>{
  const backend=new MemoryCacheBackend();await backend.set('key',7,60);
  const cache=new LayeredCache(backend),controller=new AbortController();controller.abort(cancellation('deadline'));
  let calls=0;
  await expect(withRequestContext({signal:controller.signal},()=>cache.getOrCompute('key',60,async()=>++calls))).rejects.toMatchObject({name:'TimeoutError'});
  expect(calls).toBe(0);
});
test('stalled optional cache reads and writes cannot stall data retrieval',async()=>{
  const cache=new LayeredCache(new MemoryCacheBackend(),{get:()=>new Promise(()=>{}),set:()=>new Promise(()=>{})},900,20);
  expect(await cache.getOrCompute('key',60,async()=>7)).toBe(7);
  expect(await cache.getOrCompute('key',60,async()=>99)).toBe(7);
});
test('cancelling a queued OECD stage cannot overlap the next stage with the active download',async()=>{
  const queue=new OecdStageQueue(),controller=new AbortController();let release!:()=>void,thirdStarted=false,secondStarted=false;
  const first=queue.run(()=>new Promise<void>(r=>release=r));
  const second=queue.run(async()=>{secondStarted=true;},controller.signal);
  const third=queue.run(async()=>{thirdStarted=true;});
  await tick();controller.abort(cancellation('client_closed'));await expect(second).rejects.toMatchObject({name:'AbortError'});
  await tick();expect(secondStarted).toBe(false);expect(thirdStarted).toBe(false);
  release();await first;await third;expect(thirdStarted).toBe(true);
});
