import {AccessError} from './access';
import {abortable,checkCancelled,requestSignal,phase} from './request-context';

/** Download and parse one OECD payload at a time, so buffered bodies cannot multiply. */
export class OecdStageQueue {
  private tail:Promise<void>=Promise.resolve();
  private queued=0;
  async run<T>(work:()=>Promise<T>,signal=requestSignal()):Promise<T>{
    checkCancelled(signal);
    if(this.queued>=16)throw new AccessError('OECD','unavailable','OECD processing is busy; retry after current requests finish.');
    this.queued++;
    const previous=this.tail;let release!:()=>void,acquired=false;
    this.tail=new Promise<void>(resolve=>release=resolve);
    try{await phase('oecd.queue',()=>abortable(previous,signal));checkCancelled(signal);acquired=true;return await work();}
    finally{
      this.queued--;
      // A cancelled waiter must not allow later work to overlap its predecessor.
      if(acquired)release();else void previous.then(release,release);
    }
  }
}
export const oecdStages=new OecdStageQueue();
