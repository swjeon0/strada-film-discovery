import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRelationRecallOptions} from '../scripts/diagnose-curator-v1-relation-recall';

test('relation-recall diagnostic is dry by default and separately named',()=>{
 const options=parseRelationRecallOptions([]);assert.equal(options.run,false);assert.equal(options.out,'work/curator-v1-relation-recall.json');
 assert.throws(()=>parseRelationRecallOptions(['--model','gpt-5.6-sol']),/Sol is excluded/);
});
