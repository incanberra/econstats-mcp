export const FAOSTAT_DOMAINS={
  QCL:{name:'Crops and livestock products',file:'Production_Crops_Livestock_E_All_Data_(Normalized).zip'},
  FBS:{name:'Food Balances (2010-)',file:'FoodBalanceSheets_E_All_Data_(Normalized).zip'},
  RFN:{name:'Fertilizers by Nutrient',file:'Inputs_FertilizersNutrient_E_All_Data_(Normalized).zip'},
  RFB:{name:'Fertilizers by Product',file:'Inputs_FertilizersProduct_E_All_Data_(Normalized).zip'},
} as const;
export type FaostatDomain=keyof typeof FAOSTAT_DOMAINS;
export const FAOSTAT_CATALOG='https://bulks-faostat.fao.org/production/datasets_E.json';
export const FAOSTAT_START_YEAR=1990;
export const faostatSource=(domain:FaostatDomain)=>'https://bulks-faostat.fao.org/production/'+FAOSTAT_DOMAINS[domain].file;
