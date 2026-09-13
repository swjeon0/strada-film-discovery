import {createHash} from 'node:crypto';
import configuration from '../../config/curation.json';
import {curationPromptAdditions,curationPromptOverrides} from '../../config/curation-prompts';
import {CURATOR_DRAFT_PROMPT,CURATOR_SELECT_PROMPT,CURATOR_DETAIL_PROMPT} from '../curation-contract';
import {CURATOR_WRITE_PROMPT} from '../curation-writing-prompt';

export type CurationStage='draft'|'curate'|'write'|'detail';
export type ModelStage=CurationStage|'search';
export type ReasoningEffort='none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export type StageSettings={model:string,reasoning:ReasoningEffort|null};
type Prompts=Record<CurationStage,string>;
type SettingsOptions={
 env?:Record<string,string|undefined>;
 basePrompts?:Partial<Prompts>;
 additions?:Partial<Prompts>;
 overrides?:Partial<Prompts>;
};
const basePrompts:Prompts={draft:CURATOR_DRAFT_PROMPT,curate:CURATOR_SELECT_PROMPT,write:CURATOR_WRITE_PROMPT,detail:CURATOR_DETAIL_PROMPT};
const stageNames:ModelStage[]=['draft','curate','write','detail','search'];
const envPrefixes:Record<ModelStage,string>={draft:'OPENAI_DRAFT',curate:'OPENAI_SELECT',write:'OPENAI_WRITE',detail:'OPENAI_DETAIL',search:'OPENAI_SEARCH'};
const efforts=new Set<ReasoningEffort>(['none','minimal','low','medium','high','xhigh','max']);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const nonempty=(value:string|undefined)=>value?.trim()||undefined;

/** Non-reasoning models must not receive a reasoning parameter. */
export function supportsReasoning(model:string){return /^(?:gpt-[5-9](?:[.\-]|$)|o[134](?:[.\-]|$))/.test(model);}
function validateEffort(model:string,effort:ReasoningEffort|null){
 if(effort===null)return;
 const known=/^gpt-5\.6(?:-|$)/.test(model)?['none','low','medium','high','xhigh','max']
  :/^gpt-5\.4-mini(?:-|$)/.test(model)?['none','low','medium','high','xhigh']
  :/^gpt-6-astra(?:-|$)/.test(model)?['low','medium','high','xhigh','max']:null;
 if(known&&!known.includes(effort))throw new Error(`Reasoning effort ${effort} is not supported by ${model}.`);
}

/** No request body can override these server-owned settings. */
export function curationSettings(options:SettingsOptions={}){
 const env=options.env??process.env,profile=nonempty(env.STRADA_PROFILE)??configuration.defaultProfile;
 const profiles=configuration.profiles as Record<string,Record<ModelStage,{model:string,reasoning:string|null}>>;
 if(!Object.prototype.hasOwnProperty.call(profiles,profile))throw new Error(`Unknown STRADA_PROFILE: ${profile}. Choose a profile in config/curation.json.`);
 const stages={} as Record<ModelStage,StageSettings>;
 for(const stage of stageNames){
  const defaults=profiles[profile][stage],prefix=envPrefixes[stage];
  const model=nonempty(env[prefix+'_MODEL'])??nonempty(stage==='search'?env.OPENAI_MODEL:env.OPENAI_CURATOR_MODEL)??defaults.model;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))throw new Error(`Invalid model configured for ${stage}.`);
  const effort=nonempty(env[prefix+'_REASONING'])??(stage==='search'?undefined:nonempty(env.OPENAI_CURATOR_REASONING))??defaults.reasoning;
  if(effort!==null&&effort!==undefined&&!efforts.has(effort as ReasoningEffort))throw new Error(`Invalid reasoning effort configured for ${stage}.`);
  stages[stage]={model,reasoning:supportsReasoning(model)?(effort as ReasoningEffort|null)??'low':null};
  validateEffort(model,stages[stage].reasoning);
 }
 const prompts={} as Prompts,stageFingerprints={} as Record<ModelStage,string>;
 for(const stage of ['draft','curate','write','detail'] as const){
  const replacement=options.overrides?.[stage]??curationPromptOverrides[stage];
  const base=replacement===undefined?(options.basePrompts?.[stage]??basePrompts[stage]):replacement;
  if(!base.trim())throw new Error(`The ${stage} prompt cannot be empty.`);
  const addition=(options.additions?.[stage]??curationPromptAdditions[stage]).trim();
  prompts[stage]=addition?`${base}\n\nAdditional curator instructions:\n${addition}`:base;
  stageFingerprints[stage]=hash({stage,...stages[stage],prompt:prompts[stage]});
 }
 stageFingerprints.search=hash({stage:'search',...stages.search});
 return {profile,stages,prompts,stageFingerprints,fingerprint:hash(stageFingerprints)};
}

export function curationPrompt(stage:CurationStage,basePrompt?:string){
 return curationSettings(basePrompt===undefined?{}:{basePrompts:{[stage]:basePrompt}}).prompts[stage];
}
