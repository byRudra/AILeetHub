/**
 * Exercises the GitHub client against a stubbed fetch. The point is the request
 * bodies: backdating only works if the author date actually reaches the API, and
 * that is invisible from the outside until a commit lands on the wrong day.
 */

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCommit,
  commitFiles,
  resolveHead,
  resolveAuthor,
  ensureBranch,
  getFileText,
} from '../src/lib/github.js';

const realFetch = globalThis.fetch;
let calls = [];

/** @param {Record<string, unknown>} routes url-substring -> response body */
function stubFetch(routes, { status = 200 } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    });

    const match = Object.keys(routes).find((key) => url.includes(key));
    if (!match) throw new Error(`unstubbed request: ${options.method || 'GET'} ${url}`);

    const entry = routes[match];
    const code = entry?.__status ?? status;
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: () => null },
      json: async () => entry,
    };
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const files = [{ path: 'Array/0001-two-sum/solution.py', content: 'print(1)\n' }];

test('createCommit sends the backdated author and committer', async () => {
  stubFetch({
    '/git/blobs': { sha: 'blob1' },
    '/git/trees': { sha: 'tree1' },
    '/git/commits': { sha: 'commit1' },
  });

  const author = { name: 'Ada', email: 'ada@example.com', date: '2023-11-14T22:13:20.000Z' };
  const result = await createCommit('tok', {
    owner: 'o',
    repo: 'r',
    message: 'msg',
    files,
    author,
    parentSha: 'parent1',
    baseTreeSha: 'tree0',
  });

  const commitCall = calls.find((call) => call.url.includes('/git/commits'));
  assert.deepEqual(commitCall.body.author, author, 'author date drives the contribution graph');
  assert.deepEqual(commitCall.body.committer, author, 'committer date kept consistent');
  assert.deepEqual(commitCall.body.parents, ['parent1']);
  assert.equal(commitCall.body.tree, 'tree1');

  const treeCall = calls.find((call) => call.url.includes('/git/trees'));
  assert.equal(treeCall.body.base_tree, 'tree0');
  // Content is inlined into the tree: one request per commit instead of one blob
  // upload per file, which is what keeps a 600-problem import inside rate limits.
  assert.deepEqual(treeCall.body.tree, [
    { path: files[0].path, mode: '100644', type: 'blob', content: files[0].content },
  ]);
  assert.equal(calls.some((call) => call.url.includes('/git/blobs')), false);

  assert.equal(result.sha, 'commit1');
  assert.equal(result.treeSha, 'tree1');
});

test('createCommit omits author entirely when none is given', async () => {
  stubFetch({
    '/git/blobs': { sha: 'blob1' },
    '/git/trees': { sha: 'tree1' },
    '/git/commits': { sha: 'commit1' },
  });

  await createCommit('tok', { owner: 'o', repo: 'r', message: 'm', files });

  const commitCall = calls.find((call) => call.url.includes('/git/commits'));
  assert.equal('author' in commitCall.body, false, 'GitHub should default to the token owner');
  assert.deepEqual(commitCall.body.parents, [], 'no parent means an initial commit');
});

test('resolveHead reports an empty repo instead of throwing', async () => {
  stubFetch({ '/git/ref/heads/main': { __status: 404, message: 'Not Found' } });
  assert.deepEqual(await resolveHead('tok', 'o', 'r', 'main'), {
    commitSha: null,
    treeSha: null,
  });
});

test('commitFiles fast-forwards a branch that already has commits', async () => {
  stubFetch({
    '/git/ref/heads/main': { object: { sha: 'head1' } },
    '/git/commits/head1': { tree: { sha: 'tree0' } },
    '/git/trees': { sha: 'tree1' },
    '/git/commits': { sha: 'commit1' },
    '/git/refs/heads/main': { ref: 'refs/heads/main' },
  });

  await commitFiles('tok', { owner: 'o', repo: 'r', branch: 'main', message: 'm', files });

  assert.equal(calls.at(-1).method, 'PATCH');
  assert.equal(
    calls.some((call) => call.url.includes('/contents/')),
    false,
    'a populated repo must not be bootstrapped',
  );
});

test('an empty repo is bootstrapped through the contents API', async () => {
  // GitHub answers every Git Data write on a repo with no commits with 409
  // "Git Repository is empty.", so the first commit has to go through /contents.
  let initialised = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });

    const reply = (status, body) => ({
      ok: status < 300,
      status,
      headers: { get: () => null },
      json: async () => body,
    });

    if (url.includes('/contents/README.md') && options.method === 'PUT') {
      initialised = true;
      return reply(201, { commit: { sha: 'boot1' } });
    }
    if (url.includes('/git/ref/heads/main')) {
      return initialised
        ? reply(200, { object: { sha: 'boot1' } })
        : reply(409, { message: 'Git Repository is empty.' });
    }
    if (url.includes('/git/commits/boot1')) return reply(200, { tree: { sha: 'boottree' } });
    if (url.includes('/git/trees')) return reply(201, { sha: 'tree1' });
    if (url.includes('/git/commits')) return reply(201, { sha: 'commit1' });
    if (url.includes('/git/refs/heads/main')) return reply(200, {});
    throw new Error(`unstubbed: ${url}`);
  };

  const author = { name: 'Ada', email: 'ada@example.com', date: '2021-05-02T10:00:00.000Z' };
  const head = await ensureBranch('tok', { owner: 'o', repo: 'r', branch: 'main', author });

  const put = calls.find((call) => call.method === 'PUT');
  assert.ok(put, 'the bootstrap commit must be created');
  assert.deepEqual(put.body.author, author, 'bootstrap is backdated too');
  assert.equal('branch' in put.body, false, 'the branch does not exist yet on an empty repo');
  assert.deepEqual(head, { commitSha: 'boot1', treeSha: 'boottree' });

  // And the normal commit path now works against it.
  calls = [];
  await commitFiles('tok', { owner: 'o', repo: 'r', branch: 'main', message: 'm', files });
  assert.equal(calls.some((call) => call.method === 'PUT'), false, 'bootstrapped only once');
  assert.equal(calls.at(-1).method, 'PATCH');
});

test('reading a file from an empty repo returns null rather than throwing', async () => {
  stubFetch({ '/contents/README.md': { __status: 409, message: 'Git Repository is empty.' } });
  assert.equal(await getFileText('tok', 'o', 'r', 'README.md', 'main'), null);
});

test('resolveAuthor prefers the public email', async () => {
  stubFetch({ '/user': { login: 'ada', id: 7, name: 'Ada L', email: 'ada@example.com' } });
  const author = await resolveAuthor('tok');
  assert.equal(author.email, 'ada@example.com');
  assert.equal(author.name, 'Ada L');
  assert.equal(author.inferredEmail, false);
});

test('resolveAuthor falls back to a verified email, then to the noreply address', async () => {
  stubFetch({
    '/user/emails': [
      { email: 'old@example.com', primary: false, verified: true },
      { email: 'primary@example.com', primary: true, verified: true },
    ],
    '/user': { login: 'ada', id: 7, name: null, email: null },
  });
  const withEmails = await resolveAuthor('tok');
  assert.equal(withEmails.email, 'primary@example.com');
  assert.equal(withEmails.name, 'ada', 'falls back to the login when name is unset');
  assert.equal(withEmails.inferredEmail, true);

  calls = [];
  stubFetch({
    '/user/emails': { __status: 403, message: 'scope missing' },
    '/user': { login: 'ada', id: 7, email: null },
  });
  const noScope = await resolveAuthor('tok');
  // This address is bound to the account, so contributions still count.
  assert.equal(noScope.email, '7+ada@users.noreply.github.com');
});

test('a 401 is reported as a token problem, not a generic failure', async () => {
  stubFetch({ '/user': { __status: 401, message: 'Bad credentials' } });
  await assert.rejects(resolveAuthor('tok'), /rejected the token/);
});

test('an oversized file falls back to a blob upload', async () => {
  stubFetch({
    '/git/blobs': { sha: 'bigblob' },
    '/git/trees': { sha: 'tree1' },
    '/git/commits': { sha: 'commit1' },
  });

  const big = { path: 'big.txt', content: 'x'.repeat(500_000) };
  await createCommit('tok', { owner: 'o', repo: 'r', message: 'm', files: [files[0], big] });

  const treeCall = calls.find((call) => call.url.includes('/git/trees'));
  const [small, large] = treeCall.body.tree;

  assert.equal(small.content, files[0].content, 'small files stay inline');
  assert.equal(large.sha, 'bigblob', 'large files are uploaded first');
  assert.equal('content' in large, false);
  assert.equal(calls.filter((call) => call.url.includes('/git/blobs')).length, 1);
});
