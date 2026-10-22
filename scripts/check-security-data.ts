// Explicit live smoke test; not part of the offline regression suite.
import {EconStatsCoreClient} from '../src/core/client';
const client=new EconStatsCoreClient({});
for(const dataset of ['ports','chokepoints'] as const){
  const locations=await client.portwatchListLocations(dataset,dataset==='ports'?'Melbourne':'Suez');
  if(!locations.locations.length)throw new Error('PortWatch search returned no location.');
  const id=locations.locations[0].portid;
  const result=await client.getStructuredData({tool:'portwatch_get_data',arguments:{dataset,location_ids:[id],fields:dataset==='ports'?['portcalls','import']:['n_total','capacity'],start_date:'2024-01-01',end_date:'2024-01-07',limit:50}},true);
  if(result.coverage.returnedObservations!==14||result.coverage.truncated)throw new Error('Unexpected PortWatch smoke coverage.');
  console.log(JSON.stringify({source:result.source,dataset,location:id,coverage:result.coverage,sample:result.series.map(s=>({field:s.dimensions.field,unit:s.unit,first:s.observations[0]}))}));
}
for(const domain of ['QCL','FBS','RFN','RFB'] as const){
  const elementLabel=domain==='RFN'?'Agricultural Use':domain==='RFB'?'Import quantity':'Production';
  const areas=await client.faostatListCodes(domain,'area','Australia'),items=await client.faostatListCodes(domain,'item',domain==='RFN'?'nitrogen':domain==='RFB'?'urea':'wheat'),elements=await client.faostatListCodes(domain,'element',elementLabel);
  if(!areas.codes.length||!items.codes.length||!elements.codes.length)throw new Error(`Missing FAOSTAT ${domain} codes.`);
  const element=elements.codes.find(e=>e.label===elementLabel);if(!element)throw new Error('Exact smoke-test element missing.');
  const result=await client.getStructuredData({tool:'faostat_get_data',arguments:{domain,area_codes:[areas.codes[0].code],item_codes:[items.codes[0].code],element_codes:[element.code],start_year:2020,end_year:2024,limit:20}},true);
  if(!result.coverage.returnedObservations||result.coverage.truncated)throw new Error(`Unexpected FAOSTAT ${domain} coverage.`);
  console.log(JSON.stringify({source:result.source,domain,coverage:result.coverage,series:result.series.map(s=>({labels:s.labels,unit:s.unit,last:s.observations.at(-1)}))}));
}
console.log(await client.connectionHealth(['PORTWATCH','FAOSTAT'],true));
