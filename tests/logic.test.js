/**
 * Covers the pure modules — the ones with no chrome.* or network dependency.
 * Run with `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pathFor, primaryTopic, sanitizeSegment, extensionFor, markdownLangFor } from '../src/lib/topics.js';
import { buildProblemReadme, buildRootReadme, commitMessage } from '../src/lib/readme.js';
import { computeStreak, difficultyCounts, heatmap, recordSolve, dateKey, topicCounts } from '../src/lib/stats.js';
import { toBase64, fromBase64 } from '../src/lib/github.js';

const submission = {
  submissionId: '123',
  titleSlug: 'coin-change',
  title: 'Coin Change',
  frontendId: '322',
  difficulty: 'Medium',
  topicTags: [
    { name: 'Array', slug: 'array' },
    { name: 'Dynamic Programming', slug: 'dynamic-programming' },
    { name: 'Breadth-First Search', slug: 'breadth-first-search' },
  ],
  descriptionHtml: '<p>You are given coins.</p>',
  code: 'class Solution:\n    def coinChange(self):\n        return -1\n',
  lang: 'python3',
  langLabel: 'Python3',
  runtime: '120 ms',
  runtimePercentile: 88.1234,
  memory: '17.2 MB',
  memoryPercentile: 42.5,
  problemUrl: 'https://leetcode.com/problems/coin-change/',
  solvedAt: Date.UTC(2026, 0, 15, 12, 0, 0),
};

/* ------------------------------------------------------------------ topics */

test('primaryTopic prefers the most specific tag over the first one', () => {
  assert.equal(primaryTopic(submission.topicTags).slug, 'dynamic-programming');
});

test('primaryTopic falls back to the first tag, then to Misc', () => {
  assert.equal(primaryTopic([{ name: 'Brainteaser', slug: 'brainteaser' }]).name, 'Brainteaser');
  assert.equal(primaryTopic([]).name, 'Misc');
});

test('sanitizeSegment strips Windows-illegal characters but keeps hyphens', () => {
  assert.equal(sanitizeSegment('0322-coin-change'), '0322-coin-change');
  assert.equal(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  assert.equal(sanitizeSegment('trailing dot.'), 'trailing dot');
});

test('extension and markdown language mapping', () => {
  assert.equal(extensionFor('python3'), 'py');
  assert.equal(extensionFor('golang'), 'go');
  assert.equal(extensionFor('nonsense'), 'txt');
  assert.equal(markdownLangFor('python3'), 'python');
  assert.equal(markdownLangFor('nonsense'), 'text');
});

test('pathFor builds zero-padded, topic-scoped paths', () => {
  const paths = pathFor(submission, 'topic');
  assert.equal(paths.dir, 'Dynamic Programming/0322-coin-change');
  assert.equal(paths.solution, 'Dynamic Programming/0322-coin-change/solution.py');
  assert.equal(paths.readme, 'Dynamic Programming/0322-coin-change/README.md');
});

test('pathFor honours the difficulty and flat layouts', () => {
  assert.equal(pathFor(submission, 'difficulty').dir, 'Medium/0322-coin-change');
  assert.equal(pathFor(submission, 'flat').dir, '0322-coin-change');
});

/* ------------------------------------------------------------------ readme */

test('problem README embeds the solution and the AI explanation', () => {
  const md = buildProblemReadme(submission, '## Intuition\n\nUse DP.');
  assert.match(md, /^# 322\. Coin Change$/m);
  assert.match(md, /## Intuition/);
  assert.match(md, /```python\n/);
  assert.ok(md.includes(submission.code));
  assert.match(md, /Open on LeetCode/);
  assert.match(md, /beats 88\.1%/);
});

test('problem README falls back to a template when Groq is unavailable', () => {
  const md = buildProblemReadme(submission, null);
  assert.match(md, /## Approach/);
  assert.match(md, /_not analysed_/);
  assert.ok(md.includes(submission.code));
});

test('root README creates an index block and rewrites only that block', () => {
  const solved = {
    'coin-change': {
      titleSlug: 'coin-change',
      title: 'Coin Change',
      frontendId: '322',
      difficulty: 'Medium',
      topic: 'Dynamic Programming',
      lang: 'python3',
      langLabel: 'Python3',
      dir: 'Dynamic Programming/0322-coin-change',
    },
  };

  const first = buildRootReadme(null, solved);
  assert.match(first, /<!-- AILEETHUB:START -->/);
  assert.match(first, /\| 322 \| \[Coin Change\]/);
  assert.match(first, /1 problems solved/);

  const edited = first.replace('# LeetCode Solutions', '# My Custom Title\n\nHand-written intro.');
  solved['two-sum'] = {
    titleSlug: 'two-sum',
    title: 'Two Sum',
    frontendId: '1',
    difficulty: 'Easy',
    topic: 'Hash Table',
    lang: 'python3',
    langLabel: 'Python3',
    dir: 'Hash Table/0001-two-sum',
  };

  const second = buildRootReadme(edited, solved);
  assert.match(second, /# My Custom Title/, 'user content above the markers survives');
  assert.match(second, /Hand-written intro\./);
  assert.match(second, /\| 1 \| \[Two Sum\]/);
  assert.equal(second.match(/<!-- AILEETHUB:START -->/g).length, 1, 'block is replaced, not duplicated');
  // Sorted by problem number, so Two Sum (1) precedes Coin Change (322).
  assert.ok(second.indexOf('Two Sum') < second.indexOf('Coin Change'));
});

test('commit message names difficulty, problem and topic', () => {
  assert.equal(commitMessage(submission), '[Medium] 322. Coin Change (Dynamic Programming) — 120 ms');
});

/* ------------------------------------------------------------------- stats */

test('recordSolve stores the problem and increments today', () => {
  const next = recordSolve({ solved: {}, daily: {} }, submission, {
    dir: 'Dynamic Programming/0322-coin-change',
    topic: 'Dynamic Programming',
  });
  assert.equal(next.solved['coin-change'].title, 'Coin Change');
  assert.equal(next.daily[dateKey()], 1);

  const again = recordSolve(next, submission, {
    dir: 'Dynamic Programming/0322-coin-change',
    topic: 'Dynamic Programming',
  });
  assert.equal(Object.keys(again.solved).length, 1, 're-sync updates in place');
  assert.equal(again.daily[dateKey()], 2, 're-sync still counts as activity');
});

test('computeStreak counts back from today and survives a missing today', () => {
  const day = (offset) => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return dateKey(date);
  };

  assert.equal(computeStreak({ [day(0)]: 1, [day(-1)]: 2, [day(-2)]: 1 }).current, 3);
  // Nothing solved today yet — yesterday's streak is still alive.
  assert.equal(computeStreak({ [day(-1)]: 1, [day(-2)]: 1 }).current, 2);
  assert.equal(computeStreak({ [day(-4)]: 1 }).current, 0);
  assert.equal(computeStreak({ [day(-9)]: 1, [day(-8)]: 1, [day(-7)]: 1, [day(-1)]: 1 }).longest, 3);
  assert.equal(computeStreak({}).current, 0);
});

test('difficultyCounts and topicCounts summarise the solved map', () => {
  const solved = {
    a: { difficulty: 'Easy', topic: 'Array' },
    b: { difficulty: 'Medium', topic: 'Array' },
    c: { difficulty: 'Nonsense', topic: 'Graph' },
  };
  assert.deepEqual(difficultyCounts(solved), { Easy: 1, Medium: 1, Hard: 0, Unknown: 1 });
  assert.deepEqual(topicCounts(solved), [
    { name: 'Array', count: 2 },
    { name: 'Graph', count: 1 },
  ]);
});

test('heatmap returns whole weeks and marks future cells', () => {
  const cells = heatmap({ [dateKey()]: 3 }, 4);
  assert.equal(cells.length, 28);
  assert.equal(cells.filter((cell) => cell.count === 3).length, 1);
  assert.ok(cells.some((cell) => cell.future) || dateKey() === cells.at(-1).date);
});

/* ------------------------------------------------------------------ base64 */

test('base64 helpers round-trip UTF-8 source', () => {
  const text = 'def f():\n    return "π ≈ 3.14 — ünïcode 🎯"\n';
  assert.equal(fromBase64(toBase64(text)), text);
});

test('base64 handles input larger than one chunk', () => {
  const text = 'x'.repeat(100000);
  assert.equal(fromBase64(toBase64(text)), text);
});
