import iso from 'i18n-iso-countries';

/** Catalogue relevance only. Matching a title never verifies a series definition. */
const concepts: string[][] = [
  ['gdp', 'gross domestic product', 'national accounts'],
  ['inflation', 'consumer price', 'cpi', 'hicp', 'cpih'],
  ['unemployment', 'unemployed', 'joblessness'],
  ['employment', 'labour', 'labor', 'workforce', 'jobs'],
  ['housing', 'house price', 'property price', 'residential property'],
  ['forex', 'exchange rate', 'currency'],
  ['policy rate', 'central bank policy', 'interest rate'],
  ['tiva', 'trade in value added', 'value added', 'embodied'],
  ['trade', 'exports', 'imports', 'merchandise'],
  ['fertiliser', 'fertilizer', 'fertilisers', 'fertilizers'],
  ['agriculture', 'agricultural', 'crops', 'livestock'],
  ['oil', 'petroleum'],
  ['electricity', 'electric power'],
  ['natural gas', 'henry hub'],
  ['shipping', 'maritime', 'chokepoint', 'port traffic'],
];
const normalise = (s:string) => s.toLowerCase().replace(/[_\W]+/g, ' ').trim();
const contains = (text:string, phrase:string) => (` ${text} `).includes(` ${normalise(phrase)} `);
const stop = new Set('the a an of in on for and or to from by with show compare comparison data series dataset latest recent historical how much has changed between since through total'.split(' '));
const modifiers = new Set('real nominal growth level levels rate rates index indices adjusted seasonal seasonally calendar annual annualised annualized annually quarterly quarter monthly month daily weekly qoq yoy mom sa nsa saar percent percentage change changes per capita ppp'.split(' '));
// Geography belongs in series dimensions; many catalogues have multinational titles.
const countryWords = new Set(Object.values(iso.getNames('en')).flatMap(n=>normalise(n).split(' ')));
for(const c of ['australian','american','chinese','french','british','russian','us','usa','uk','gb','gbr','au','aus','cn','chn','fr','fra','ru','rus']) countryWords.add(c);

export interface CatalogueEntry {id:string;name:string;description?:string;coverageEnd?:string}

export function rankCatalogue<T>(items:T[], query:string, entry:(item:T)=>CatalogueEntry):T[] {
  const q=normalise(query);
  if(!q)return items;
  const exactIds=items.filter(item=>{const id=entry(item).id;return normalise(id)===q||normalise(id.split(/[,:]/).at(-1)!)===q;});
  if(exactIds.length)return exactIds;
  const active=concepts.filter(group=>group.some(term=>contains(q,term)));
  const conceptWords=new Set(active.flat().flatMap(term=>normalise(term).split(' ')));
  const tokens=[...new Set(q.split(' '))];
  const important=tokens.filter(t=>!stop.has(t)&&!modifiers.has(t)&&!countryWords.has(t)&&!conceptWords.has(t)&&!/^\d{4}$/.test(t));
  const scored=items.map((item,index)=>{
    const e=entry(item),id=normalise(e.id),name=normalise(e.name),text=normalise(`${e.id} ${e.name} ${e.description??''}`);
    const exact=id===q||name===q;
    const matchedConcepts=active.filter(group=>group.some(term=>contains(text,term))).length;
    const matchedWords=important.filter(t=>contains(text,t)||contains(text,t.replace(/s$/,''))).length;
    // Require a topic match, or a meaningful literal match for unknown concepts.
    if(!exact&&(active.length?matchedConcepts===0:important.length?matchedWords<important.length:!tokens.some(t=>contains(text,t))))return null;
    let score=exact?1000:0;
    score+=matchedConcepts*40+matchedWords*12;
    score+=tokens.reduce((n,t)=>n+(contains(name,t)?5:contains(text,t)?1:0),0);
    if(active.length)score-=Math.max(0,active.length-matchedConcepts)*20;
    // A national macro query should not be led by regional or distribution tables.
    if(active.includes(concepts[0])){
      if(/\b(regions?|regional|subnational)\b/.test(name)&&!/\b(regions?|regional|subnational)\b/.test(q))score-=35;
      if(/\b(consumption|household|distribution|quintile)\b/.test(name)&&!/\b(consumption|household|distribution|quintile)\b/.test(q))score-=25;
      if(/\b(contribution|contributions)\b/.test(name)&&!/\b(contribution|contributions)\b/.test(q))score-=15;
      if(contains(name,'gross domestic product'))score+=20;
      if(/\b(quarterly|qoq|quarter)\b/.test(q)&&contains(name,'quarterly'))score+=12;
    }
    if(/\b(vintage|discontinued|archive)\b/.test(text)&&!/\b(vintage|discontinued|archive)\b/.test(q))score-=10;
    return {item,score,index,id:e.id,coverageEnd:e.coverageEnd??''};
  }).filter((x):x is NonNullable<typeof x>=>x!==null);
  return scored.sort((a,b)=>b.score-a.score||b.coverageEnd.localeCompare(a.coverageEnd)||a.id.localeCompare(b.id)||a.index-b.index).map(x=>x.item);
}
