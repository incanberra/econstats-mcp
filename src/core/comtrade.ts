import {AccessError,providerFetch} from './access';
import {attributes,dataSeries,finishResult,observation,stable,type DataSeries} from './result';
import type {LayeredCache} from './cache';

const ROOT='https://comtradeapi.un.org';
export const COMTRADE_CLASSIFICATIONS=['HS','H0','H1','H2','H3','H4','H5','H6'] as const;
export type ComtradeClassification=typeof COMTRADE_CLASSIFICATIONS[number];
export type ComtradeMode='preview'|'authenticated';
export interface ComtradeSelection {
 reporter_code:number;periods:string[];frequency:'A'|'M';classification:ComtradeClassification;
 access_mode:ComtradeMode;
}
export interface ComtradeDataParams extends ComtradeSelection {
 partner_code:number;product_codes:string[];flow_code:'M'|'X'|'RM'|'RX';
 fields:('primaryValue'|'netWgt'|'qty')[];max_records:number;
}
const fail=(message:string):never=>{throw new AccessError('COMTRADE','request_rejected',message);};
export function validateComtradeSelection(a:ComtradeSelection){
 if(!a||!Number.isInteger(a.reporter_code)||a.reporter_code<1||a.reporter_code>999)fail('Specify one numeric Comtrade reporter code from discovery.');
 if(!['A','M'].includes(a.frequency)||!COMTRADE_CLASSIFICATIONS.includes(a.classification)||!['preview','authenticated'].includes(a.access_mode))fail('Unsupported frequency, HS classification or access mode.');
 if(!Array.isArray(a.periods)||a.periods.length<1||a.periods.length>12||new Set(a.periods).size!==a.periods.length)fail('Specify 1-12 distinct periods.');
 for(const p of a.periods){
  if(typeof p!=='string'||!(a.frequency==='A'?/^\d{4}$/:/^\d{4}(0[1-9]|1[0-2])$/).test(p)||Number(p.slice(0,4))<1900||Number(p.slice(0,4))>new Date().getUTCFullYear())fail('Use valid YYYY annual or YYYYMM monthly periods, from 1900 through this year.');
 }
}
export function validateComtradeData(a:ComtradeDataParams){
 validateComtradeSelection(a);
 if(!Number.isInteger(a.partner_code)||a.partner_code<0||a.partner_code>999)fail('Specify one Comtrade partner code; 0 means World.');
 if(!['M','X','RM','RX'].includes(a.flow_code))fail('Choose imports M, exports X, re-imports RM or re-exports RX.');
 if(!Array.isArray(a.product_codes)||!a.product_codes.length||a.product_codes.length>10||new Set(a.product_codes).size!==a.product_codes.length||a.product_codes.some(c=>typeof c!=='string'||!/^(TOTAL|\d{2}|\d{4}|\d{6})$/.test(c)))fail('Specify 1-10 distinct exact HS codes (TOTAL or 2/4/6 digits). Wildcards and aggregation selectors are unsupported.');
 if(!Array.isArray(a.fields)||!a.fields.length||a.fields.length>3||new Set(a.fields).size!==a.fields.length||a.fields.some(f=>!['primaryValue','netWgt','qty'].includes(f)))fail('Choose distinct primaryValue, netWgt or qty fields.');
 if(!Number.isInteger(a.max_records)||a.max_records<1||a.max_records>500)fail('The local response cap is 1-500 records per period.');
}
function requireCredential(mode:ComtradeMode,key?:string){if(mode==='authenticated'&&!key)throw new AccessError('COMTRADE','missing_key','Set COMTRADE_API_KEY locally, or explicitly choose preview.');}
export function comtradeUrl(kind:'data'|'availability',a:ComtradeSelection,period:string){
 validateComtradeSelection(a);if(!a.periods.includes(period))fail('Unrequested period.');
 const endpoint=a.access_mode==='authenticated'?'data/v1': 'public/v1';
 const operation=kind==='availability'?'getDa':a.access_mode==='authenticated'?'get':'preview';
 const u=new URL(`${ROOT}/${endpoint}/${operation}/C/${a.frequency}/${a.classification}`);
 u.searchParams.set('reporterCode',String(a.reporter_code));u.searchParams.set('period',period);
 if(kind==='data'){
  const p=a as ComtradeDataParams;validateComtradeData(p);
  for(const [k,v] of Object.entries({partnerCode:p.partner_code,partner2Code:0,cmdCode:p.product_codes.join(','),flowCode:p.flow_code,customsCode:'C00',motCode:0,maxRecords:p.max_records,format:'JSON',includeDesc:true,breakdownMode:'classic'}))u.searchParams.set(k,String(v));
 }
 return u;
}
/** Never persist response envelopes, upstream request echoes, headers or error bodies. */
export async function requestComtrade(url:URL,key?:string){
 if(url.origin!==ROOT||!/^\/(?:files\/v1\/app\/reference\/[A-Za-z0-9]+\.json|(?:public|data)\/v1\/(?:preview|get|getDa)\/C\/[AM]\/(?:HS|H[0-6]))$/.test(url.pathname)||[...url.searchParams.keys()].some(k=>/key|token|secret/i.test(k)))fail('Unsupported Comtrade endpoint.');
 const auth=url.pathname.startsWith('/data/');requireCredential(auth?'authenticated':'preview',key);
 const response=await providerFetch(url,{headers:{Accept:'application/json',...(auth?{'Ocp-Apim-Subscription-Key':key!}:{})},redirect:'error'});
 const text=await response.text();if(text.length>12_000_000)throw new AccessError('COMTRADE','invalid_response','Response exceeded the local size limit. Narrow the query.');
 let body:any;try{body=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new AccessError('COMTRADE','invalid_response','Expected JSON; no response body was retained.');}
 if(!body||body.error||body.errorCode||(body.statusCode!==undefined&&body.statusCode!==200)||body.validation?.status==='Error')throw new AccessError('COMTRADE','invalid_response','Provider rejected the query or returned an error envelope.');
 return body;
}
const referenceFiles={reporters:'Reporters',partners:'partnerAreas',flows:'tradeRegimes',quantity_units:'QuantityUnits',customs:'CustomsCodes',transport:'ModeOfTransportCodes',classifications:'ListofReferences'} as const;
export type ComtradeReference=keyof typeof referenceFiles;
function page(rows:any[],query:string|undefined,offset:number,limit:number){
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||query!==undefined&&(typeof query!=='string'||query.length>200))fail('Invalid search or pagination.');
 const filtered=query?rows.filter(r=>JSON.stringify(r).toLowerCase().includes(query.toLowerCase())):rows;
 return {total:filtered.length,offset,limit,hasMore:offset+limit<filtered.length,results:filtered.slice(offset,offset+limit)};
}
const referenceKeys=['id','text','parent','isLeaf','aggrLevel','standardUnitAbbr','reporterCode','reporterDesc','reporterCodeIsoAlpha2','reporterCodeIsoAlpha3','PartnerCode','PartnerDesc','PartnerCodeIsoAlpha2','PartnerCodeIsoAlpha3','entryEffectiveDate','entryExpiredDate','isGroup','category','variable','description'];
function scalarFields(row:any,keys:string[]){if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid Comtrade record.');return Object.fromEntries(keys.filter(k=>row[k]!==undefined&&(['string','number','boolean'].includes(typeof row[k])||row[k]===null)).map(k=>[k,row[k]]));}
export async function comtradeReferences(cache:LayeredCache,reference:ComtradeReference,query?:string,offset=0,limit=50){
 if(!Object.hasOwn(referenceFiles,reference))fail('Unsupported reference category.');page([],query,offset,limit);
 const url=new URL(`${ROOT}/files/v1/app/reference/${referenceFiles[reference]}.json`);
 const entry=await cache.getOrCompute(`comtrade:reference:v1:${reference}`,86400,async()=>{
  const b=await requestComtrade(url);if(!Array.isArray(b.results))throw new Error('Missing Comtrade references.');
  return {retrievedAt:new Date().toISOString(),rows:b.results.map((r:any)=>scalarFields(r,referenceKeys))};
 });
 const rows=reference==='classifications'?entry.rows.filter((r:any)=>/^cmd:H[0-6S]$/.test(r.category??'')):entry.rows;
 return {source:'COMTRADE',url:String(url),retrievedAt:entry.retrievedAt,reference,...page(rows,query,offset,limit),notes:['Numeric Comtrade area codes are not ISO codes. Retain historical validity dates and group flags. Only merchandise HS classifications are supported by this adapter.']};
}
export async function comtradeProducts(cache:LayeredCache,classification:ComtradeClassification,query?:string,offset=0,limit=50){
 if(!COMTRADE_CLASSIFICATIONS.includes(classification))fail('Unsupported HS classification.');page([],query,offset,limit);
 const url=new URL(`${ROOT}/files/v1/app/reference/${classification}.json`);
 const entry=await cache.getOrCompute(`comtrade:products:v1:${classification}`,86400,async()=>{
  const b=await requestComtrade(url);if(!Array.isArray(b.results)||b.classCode&&b.classCode!==classification)throw new Error('Unexpected product classification.');
  return {retrievedAt:new Date().toISOString(),rows:b.results.map((r:any)=>scalarFields(r,referenceKeys))};
 });
 return {source:'COMTRADE',url:String(url),retrievedAt:entry.retrievedAt,classification,...page(entry.rows,query,offset,limit),notes:['Codes describe products, not data availability. HS combines editions; pin H0-H6 for a consistent edition. Do not sum parent and child codes or assume editions are interchangeable.']};
}
const availabilityKeys=['typeCode','freqCode','period','reporterCode','reporterDesc','reporterISO','classificationCode','classificationSearchCode','isOriginalClassification','isExtendedFlowCode','isPartner2Detail','isCustomsCodeDetail','isMotCodeDetail','publicationDate','lastUpdate','lastUpdated','totalRecords','datasetCode'];
export async function comtradeAvailability(cache:LayeredCache,a:ComtradeSelection,key?:string,fresh=false){
 validateComtradeSelection(a);requireCredential(a.access_mode,key);
 return cache.getOrCompute(`comtrade:availability:v1:${stable(a)}`,3600,async()=>{
  const partitions=[];
  for(const period of a.periods){
   const url=comtradeUrl('availability',a,period),b=await requestComtrade(url,key);
   if(!Array.isArray(b.data)||b.data.length>500)throw new Error('Unexpected availability response.');
   for(const row of b.data)if(String(row.reporterCode)!==String(a.reporter_code)||String(row.period)!==period||row.freqCode!==a.frequency||row.typeCode!=='C')throw new Error('Unexpected availability selection.');
   partitions.push({period,url:String(url),records:b.data.map((row:any)=>scalarFields(row,availabilityKeys))});
  }
  return {source:'COMTRADE',retrievedAt:new Date().toISOString(),query:a,partitions,notes:['Availability is reporter/period metadata; it does not prove product/partner coverage. Empty records mean no matching availability was returned, not zero trade. No official vintage archive is reconstructed.']};
 },fresh);
}
const recordDimensions=['typeCode','freqCode','reporterCode','partnerCode','partner2Code','classificationCode','cmdCode','flowCode','customsCode','motCode'] as const;
const flagKeys=['isReported','isAggregate','isOriginalClassification','isQtyEstimated','isAltQtyEstimated','isNetWgtEstimated','isGrossWgtEstimated','legacyEstimationFlag','isLeaf','aggrLevel','qtyUnitCode','qtyUnitAbbr','altQtyUnitCode','altQtyUnitAbbr','publicationDate'];
export function parseComtradeData(b:any,a:ComtradeDataParams,url:URL,retrievedAt:string){
 validateComtradeData(a);
 const period=url.searchParams.get('period');if(!a.periods.includes(period??'')||!Array.isArray(b?.data)||b.data.length>a.max_records||b.error||(b.count!==undefined&&(!Number.isInteger(b.count)||b.count<0)))throw new Error('Invalid Comtrade data envelope.');
 const groups=new Map<string,DataSeries>();
 for(const row of b.data){
  if(!row||recordDimensions.some(k=>row[k]===undefined||row[k]===null)||row.typeCode!=='C'||row.freqCode!==a.frequency||String(row.reporterCode)!==String(a.reporter_code)||String(row.partnerCode)!==String(a.partner_code)||String(row.partner2Code)!=='0'||String(row.period)!==period||!a.product_codes.includes(String(row.cmdCode))||row.flowCode!==a.flow_code||row.customsCode!=='C00'||String(row.motCode)!=='0'||!/^H[0-6]$/.test(row.classificationCode)||(a.classification!=='HS'&&row.classificationCode!==a.classification))throw new Error('Comtrade returned an unrequested series or missing identity metadata.');
  for(const field of a.fields){
   // Distinct quantity units must never be combined in a time series.
   const dimensions={...attributes(row,[...recordDimensions]),field,...(field==='qty'?{qtyUnitCode:String(row.qtyUnitCode??'not_reported')}: {})};
   const id=stable(dimensions),unit=field==='primaryValue'?'USD':field==='netWgt'?'kg':row.qtyUnitAbbr&&row.qtyUnitAbbr!=='N/A'?String(row.qtyUnitAbbr):null;
   if(!groups.has(id))groups.set(id,dataSeries(`C/${a.frequency}/${row.classificationCode}`,dimensions,url,{frequency:a.frequency,unit,unitMultiplier:field==='qty'&&!unit?null:0,adjustment:'not_seasonally_adjusted',notes:['Reported merchandise trade. Imports and exports can use different valuation bases; no mirror substitution, aggregation, currency conversion or unit-value calculation was applied.']}));
   const s=groups.get(id)!;if(s.unit!==unit)throw new Error('Quantity unit changed within a series.');
   s.labels={...s.labels,...attributes(row,['reporterDesc','partnerDesc','cmdDesc','flowDesc','customsDesc','motDesc'])};
   s.observations.push(observation(a.frequency==='M'?`${period!.slice(0,4)}-${period!.slice(4)}`:period!,row[field],attributes(row,flagKeys)));
  }
 }
 const truncated=a.access_mode==='preview'||b.data.length>=a.max_records||(typeof b.count==='number'&&b.count>b.data.length);
 const result=finishResult('COMTRADE',a as unknown as Record<string,unknown>,[...groups.values()],retrievedAt,12,[`Access mode: ${a.access_mode}. ${a.access_mode==='preview'?'Public preview; completeness is unverified even below the record cap.':'Bounded exact query; no claim of complete national trade coverage.'}`,'Absent records are missing coverage, never zero trade. Returned estimation and reporting flags remain attached to observations.','HS editions are separate series. Changes across editions are not treated as statistical revisions.'],null,truncated);
 if(typeof b.count==='number')result.coverage.upstreamTotalRows=b.count;
 return result;
}
export async function fetchComtradeData(a:ComtradeDataParams,key?:string){
 validateComtradeData(a);requireCredential(a.access_mode,key);
 const combined=new Map<string,DataSeries>(),partitions=[];let truncated=a.access_mode==='preview';
 for(const period of a.periods){
  const url=comtradeUrl('data',a,period),body=await requestComtrade(url,key),r=parseComtradeData(body,a,url,new Date().toISOString());
  truncated ||=r.coverage.truncated;
  partitions.push({period,returnedRows:body.data.length,recordCap:a.max_records,possiblyTruncated:r.coverage.truncated});
  for(const s of r.series){const old=combined.get(s.id);if(old){if(old.unit!==s.unit||old.unitMultiplier!==s.unitMultiplier)throw new Error('Conflicting Comtrade units across periods.');old.observations.push(...s.observations);old.urls.push(...s.urls);}else combined.set(s.id,s);}
 }
 const result=finishResult('COMTRADE',a as unknown as Record<string,unknown>,[...combined.values()],new Date().toISOString(),12,[`Access mode: ${a.access_mode}. Preview completeness is always unverified; capped responses are partial.`,`Requested period coverage: ${JSON.stringify(partitions)}`,'Missing product/period combinations are not zeroes. No retry, pagination, aggregation or mirror substitution is performed.','Only final merchandise data in classic mode are supported. Source publication time is not inferred from retrieval time.'],null,truncated);
 return result;
}
