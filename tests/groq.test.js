/**
 * Model selection and response cleanup. Both are resolved against whatever Groq
 * actually serves, so these tests pin the ranking rules rather than exact IDs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { recommendedModels, cleanExplanation, DEFAULT_MODEL } from '../src/lib/groq.js';

const ids = (models) => models.map((model) => ({ id: model }));

test('the default model is the strongest recommended pick', () => {
  const picks = recommendedModels(ids(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']));
  assert.equal(picks[0].id, DEFAULT_MODEL);
});

test('picks are ordered best first and capped at the curated set', () => {
  const picks = recommendedModels(
    ids([
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-20b',
      'qwen/qwen3-32b',
      'openai/gpt-oss-120b',
    ]),
  );

  assert.deepEqual(
    picks.map((pick) => pick.id),
    ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b'],
    'listing order must not affect ranking',
  );
  assert.ok(picks.every((pick) => pick.label && pick.blurb));
});

test('a family resolves to its newest member', () => {
  const picks = recommendedModels(ids(['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b']));
  assert.equal(picks.at(-1).id, 'qwen/qwen3.8-27b');
});

test('unavailable picks are dropped rather than offered', () => {
  const picks = recommendedModels(ids(['openai/gpt-oss-20b']));
  assert.equal(picks.length, 1);
  assert.equal(picks[0].id, 'openai/gpt-oss-20b');

  assert.deepEqual(recommendedModels(ids(['some-other-model'])), []);
});

test('a model is never offered twice', () => {
  const picks = recommendedModels(ids(['openai/gpt-oss-120b', 'openai/gpt-oss-120b']));
  assert.equal(picks.length, 1);
});

test('reasoning scratchpads are stripped from the explanation', () => {
  const raw = '<think>Let me consider the DP table.</think>\n## Intuition\n\nUse DP.';
  assert.equal(cleanExplanation(raw), '## Intuition\n\nUse DP.');
});

test('a whole-response markdown fence is unwrapped', () => {
  assert.equal(cleanExplanation('```markdown\n## Intuition\n\nUse DP.\n```'), '## Intuition\n\nUse DP.');
  assert.equal(cleanExplanation('```\n## Intuition\n```'), '## Intuition');
});

test('code fences inside the explanation are preserved', () => {
  const body = '## Approach\n\n```python\nreturn 1\n```\n\nDone.';
  assert.equal(cleanExplanation(body), body);
});
