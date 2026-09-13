import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDisplayProse, hasStructuredArtifact } from '../lib/prose';

test('serialized recommendation tail is hidden while the explanation is retained', () => {
  for (const tail of [
    '\", \"sourceIds\": [\"web:1\"]}]}',
    '”, ”sourceIds”: [”web:1”]}]}',
    String.raw`\",\n\"sourceIds\": [\"web:1\"]}]}`,
    String.raw`\u0022, \u0022sourceIds\u0022: []}]}`,
    '}, sourceIds: []}',
    '\"}]}',
  ]) {
    const input = 'Ordinary gestures make the passage of time tangible.' + tail;
    assert.equal(hasStructuredArtifact(input), true, tail);
    assert.equal(cleanDisplayProse(input), 'Ordinary gestures make the passage of time tangible.', tail);
  }
});

test('Korean explanations survive curly quotation and schema-key contamination', () => {
  const input = '일상의 작은 몸짓과 시간이 쌓이는 방식을 살펴보세요.”, ”inferenceWhyKo”: {”connection”: ”다음 값”}, ”sourceIds”: []}';
  assert.equal(cleanDisplayProse(input), '일상의 작은 몸짓과 시간이 쌓이는 방식을 살펴보세요.');
});

test('ordinary quotes, bracketed titles and discussions of form remain unchanged', () => {
  for (const prose of [
    'The film asks, “What is home?” Its answer emerges through small gestures.',
    'Notice the final question: “What is home?”',
    'Notice the question, "What is home?"',
    'A critic might call it “a film about time,” but the quieter gestures matter.',
    'The [REC] title and its camera motif are useful points of comparison.',
    'The terms “connection” and “watchFor” are merely labels here.',
    '대사는 “어디가 집일까?”라고 묻고, 화면은 그 질문을 오래 붙든다.',
  ]) {
    assert.equal(hasStructuredArtifact(prose), false, prose);
    assert.equal(cleanDisplayProse(prose), prose, prose);
  }
});

test('balanced human quotations before a machine tail keep their closing marks', () => {
  assert.equal(cleanDisplayProse('The image asks: “What is home?”, "sourceIds": []}'), 'The image asks: “What is home?”');
  assert.equal(cleanDisplayProse('The image asks: "What is home?", "sourceIds": []}'), 'The image asks: "What is home?"');
});

test('an all-structured saved value becomes empty for caller fallback', () => {
  for (const input of [
    '{"inferenceWhy":{"connection":"An explanation"},"sourceIds":[]}',
    '```json\n{"inferenceWhyKo":{"filmForm":"내용"}}\n```',
    '”sourceIds”: []}]}',
    '[{"film":"Boyhood"}]',
  ]) {
    assert.equal(hasStructuredArtifact(input), true, input);
    assert.equal(cleanDisplayProse(input), '', input);
  }
  assert.equal(cleanDisplayProse('  '), '');
});

test('cleaning is idempotent and can drive a safe saved-language fallback', () => {
  const goodEnglish = 'Watch how a pause changes the relationship between the two characters.';
  const savedKorean = '”sourceIds”: []}]}';
  const display = cleanDisplayProse(savedKorean) || cleanDisplayProse(goodEnglish);
  assert.equal(display, goodEnglish);
  assert.equal(cleanDisplayProse(display), display);
  assert.equal(hasStructuredArtifact(display), false);
});
