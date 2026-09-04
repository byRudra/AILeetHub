/**
 * Minimal GitHub REST client, scoped to what the extension needs.
 *
 * Solution + README + index are written through the Git Data API (blob -> tree ->
 * commit -> ref) rather than repeated PUT /contents calls, so each accepted
 * submission lands as exactly one commit instead of two or three.
 */

const API = 'https://api.github.com';

// Source files are small; anything past this is uploaded as a blob rather than
// inlined into the tree request.
const MAX_INLINE_BYTES = 400_000;

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** btoa() is latin1-only; encode UTF-8 first so non-ASCII source survives. */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked to stay under the argument limit of String.fromCharCode for big files.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(base64) {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function request(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (response.status === 204) return null;

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubError('GitHub rejected the token. Generate a new one in Settings.', 401);
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('GitHub API rate limit reached. Try again shortly.', 403);
    }
    throw new GitHubError(body.message || `GitHub returned ${response.status}`, response.status);
  }

  return body;
}

export function getUser(token) {
  return request(token, '/user');
}

/** Repos the token can push to, newest activity first. */
export async function listRepos(token) {
  const repos = await request(
    token,
    '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator',
  );
  return repos
    .filter((repo) => repo.permissions?.push)
    .map((repo) => ({
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));
}

export async function createRepo(token, name, isPrivate) {
  const repo = await request(token, '/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      private: Boolean(isPrivate),
      description: 'LeetCode solutions, synced automatically by AILeetHub.',
      // Without an initial commit the repo has no ref to build commits on.
      auto_init: true,
    }),
  });
  return {
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    private: repo.private,
    defaultBranch: repo.default_branch,
  };
}

export function getRepo(token, owner, repo) {
  return request(token, `/repos/${owner}/${repo}`);
}

/**
 * Identity to stamp on commits.
 *
 * This matters for backfill: GitHub only counts a commit toward the contribution
 * graph when the author email belongs to the account. A private profile hides
 * user.email and /user/emails needs an extra scope, so the account's noreply
 * address is the fallback — it is bound to the account by definition and still
 * counts.
 */
export async function resolveAuthor(token) {
  const user = await getUser(token);

  let email = user.email;
  if (!email) {
    try {
      const emails = await request(token, '/user/emails');
      const chosen =
        emails.find((entry) => entry.primary && entry.verified) ||
        emails.find((entry) => entry.verified);
      email = chosen?.email;
    } catch {
      // Token lacks the email scope; fall through to the noreply address.
    }
  }

  return {
    name: user.name || user.login,
    email: email || `${user.id}+${user.login}@users.noreply.github.com`,
    login: user.login,
    // True when we had to guess; the UI warns that graph credit depends on it.
    inferredEmail: !user.email,
  };
}

/** Returns the file's decoded text, or null when it does not exist yet. */
export async function getFileText(token, owner, repo, path, branch) {
  try {
    const file = await request(
      token,
      `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
    );
    if (!file?.content) return null;
    return fromBase64(file.content);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Current tip of a branch, or nulls when the branch has no commits yet. */
export async function resolveHead(token, owner, repo, branch) {
  try {
    const ref = await request(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const commit = await request(token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  } catch (error) {
    // 404/409 means an empty repo or a branch that does not exist yet.
    if (error.status === 404 || error.status === 409) return { commitSha: null, treeSha: null };
    throw error;
  }
}

/**
 * Creates a commit object without moving any ref.
 *
 * @param {object} options
 * @param {Array<{path: string, content: string}>} options.files
 * @param {{name: string, email: string, date?: string}} [options.author]
 *   `date` is ISO 8601. GitHub's contribution graph reads the author date, which is
 *   what lets backfilled solutions land on the day they were originally solved.
 */
export async function createCommit(
  token,
  { owner, repo, message, files, author, parentSha, baseTreeSha },
) {
  // The trees API accepts file content inline, which folds what used to be one
  // blob request per file into the tree request itself. That matters for backfill:
  // it removes two round trips from every single problem. Oversized or non-UTF-8
  // content still needs a real blob.
  const oversized = files.filter((file) => file.content.length > MAX_INLINE_BYTES);
  const blobs = new Map(
    await Promise.all(
      oversized.map((file) =>
        request(token, `/repos/${owner}/${repo}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: toBase64(file.content), encoding: 'base64' }),
        }).then((blob) => [file.path, blob.sha]),
      ),
    ),
  );

  const tree = await request(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        ...(blobs.has(file.path)
          ? { sha: blobs.get(file.path) }
          : { content: file.content }),
      })),
    }),
  });

  const commit = await request(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
      // Both dates are set: the graph uses the author date, but a matching
      // committer date keeps `git log` from looking inconsistent.
      ...(author ? { author, committer: author } : {}),
    }),
  });

  return { sha: commit.sha, treeSha: tree.sha };
}

export async function setRef(token, { owner, repo, branch, sha, create, force = false }) {
  const path = `/repos/${owner}/${repo}/git`;
  if (create) {
    return request(token, `${path}/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
  }
  return request(token, `${path}/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha, force }),
  });
}

export function commitUrl(owner, repo, sha) {
  return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

/**
 * Resolve HEAD, commit, move the branch. The one-shot path used by live syncs;
 * backfill drives resolveHead/createCommit/setRef itself so it can chain commits.
 */
export async function commitFiles(token, { owner, repo, branch, message, files, author }) {
  const head = await resolveHead(token, owner, repo, branch);

  const commit = await createCommit(token, {
    owner,
    repo,
    message,
    files,
    author,
    parentSha: head.commitSha,
    baseTreeSha: head.treeSha,
  });

  await setRef(token, { owner, repo, branch, sha: commit.sha, create: !head.commitSha });

  return { sha: commit.sha, treeSha: commit.treeSha, htmlUrl: commitUrl(owner, repo, commit.sha) };
}
