import {expect,test} from 'bun:test';
import {rankCatalogue} from '../src/core/catalogue-search';
import {formatOecdCatalogue} from '../src/core/oecd';
const catalogue=[
 {id:'REG_GDP',name:'Gross domestic product - Regions'},
 {id:'CONS',name:'Household consumption in the National Accounts: income quintiles'},
 {id:'QNA',name:'Quarterly national accounts: Gross domestic product'},
 {id:'ANA',name:'Annual national accounts'},
 {id:'CPI',name:'Consumer price indices'},
 {id:'EDUCATION',name:'Education expenditure'},
 {id:'PENSIONS',name:'Pension expenditure'},
];
test('economic concept outranks geography, frequency and transformation words',()=>{
 const matches=rankCatalogue(catalogue,'real GDP growth qoq Australia US France 2020 2025',x=>x);
 expect(matches[0].id).toBe('QNA');expect(matches.some(x=>x.id==='CPI')).toBe(false);
 expect(rankCatalogue(catalogue,'regional GDP',x=>x)[0].id).toBe('REG_GDP');
});
test('synonyms find candidates without asserting a statistical definition',()=>{
 expect(rankCatalogue(catalogue,'monthly inflation in Australia',x=>x).map(x=>x.id)).toEqual(['CPI']);
 expect(rankCatalogue(catalogue,'unemployment',x=>x)).toEqual([]);
 expect(rankCatalogue(catalogue,'education expenditure',x=>x).map(x=>x.id)).toEqual(['EDUCATION']);
});
test('an exact dataset identifier is not broadened to related datasets',()=>{
 const rows=[{id:'prc_hicp_minr',name:'HICP current'},{id:'prc_hicp_manr',name:'HICP old'}];
 expect(rankCatalogue(rows,'prc_hicp_minr',x=>x)).toEqual([rows[0]]);
 const imf=[{id:'IMF.STA:CPI',name:'Consumer prices'},{id:'IMF.STA:CPI_WEIGHTS',name:'Consumer price weights'}];
 expect(rankCatalogue(imf,'CPI',x=>x)).toEqual([imf[0]]);
});
test('OECD fallback query finds GDP and pagination follows relevance consistently',()=>{
 const rows=catalogue.map(c=>({...c,agency:'OECD.SDD.NAD',version:'1.0'}));
 const first=formatOecdCatalogue(rows,'real gdp growth qoq',0,1);
 expect(first).toContain('QNA');expect(first).toContain('4 matches');
 expect(formatOecdCatalogue(rows,'real gdp growth qoq',1,1)).not.toContain(',QNA ');
});
test('equally relevant Eurostat entries prefer current coverage',()=>{
 const rows=[{id:'a',name:'HICP',coverageEnd:'2024-12'},{id:'b',name:'HICP',coverageEnd:'2026-09'}];
 expect(rankCatalogue(rows,'inflation',x=>x)[0].id).toBe('b');
});

test('headline GDP growth outranks contribution tables unless contributions are requested',()=>{
 const rows=[{id:'A',name:'Quarterly GDP and components - real growth rates and contributions to real growth'},{id:'B',name:'Quarterly real GDP growth - OECD countries'}];
 expect(rankCatalogue(rows,'real GDP growth qoq',x=>x)[0].id).toBe('B');
 expect(rankCatalogue(rows,'GDP contributions to growth',x=>x)[0].id).toBe('A');
});
