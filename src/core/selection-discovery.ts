import iso from 'i18n-iso-countries';
import type {Candidate,SelectionParams,Source,Retrieval} from './selection';

export const DISCOVERY_MEASURES = [
  'merchandise_exports_value','merchandise_imports_value','merchandise_exports_net_weight','merchandise_imports_net_weight',
  'foreign_value_added_in_final_demand','domestic_value_added_in_exports',
  'agricultural_production','food_supply','fertiliser_nutrient_use','fertiliser_product_use',
  'port_import_volume','port_export_volume','chokepoint_capacity','vessel_transits',
] as const;

/** Plans contain only callable discovery steps; unknown native identifiers are never invented. */
export function discoveryCandidates(p:SelectionParams&{frequency:string},configured:Partial<Record<Source,boolean>>,macroFallback=false):Candidate[]{
  const candidates:Candidate[]=[];
  const add=(source:Source,score:number,definition:string,steps:Retrieval[],requirements:string[],notes:string[]=[])=>{
    candidates.push({source,score,definition,reason:`${source} has a relevant discovery route; exact dimensions and observation coverage still require validation.`,notes,requests:[],discovery:steps,requirements,frequency:p.frequency,ready:source!=='COMTRADE'||!!configured.COMTRADE});
  };
  const countryName=(c:string)=>c==='WLD'?'World':iso.getName(c,'en')??c;
  const step=(tool:string,args:Record<string,unknown>={}):Retrieval=>({tool,arguments:args});
  const dates=['Use the requested start/end periods; require explicit dates before retrieval.'];
  if(p.measure.startsWith('merchandise_')&&['annual','monthly'].includes(p.frequency)){
    const steps=p.countries.map(c=>step('comtrade_list_reference',{reference:'reporters',query:c}));
    for(const c of p.partnerCountries??[])steps.push(step('comtrade_list_reference',{reference:'partners',query:c==='WLD'?'World':c}));
    if(!p.partnerCountries?.length)steps.push(step('comtrade_list_reference',{reference:'partners',query:'World'}));
    if(p.productCodes?.length){for(const code of p.productCodes)steps.push(step('comtrade_search_products',{query:code,...(p.classification?{classification:p.classification}:{})}));}
    else steps.push(step('comtrade_search_products',{...(p.productQuery?{query:p.productQuery}:{}),...(p.classification?{classification:p.classification}:{})}));
    add('COMTRADE',120,`${p.measure.includes('_imports_')?'Imports':'Exports'} of merchandise, ${p.measure.endsWith('_value')?'reported USD value':'reported net weight in kg'}.`,steps,
      [...dates,'Resolve native reporter and partner codes; do not substitute mirror trade.',
       'Confirm HS edition and non-overlapping product codes; do not assume a product or world total.',
       `Use flow_code=${p.measure.includes('_imports_')?'M':'X'} and fields=[${p.measure.endsWith('_value')?'primaryValue':'netWgt'}]. Preserve re-export and estimation flags.`,
       'Check comtrade_get_availability, then comtrade_get_data with authenticated access; batch at most 12 periods and inspect truncation.'],
      ['Authenticated completeness requires COMTRADE_API_KEY. Public preview cannot verify completeness.']);
  }
  if(['foreign_value_added_in_final_demand','domestic_value_added_in_exports'].includes(p.measure)&&p.frequency==='annual'){
    add('OECD',120,p.measure==='foreign_value_added_in_final_demand'?'Foreign-origin value added embodied in final demand, by origin and destination.':'Domestic value added embodied in gross exports.',
      [step('oecd_list_datasets',{query:'TiVA',space:'sti-public'})],
      [...dates,'Inspect oecd_get_structure for the discovered dataset and version in sti-public.',
       `Resolve origin, destination, industry, measure and unit dimensions. countries means ${p.measure==='foreign_value_added_in_final_demand'?'final-demand destination; partnerCountries means value-added origin':'exporter; partnerCountries means destination'}. Preserve this direction.`,
       'Choose a level or share explicitly and verify release coverage; do not substitute gross bilateral trade.',
       'Use oecd_get_data with exact keys and both start_period and end_period.'],
      ['Industry and partner filters are requirements for subsequent structure discovery, not assumed native codes.']);
  }
  const domains:Record<string,{id:string;element:string}>={agricultural_production:{id:'QCL',element:'Production'},food_supply:{id:'FBS',element:'Food supply'},fertiliser_nutrient_use:{id:'RFN',element:'Agricultural Use'},fertiliser_product_use:{id:'RFB',element:'Agricultural Use'}};
  const domain=domains[p.measure];
  if(domain&&p.frequency==='annual'){
    add('FAOSTAT',120,`${p.measure.replaceAll('_',' ')} from official installed annual FAOSTAT snapshots.`,
      [step('faostat_list_domains'),...p.countries.map(c=>step('faostat_list_codes',{domain:domain.id,dimension:'area',query:countryName(c)})),
       step('faostat_list_codes',{domain:domain.id,dimension:'item',...(p.productQuery?{query:p.productQuery}:{})}),
       step('faostat_list_codes',{domain:domain.id,dimension:'element',query:domain.element})],
      [...dates,'Verify installed snapshot date and actual country/year coverage.',
       'Resolve exact native area/item/element codes and units before faostat_get_data.',
       'Distinguish nutrient tonnes, product tonnes, production, food availability and inventories.'],
      ['Snapshot data is not live release-day data; fresh=true does not rebuild it.']);
  }
  if(['port_import_volume','port_export_volume','chokepoint_capacity','vessel_transits'].includes(p.measure)&&p.frequency==='daily'){
    const dataset=p.measure==='chokepoint_capacity'?'chokepoints':p.locationType??'ports';
    add('PORTWATCH',120,`${p.measure.replaceAll('_',' ')} from daily AIS-derived estimates.`,
      [step('portwatch_get_metadata',{dataset}),...(dataset==='ports'&&p.countries.length?p.countries:[undefined]).map(c=>step('portwatch_list_locations',{dataset,...(c?{country_iso3:c}:{}),...(p.locationQuery?{query:p.locationQuery}:{})}))],
      [...dates,'Resolve native location IDs and exact fields from metadata before portwatch_get_data.',
       'Split requests into at most 367 days, 5 locations and 5 fields; inspect incomplete results.',
       'Chokepoint deadweight capacity is not actual cargo tonnage. Do not sum totals with overlapping vessel components.']);
  }
  if(macroFallback){
    const query=/gdp/.test(p.measure)?'GDP':/unemployment/.test(p.measure)?'unemployment':/cpi|hicp/.test(p.measure)?'consumer prices':p.measure.replaceAll('_',' ');
    add('OECD',110,p.measure.replaceAll('_',' '),[step('oecd_list_datasets',{query})],
      ['Inspect structure for exact country, frequency, real/nominal, adjustment, unit and transformation codes.',...dates,'Validate numeric observations before recommending a dataset.']);
    if(/gdp|unemployment|cpi|hicp/.test(p.measure))add('IMF',100,p.measure.replaceAll('_',' '),[step('imf_list_datasets',{query})],
      ['Inspect current dataset structure; do not guess legacy IMF codes.',...dates,'Verify the exact definition and country coverage.']);
  }
  return candidates;
}
