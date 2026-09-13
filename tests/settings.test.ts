import test from 'node:test';
import assert from 'node:assert/strict';
import {curationSettings,supportsReasoning} from '../lib/server/curation-settings';

test('balanced profile upgrades only final critical selection to Terra',()=>{
 const settings=curationSettings({env:{}});
 assert.equal(settings.profile,'balanced');
 assert.deepEqual(settings.stages,{
  draft:{model:'gpt-5.4-mini',reasoning:'low'},
  curate:{model:'gpt-5.6-terra',reasoning:'low'},
  write:{model:'gpt-5.4-mini',reasoning:'low'},
  detail:{model:'gpt-5.4-mini',reasoning:'low'},
  search:{model:'gpt-4.1-mini',reasoning:null},
 });
 const baseline=curationSettings({env:{STRADA_PROFILE:'baseline'}});
 assert.equal(baseline.stages.curate.model,'gpt-5.4-mini');
 assert.equal(baseline.stageFingerprints.draft,settings.stageFingerprints.draft);
 assert.notEqual(baseline.stageFingerprints.curate,settings.stageFingerprints.curate);
});

test('stage environment overrides take precedence over legacy shared overrides and profile defaults',()=>{
 const settings=curationSettings({env:{
  OPENAI_CURATOR_MODEL:'gpt-5.6-terra',OPENAI_CURATOR_REASONING:'medium',
  OPENAI_DRAFT_MODEL:'gpt-5.4-mini',OPENAI_DRAFT_REASONING:'none',
  OPENAI_SELECT_REASONING:'low',OPENAI_WRITE_REASONING:'none',OPENAI_DETAIL_MODEL:'gpt-4.1-mini',
  OPENAI_MODEL:'old-search',OPENAI_SEARCH_MODEL:'gpt-5.6-luna',OPENAI_SEARCH_REASONING:'none',
 }});
 assert.deepEqual(settings.stages.draft,{model:'gpt-5.4-mini',reasoning:'none'});
 assert.deepEqual(settings.stages.curate,{model:'gpt-5.6-terra',reasoning:'low'});
 assert.deepEqual(settings.stages.write,{model:'gpt-5.6-terra',reasoning:'none'});
 assert.deepEqual(settings.stages.detail,{model:'gpt-4.1-mini',reasoning:null});
 assert.deepEqual(settings.stages.search,{model:'gpt-5.6-luna',reasoning:'none'});
 const legacy=curationSettings({env:{OPENAI_CURATOR_MODEL:'test-curator-existing',OPENAI_MODEL:'test-search-existing'}});
 for(const stage of ['draft','curate','write','detail'] as const)assert.equal(legacy.stages[stage].model,'test-curator-existing');
 assert.equal(legacy.stages.search.model,'test-search-existing');
});

test('fingerprints change for effective model, reasoning, base prompt, addition and replacement',()=>{
 const baseline=curationSettings({env:{}});
 const changed=[
  curationSettings({env:{OPENAI_SELECT_MODEL:'gpt-5.4-mini'}}),
  curationSettings({env:{OPENAI_SELECT_REASONING:'medium'}}),
  curationSettings({env:{},basePrompts:{curate:'A changed base prompt.'}}),
  curationSettings({env:{},additions:{curate:'A changed curator instruction.'}}),
  curationSettings({env:{},overrides:{curate:'An explicitly replaced prompt.'}}),
 ];
 for(const setting of changed){
  assert.notEqual(setting.fingerprint,baseline.fingerprint);
  assert.notEqual(setting.stageFingerprints.curate,baseline.stageFingerprints.curate);
  assert.equal(setting.stageFingerprints.draft,baseline.stageFingerprints.draft);
 }
 const secretChanged=curationSettings({env:{OPENAI_API_KEY:'not-a-real-key',TMDB_READ_ACCESS_TOKEN:'not-a-real-token'}});
 assert.equal(secretChanged.fingerprint,baseline.fingerprint);
 assert.equal(JSON.stringify(secretChanged).includes('not-a-real'),false);
});

test('prompt changes preserve the base unless an explicit replacement is supplied',()=>{
 const added=curationSettings({env:{},basePrompts:{draft:'BASE'},additions:{draft:'ADDED'}});
 assert.equal(added.prompts.draft,'BASE\n\nAdditional curator instructions:\nADDED');
 const replaced=curationSettings({env:{},basePrompts:{draft:'BASE'},additions:{draft:''},overrides:{draft:'REPLACEMENT'}});
 assert.equal(replaced.prompts.draft,'REPLACEMENT');
 assert.throws(()=>curationSettings({env:{},overrides:{draft:'  '}}),/prompt cannot be empty/);
});

test('unsupported profiles, malformed settings and known unsupported reasoning levels fail before a paid call',()=>{
 assert.throws(()=>curationSettings({env:{STRADA_PROFILE:'does-not-exist'}}),/Unknown STRADA_PROFILE/);
 assert.throws(()=>curationSettings({env:{STRADA_PROFILE:'__proto__'}}),/Unknown STRADA_PROFILE/);
 assert.throws(()=>curationSettings({env:{OPENAI_SELECT_REASONING:'ultra'}}),/Invalid reasoning effort/);
 assert.throws(()=>curationSettings({env:{OPENAI_SELECT_REASONING:'minimal'}}),/not supported/);
 assert.throws(()=>curationSettings({env:{OPENAI_DRAFT_REASONING:'max'}}),/not supported/);
 assert.throws(()=>curationSettings({env:{OPENAI_SELECT_MODEL:'bad model name'}}),/Invalid model/);
 assert.equal(supportsReasoning('gpt-5.6-sol'),true);
 assert.equal(supportsReasoning('gpt-6-astra'),true);
 assert.equal(supportsReasoning('gpt-4.1-mini'),false);
});
