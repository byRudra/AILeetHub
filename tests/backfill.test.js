/**
 * Covers the pure decision points of a history import: which submission represents
 * a problem, what order the queue runs in, and that historical dates survive into
 * both the commit author date and the local stats.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSubmissionPage, orderQueue } from '../src/lib/backfill.js';
import { recordSolve, dateKey } from '../src/lib/stats.js';

/** Shape of one entry in LeetCode's /api/submissions/ dump. */
const dumpEntry = (overrides) => ({
  id: 1,
  title: 'Two Sum',
  title_slug: 'two-sum',
  status_display: 'Accepted',
  lang: 'python3',
  timestamp: 1700000000,
  ...overrides,
});

test('rejected submissions are ignored', () => {
  const merged = mergeSubmissionPage({}, [
    dumpEntry({ id: 1, status_display: 'Wrong Answer' }),
    dumpEntry({ id: 2, status_display: 'Time Limit Exceeded' }),
  ], true);
  assert.deepEqual(merged, {});
});

test('preferEarliest keeps the first accepted submission for a problem', () => {
  const merged = mergeSubmissionPage({}, [
    // The dump is newest-first, which is why order must not decide the winner.
    dumpEntry({ id: 30, timestamp: 1700000300 }),
    dumpEntry({ id: 10, timestamp: 1700000100 }),
    dumpEntry({ id: 20, timestamp: 1700000200 }),
  ], true);

  assert.equal(Object.keys(merged).length, 1);
  assert.equal(merged['two-sum'].submissionId, '10');
  assert.equal(merged['two-sum'].timestamp, 1700000100);
});

test('preferEarliest=false keeps the most recent accepted submission', () => {
  const merged = mergeSubmissionPage({}, [
    dumpEntry({ id: 10, timestamp: 1700000100 }),
    dumpEntry({ id: 30, timestamp: 1700000300 }),
  ], false);
  assert.equal(merged['two-sum'].submissionId, '30');
});

test('merging accumulates across pages without mutating the input', () => {
  const first = mergeSubmissionPage({}, [dumpEntry({ id: 9, timestamp: 1700000900 })], true);
  const second = mergeSubmissionPage(
    first,
    [
      dumpEntry({ id: 5, timestamp: 1700000500 }),
      dumpEntry({ id: 7, title: 'Add Two Numbers', title_slug: 'add-two-numbers', timestamp: 1700000700 }),
    ],
    true,
  );

  assert.equal(first['two-sum'].submissionId, '9', 'earlier page object is untouched');
  assert.equal(second['two-sum'].submissionId, '5', 'a later page can win');
  assert.equal(Object.keys(second).length, 2);
});

test('malformed entries are skipped rather than poisoning the queue', () => {
  const merged = mergeSubmissionPage({}, [
    dumpEntry({ title_slug: undefined }),
    dumpEntry({ timestamp: 'not-a-number' }),
  ], true);
  assert.deepEqual(merged, {});
});

test('orderQueue sorts oldest first so imported history reads forward', () => {
  const { entries } = orderQueue(
    {
      c: { submissionId: '3', timestamp: 300 },
      a: { submissionId: '1', timestamp: 100 },
      b: { submissionId: '2', timestamp: 200 },
    },
    {},
    true,
  );
  assert.deepEqual(entries.map((entry) => entry.slug), ['a', 'b', 'c']);
});

test('orderQueue skips problems already in the repo when asked', () => {
  const candidates = { a: { timestamp: 100 }, b: { timestamp: 200 } };

  const skipping = orderQueue(candidates, { a: {} }, true);
  assert.deepEqual(skipping.entries.map((entry) => entry.slug), ['b']);
  assert.deepEqual(skipping.skipped, ['a']);

  const notSkipping = orderQueue(candidates, { a: {} }, false);
  assert.equal(notSkipping.entries.length, 2);
  assert.equal(notSkipping.skipped.length, 0);
});

test('recordSolve files a backfilled problem under its original date', () => {
  // 2023-11-14 in UTC; the important part is that it is not today.
  const when = 1700000000 * 1000;
  const submission = { titleSlug: 'two-sum', title: 'Two Sum', frontendId: '1', difficulty: 'Easy', lang: 'python3', langLabel: 'Python3' };

  const next = recordSolve({ solved: {}, daily: {} }, submission, {
    dir: 'Hash Table/0001-two-sum',
    topic: 'Hash Table',
    when,
  });

  const historical = dateKey(new Date(when));
  assert.equal(next.daily[historical], 1);
  assert.equal(next.daily[dateKey()], undefined, 'must not count as activity today');
  assert.equal(next.solved['two-sum'].syncedAt, when);
});

test('live syncs still default to now', () => {
  const before = Date.now();
  const next = recordSolve({ solved: {}, daily: {} }, { titleSlug: 'x' }, { dir: 'x', topic: 'X' });
  assert.ok(next.solved.x.syncedAt >= before);
  assert.equal(next.daily[dateKey()], 1);
});

test('the scan keeps source and timings from the dump when present', () => {
  const merged = mergeSubmissionPage({}, [
    dumpEntry({ code: 'print(1)', runtime: ' 52 ms ', memory: '16.4 MB' }),
  ], true);

  // Carrying these through removes a GraphQL round trip per problem later.
  assert.equal(merged['two-sum'].code, 'print(1)');
  assert.equal(merged['two-sum'].runtime, '52 ms', 'whitespace is trimmed');
  assert.equal(merged['two-sum'].memory, '16.4 MB');
});

test('the scan omits absent or empty source rather than storing blanks', () => {
  const merged = mergeSubmissionPage({}, [dumpEntry({ code: '' })], true);
  assert.equal('code' in merged['two-sum'], false, 'push phase must fetch it instead');

  const plain = mergeSubmissionPage({}, [dumpEntry()], true);
  assert.equal('code' in plain['two-sum'], false);
  assert.equal('runtime' in plain['two-sum'], false);
});
