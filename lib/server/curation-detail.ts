import {curationSettings} from './curation-settings';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {type Film,type Language,type Recommendation,type Source} from '../domain';
import {CURATOR_DETAIL_PROMPT,DetailSchema,detailOutputSchema} from '../curation-contract';
import {AppError,config} from './config';
import {curatorResponse} from './curator-model';
import {localizeTitles} from '../i18n';
import type {ResearchUsage} from './source-search';
import knowledgeIndex from '../../research/knowledge/serving-index.json';
const activeDocumentVersions=new Map(knowledgeIndex.documents.map(document=>[document.id,document.versionId]));

const filmShape=z.object({id:z.string().max(100),title:z.string().max(240),titleKo:z.string().max(240).optional(),year:z.number(),director:z.string().max(240),overview:z.string().max(700).optional()});
const Packet=z.object({version:z.literal(2),issued:z.number(),film:filmShape,selected:z.array(filmShape).min(1).max(38),why:z.string().max(1400),lens:z.string().max(120),bridge:z.string().max(600),contrast:z.string().max(350),evidence:z.array(z.object({title:z.string().max(240),url:z.string().url(),excerpt:z.string().max(900),point:z.string().max(1200),boundary:z.string().max(900).optional(),locator:z.string().max(500).optional(),access:z.string().optional(),review:z.string().optional(),documentId:z.string().optional(),documentVersion:z.string().optional(),type:z.string().optional()})).max(2)});
function sign(body:string,version=2){const key=config().openai;if(!key)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);return createHmac('sha256',key).update(`strada-detail-v${version}:`+body).digest('base64url');}
const compact=(film:Film)=>({id:film.id,title:film.title,titleKo:film.titleKo,year:film.year,director:film.director});
export function issueDetailToken(rec:Recommendation,selected:Film[],sources:Source[]){
 const packet=Packet.parse({version:2,issued:Date.now(),film:{...compact(rec.film),overview:(rec.film.overviewEn||rec.film.synopsisEn||rec.film.overviewKo||rec.film.synopsisKo||'').slice(0,700)},selected:selected.map(compact),why:rec.connections[0].why.slice(0,1400),lens:(rec.curation?.lens??'').slice(0,120),bridge:(rec.curation?.bridge??'').slice(0,600),contrast:(rec.curation?.contrast??'').slice(0,350),evidence:sources.filter(s=>rec.sourceIds.includes(s.id)&&s.excerpt&&(s.type!=='academic'||s.accessLevel==='full_page'||s.accessLevel==='full_text')).slice(0,2).map(s=>({title:s.title.slice(0,240),url:s.url,excerpt:s.excerpt!.slice(0,900),point:(s.summaryKo||s.summary).slice(0,1200),boundary:s.boundary,locator:s.locator,access:s.accessLevel,review:s.reviewStatus,documentId:s.documentId,documentVersion:s.documentVersion,type:s.type}))});
 const body=Buffer.from(JSON.stringify(packet)).toString('base64url');const token=body+'.'+sign(body);
 return token.length<=16000?token:undefined;
}
export function readDetailToken(token:string,activeVersions:ReadonlyMap<string,string>=activeDocumentVersions){
 if(token.length>16000)throw new AppError('INVALID_INPUT','This explanation request is too large.',400);
 const parts=token.split('.');if(parts.length!==2)throw new AppError('INVALID_INPUT','This explanation request could not be verified.',400);
 const [body,signature]=parts;const actual=Buffer.from(signature),expected=Buffer.from(sign(body));
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){const legacy=Buffer.from(sign(body,1));if(actual.length===legacy.length&&timingSafeEqual(actual,legacy))throw new AppError('DETAIL_EXPIRED','This saved source record has changed. Generate a new route for a fresh explanation.',410);throw new AppError('INVALID_INPUT','This explanation request could not be verified.',400);}
 let packet:z.infer<typeof Packet>;try{packet=Packet.parse(JSON.parse(Buffer.from(body,'base64url').toString('utf8')));}catch{throw new AppError('INVALID_INPUT','This explanation request could not be read.',400);}
 if(packet.issued>Date.now()+60_000||Date.now()-packet.issued>30*86400_000)throw new AppError('DETAIL_EXPIRED','This saved connection can still be read, but its extended explanation has expired.',410);
 if(packet.evidence.some(source=>source.type==='academic'&&source.access!=='full_page'&&source.access!=='full_text'||source.documentId&&activeVersions.get(source.documentId)!==source.documentVersion))throw new AppError('DETAIL_EXPIRED','A source was removed or revised. Generate a new route for a fresh explanation.',410);
 return packet;
}
const cache=new Map<string,{at:number,paragraphs:string[]}>();
type DetailResult={paragraphs:string[],language:Language,usage?:ResearchUsage,cached?:boolean};
type DetailJob={promise:Promise<DetailResult>,controller:AbortController,subscribers:number,settled:boolean};
const inFlight=new Map<string,DetailJob>();
export async function explainFilm(token:string,language:Language,signal:AbortSignal):Promise<DetailResult>{
 signal.throwIfAborted();
 const packet=readDetailToken(token),fingerprint=createHash('sha256').update(token).digest('hex'),key=fingerprint+':'+language+':'+curationSettings().stageFingerprints.detail,old=cache.get(key);
 if(old&&Date.now()-old.at<86400_000)return {paragraphs:old.paragraphs,language,cached:true};
 let job=inFlight.get(key);if(job?.controller.signal.aborted){inFlight.delete(key);job=undefined;}
 if(!job){
  const controller=new AbortController();
  const created:DetailJob={promise:runExplanation(packet,language,controller.signal),controller,subscribers:0,settled:false};
  job=created;inFlight.set(key,created);
  void created.promise.then(result=>{created.settled=true;if(!controller.signal.aborted){if(cache.size>=80)cache.delete(cache.keys().next().value!);cache.set(key,{at:Date.now(),paragraphs:result.paragraphs});}},()=>{created.settled=true;}).finally(()=>{if(inFlight.get(key)===created)inFlight.delete(key);});
 }
 job.subscribers++;
 let abort=()=>{};
 try{return await Promise.race([job.promise,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});})]);}
 finally{signal.removeEventListener('abort',abort);job.subscribers--;if(!job.subscribers&&!job.settled)job.controller.abort(new DOMException('The explanation request was canceled.','AbortError'));}
}
async function runExplanation(packet:z.infer<typeof Packet>,language:Language,signal:AbortSignal):Promise<DetailResult>{
 signal.throwIfAborted();
 const result=await curatorResponse('detail',detailOutputSchema,CURATOR_DETAIL_PROMPT,{...packet,language},signal,2500,30000);
 const parsed=DetailSchema.safeParse(result.output);if(!parsed.success)throw new AppError('INVALID_RESEARCH','The extended explanation was incomplete.');
 const paragraphs=parsed.data.paragraphs.filter(Boolean).map(paragraph=>localizeTitles(paragraph,[packet.film,...packet.selected],language));if(paragraphs.length<2)throw new AppError('INVALID_RESEARCH','The extended explanation was incomplete.');
 signal.throwIfAborted();
 return {paragraphs,language,usage:result.usage};
}
