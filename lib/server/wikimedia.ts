import {titleMatches} from './grounding';
import {AppError} from './config';
import type {Budget} from './tmdb';
import type {Film,Language} from '../domain';
import knownMetadata from '../film-metadata.json';
const UA='STRADA/1.1 (https://closeup-film-trails.sangw077.chatgpt.site; film discovery)';
const cache=new Map<string,{at:number,value:any}>();
const FILM_TYPES=new Set(['Q11424','Q24862','Q24869','Q202866','Q506240','Q20667187','Q29168811','Q226730','Q17517379','Q93204']);
export async function wikiApi(host:'www.wikidata.org'|'en.wikipedia.org'|'ko.wikipedia.org',params:Record<string,string>,budget?:Budget):Promise<any>{
 const url=`https://${host}/w/api.php?${new URLSearchParams({format:'json',formatversion:'2',origin:'*',...params})}`;const hit=cache.get(url);if(hit&&Date.now()-hit.at<3_600_000)return hit.value;
 if(budget&&budget.remaining--<=0)throw new AppError('BUDGET','The movie service reached its request limit. Please try again.',429);
 const response=await fetch(url,{headers:{'User-Agent':UA,Accept:'application/json'},signal:budget?.signal?AbortSignal.any([budget.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel();throw new AppError(response.status===429?'RATE_LIMIT':'METADATA_ERROR','Movie search is temporarily unavailable.',response.status===429?429:502);}
 const data:any=await response.json();if(data.error)throw new AppError('METADATA_ERROR','The movie database could not complete this search.',502);if(cache.size>=64)cache.delete(cache.keys().next().value!);cache.set(url,{at:Date.now(),value:data});return data;
}
const values=(e:any,p:string)=>(e.claims?.[p]??[]).filter((s:any)=>s.rank!=='deprecated').map((s:any)=>s.mainsnak?.datavalue?.value).filter(Boolean);
const qids=(e:any,p:string)=>values(e,p).map((v:any)=>v.id).filter(Boolean) as string[];
const norm=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[\p{P}\p{M}\s]/gu,'');
export const knownByQid=(id:string)=>knownMetadata.find(f=>f.qid===id);
export function isMovieEntity(e:any){return qids(e,'P31').some(q=>FILM_TYPES.has(q))&&values(e,'P577').length>0;}
async function entities(ids:string[],budget?:Budget){if(!ids.length)return {};return (await wikiApi('www.wikidata.org',{action:'wbgetentities',ids:[...new Set(ids)].join('|'),props:'labels|aliases|descriptions|claims|sitelinks',languages:'en|mul|ko',sitefilter:'enwiki|kowiki'},budget)).entities??{};}
function mapEntity(e:any,related:Record<string,any>):Film|null{
 if(!isMovieEntity(e))return null;const known=knownByQid(e.id);const dates=values(e,'P577').map((d:any)=>Number(d.time?.slice(1,5))).filter((n:number)=>n>1850&&n<2200);if(!dates.length)return null;
 const label=(q:string)=>related[q]?.labels?.en?.value??related[q]?.labels?.mul?.value??known?.director??'';const director=qids(e,'P57').map(label).filter(Boolean).join(', ');const countries=qids(e,'P495').map(q=>related[q]?.labels?.en?.value).filter(Boolean).join(' / ');
 const ko=e.labels?.ko?.value;return {id:`wd:${e.id}`,wikidataId:e.id,title:e.labels?.en?.value??e.labels?.mul?.value??values(e,'P1476')[0]?.text??ko??e.id,titleKo:ko,titleKoSource:ko?`https://www.wikidata.org/wiki/${e.id}`:undefined,aliases:[...(e.aliases?.en??[]),...(e.aliases?.mul??[])].map((a:any)=>a.value),year:Math.min(...dates),director,poster:known?.poster??'',country:countries||undefined,genres:qids(e,'P136'),originalTitle:values(e,'P1476')[0]?.text,wikiEn:e.sitelinks?.enwiki?.title,wikiKo:e.sitelinks?.kowiki?.title,overviewEn:known?.overviewEn,overviewKo:known?.overviewKo,overviewEnSource:known?.overviewEnSource,overviewKoSource:known?.overviewKoSource};
}
async function mapEntities(es:Record<string,any>,budget?:Budget,posters=false){
 const rows=Object.values(es).filter(isMovieEntity);const relatedIds=rows.flatMap(e=>[...qids(e,'P57'),...qids(e,'P495')]);
 const [relatedResult,illustrated]=await Promise.all([
  relatedIds.length?wikiApi('www.wikidata.org',{action:'wbgetentities',ids:[...new Set(relatedIds)].join('|'),props:'labels',languages:'en|mul|ko'},budget):Promise.resolve({entities:{}}),
  posters?enrichPosterBatch(rows.map(e=>mapEntity(e,{})).filter((f):f is Film=>!!f),budget).catch(()=>[]):Promise.resolve([] as Film[])
 ]);
 return rows.map(e=>{const f=mapEntity(e,relatedResult.entities??{});return f?{...f,poster:illustrated.find(p=>p.id===f.id)?.poster||f.poster}:null;}).filter((f):f is Film=>!!f);
}
export async function filmsFromQids(ids:string[],budget?:Budget){return mapEntities(await entities(ids,budget),budget);}
export async function searchWikimedia(query:string,language:Language,budget?:Budget):Promise<Film[]>{
 const data=await wikiApi('www.wikidata.org',{action:'wbsearchentities',search:query,language,uselang:language,limit:'16',type:'item'},budget);const ids=(data.search??[]).map((x:any)=>x.id).filter((id:string)=>/^Q\d+$/.test(id));if(!ids.length)return [];const mapped=await mapEntities(await entities(ids,budget),budget,true);const index=new Map(ids.map((id:string,i:number)=>[id,i]));return mapped.sort((a,b)=>(index.get(a.wikidataId!) as number)-(index.get(b.wikidataId!) as number)).slice(0,8);
}
export async function getWikimediaFilm(id:string,budget?:Budget):Promise<Film>{
 const qid=id.replace(/^wd:/,'');if(!/^Q[1-9]\d*$/.test(qid))throw new AppError('INVALID_FILM','This film could not be identified.',400);const known=knownByQid(qid);if(known){return {...known,id:`wd:${qid}`,wikidataId:qid,titleKo:known.titleKo||undefined} as Film;}
 const films=await mapEntities(await entities([qid],budget),budget);if(!films[0])throw new AppError('INVALID_FILM','This database entry is not a film.',400);return films[0];
}
function cleanText(text:string){return text.replace(/\[[0-9]+\]/g,'').replace(/\s+/g,' ').trim();}
export function plotExcerpt(extract:string){const m=extract.match(/(?:^|\n)==\s*(?:Plot(?: summary)?|Synopsis|줄거리|내용)\s*==\s*\n([\s\S]*?)(?=\n==|$)/i);if(!m)return '';const paragraphs=m[1].split(/\n\s*\n/).map(cleanText).filter(p=>p&&!p.startsWith('='));const first=paragraphs[0]??'';if(first.length<=1000)return first;const sentence=first.slice(0,1000).match(/^[\s\S]*[.!?。다][.!?。]?\s/);return (sentence?.[0]??first.slice(0,1000)).trim()+'…';}
export async function enrichWikipedia(film:Film,language:Language,budget?:Budget):Promise<Film>{
 const hasSynopsis=language==='ko'?film.synopsisKo:film.synopsisEn;if(hasSynopsis)return film;let lang:Language=language;let title=language==='ko'?film.wikiKo:film.wikiEn;if(!title){lang='en';title=film.wikiEn;}if(!title)return film;
 const decoded=decodeURIComponent(title);const data=await wikiApi(`${lang}.wikipedia.org`,{action:'query',titles:decoded,redirects:'1',prop:'pageprops|pageimages|extracts',ppprop:'wikibase_item',piprop:'thumbnail|name',pithumbsize:'400',pilicense:'any',explaintext:'1',exsectionformat:'wiki'},budget);
 const page=data.query?.pages?.[0];if(!page||page.missing||page.pageprops?.wikibase_item!==film.wikidataId)return film;
 const url=`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ','_'))}`;const extract=page.extract??'';const synopsis=plotExcerpt(extract);const intro=cleanText(extract.split(/\n==/)[0]).slice(0,1000);const imageName=(page.pageimage??'').toLowerCase();const representative=page.thumbnail?.source;
 // The lead image is not necessarily a poster. Avoid known logos/portraits and keep the existing title placeholder otherwise.
 const poster=film.poster||(!/logo|portrait|director|signature/.test(imageName)?representative:'')||'';
 return {...film,poster,...(lang==='ko'?{overviewKo:intro,overviewKoSource:url,synopsisKo:synopsis||undefined,synopsisKoSource:synopsis?url:undefined}:{overviewEn:intro,overviewEnSource:url,synopsisEn:synopsis||undefined,synopsisEnSource:synopsis?url:undefined})};
}
export async function resolveWikimediaCandidate(title:string,year:number,director:string,budget:Budget):Promise<Film|null>{
 if(!norm(director))return null;const known=knownMetadata.find(f=>titleMatches(f.title,title)&&Math.abs(f.year-year)<=1&&norm(f.director)===norm(director));if(known)return getWikimediaFilm(known.id,budget);
 const hits=await searchWikimedia(title,'en',budget);const exact=hits.filter(f=>[f.title,...f.aliases??[],f.wikiEn?.replace(/\s*\([^)]*film[^)]*\)$/i,'')??''].some(alias=>norm(alias)===norm(title))&&Math.abs(f.year-year)<=1&&(norm(f.director)===norm(director)||f.director.split(',').some(d=>norm(d)===norm(director))));return exact.length===1?exact[0]:null;
}

export async function getWikimediaFilms(ids:string[],budget?:Budget):Promise<Film[]>{const unique=[...new Set(ids)];const missing=unique.filter(id=>!knownByQid(id.replace(/^wd:/,'')));const fetched=missing.length?await mapEntities(await entities(missing.map(id=>id.replace(/^wd:/,'')),budget),budget):[];const out:Film[]=[];for(const id of ids){const known=knownByQid(id.replace(/^wd:/,''));const f=known?await getWikimediaFilm(id,budget):fetched.find(f=>f.id===id);if(!f)throw new AppError('INVALID_FILM','This film could not be identified.',400);out.push(f);}return out;}
export async function enrichPosterBatch(films:Film[],budget?:Budget):Promise<Film[]>{const missing=films.filter(f=>!f.poster&&f.wikiEn&&f.wikidataId);if(!missing.length)return films;const data=await wikiApi('en.wikipedia.org',{action:'query',titles:missing.map(f=>decodeURIComponent(f.wikiEn!)).join('|'),redirects:'1',prop:'pageprops|pageimages',ppprop:'wikibase_item',piprop:'thumbnail|name',pithumbsize:'500',pilicense:'any'},budget);return films.map(f=>{const p=data.query?.pages?.find((p:any)=>p.pageprops?.wikibase_item===f.wikidataId);if(!p)return f;return {...f,poster:f.poster||(!/logo|portrait|signature/i.test(p.pageimage??'')?p.thumbnail?.source:'')||'',overviewEn:f.overviewEn||p.extract,overviewEnSource:f.overviewEnSource||`https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(' ','_'))}`};});}
