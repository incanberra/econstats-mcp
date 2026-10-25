import type {Frequency} from './evidence';
import type {Retrieval} from './selection';

export function periodBoundary(period:string,end=false):string {
  if(!/^\d{4}(?:-Q[1-4]|-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(period))throw new Error('Use YYYY, YYYY-Qq, YYYY-MM or YYYY-MM-DD for selection dates.');
  const year=Number(period.slice(0,4));
  const quarter=period.match(/-Q([1-4])$/);
  const month=quarter?(Number(quarter[1])-1)*3+(end?3:1):period.length>=7?Number(period.slice(5,7)):end?12:1;
  const day=period.length===10?Number(period.slice(8)):end?new Date(Date.UTC(year,month,0)).getUTCDate():1;
  const date=new Date(Date.UTC(year,month-1,day)),s=date.toISOString().slice(0,10);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new Error('Invalid selection calendar date.');
  return s;
}

export function selectionPeriod(period:string|undefined,frequency:Frequency,end=false):string|undefined {
  if(period===undefined)return undefined;
  const date=periodBoundary(period,end);
  if(frequency==='annual'&&period.length!==4||frequency==='quarterly'&&period.length!==4&&!/-Q[1-4]$/.test(period)||frequency==='monthly'&&period.length!==4&&!/^\d{4}-\d{2}$/.test(period))throw new Error('Selection dates must use the requested frequency or whole years.');
  return frequency==='annual'?date.slice(0,4):frequency==='monthly'?date.slice(0,7):frequency==='quarterly'?`${date.slice(0,4)}-Q${Math.floor((Number(date.slice(5,7))-1)/3)+1}`:date;
}

export function requestedPeriods(start:string|undefined,end:string|undefined,frequency:Frequency):string[]|undefined {
  if(!start||!end||frequency==='daily'||frequency==='weekly')return undefined;
  const result:string[]=[];let date=new Date(`${periodBoundary(start)}T00:00:00Z`);
  const endDate=periodBoundary(end,true),step=frequency==='annual'?12:frequency==='quarterly'?3:1;
  while(date.toISOString().slice(0,10)<=endDate){
    result.push(selectionPeriod(frequency==='quarterly'?`${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth()/3)+1}`:frequency==='monthly'?date.toISOString().slice(0,7):String(date.getUTCFullYear()),frequency)!);
    if(result.length>120)throw new Error('Selection supports up to 120 periods; split this date range into smaller requests.');
    date.setUTCMonth(date.getUTCMonth()+step);
  }
  return result;
}

/** Every generated request is executable by the corresponding public data tool. */
export function dateRetrieval(r:Retrieval,start:string|undefined,end:string|undefined,observations:number):Retrieval {
  if(!start&&!end)return r;
  const a={...r.arguments},sy=start?.slice(0,4),ey=end?.slice(0,4);
  if(r.tool==='fred_get_series'){
    if(start)a.start_period=periodBoundary(start);
    if(end)a.end_period=periodBoundary(end,true);
    a.limit=120;
  }else if(r.tool==='bls_get_series'){
    // Include baseline levels needed for year-on-year or monthly changes.
    a.start_year=String(Number(sy??ey)-Math.ceil((sy?0:observations)/12)-1);
    a.end_year=ey??String(new Date().getUTCFullYear());
  }else if(r.tool==='bea_get_data'){
    const last=Number(ey??new Date().getUTCFullYear()),first=Number(sy??last-Math.ceil(observations/4));
    if(last-first>31)throw new Error('BEA selection range exceeds 32 years.');
    a.year=Array.from({length:last-first+1},(_,i)=>String(first+i)).join(',');
  }else if(r.tool==='worldbank_get_data'){
    a.start_year=Number(sy??Number(ey)-observations-3);a.end_year=Number(ey??new Date().getUTCFullYear());
  }else {
    if(start)a.start_period=start;
    if(end)a.end_period=end;
    // Replace any registry default that would conflict with an end-only request.
    if(!start)delete a.start_period;
    if(r.tool==='eia_get_data')a.length=120;else if(r.tool!=='ecb_get_data')a.limit=120;
  }
  return {tool:r.tool,arguments:a};
}
