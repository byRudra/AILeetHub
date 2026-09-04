/**
 * Minimal GitHub REST client, scoped to what the extension needs.
 *
 * Solution + README + index are written through the Git Data API (blob -> tree ->
 * commit -> ref) rather than repeated PUT /contents calls, so each accepted
 * submission lands as exactly one commit instead of two or three.
 */

const API = 'https://api.github.com';

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

/**
 * Commits several files at once.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {Promise<{sha: string, htmlUrl: string}>}
 */
export async function commitFiles(token, { owner, repo, branch, message, files }) {
  const ref = `heads/${branch}`;

  let baseCommitSha = null;
  try {
    const refData = await request(token, `/repos/${owner}/${repo}/git/ref/${ref}`);
    baseCommitSha = refData.object.sha;
  } catch (error) {
    // 404 here means the branch has no commits yet (empty repo, or a new branch).
    if (error.status !== 404 && error.status !== 409) throw error;
  }

  let baseTreeSha;
  if (baseCommitSha) {
    const baseCommit = await request(token, `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
    baseTreeSha = baseCommit.tree.sha;
  }

  const blobs = await Promise.all(
    files.map((file) =>
      request(token, `/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: toBase64(file.content), encoding: 'base64' }),
      }).then((blob) => ({ path: file.path, sha: blob.sha })),
    ),
  );

  const tree = await request(token, `/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      })),
    }),
  });

  const commit = await request(token, `/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: baseCommitSha ? [baseCommitSha] : [],
    }),
  });

  if (baseCommitSha) {
    await request(token, `/repos/${owner}/${repo}/git/refs/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
  } else {
    await request(token, `/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${ref}`, sha: commit.sha }),
    });
  }

  return {
    sha: commit.sha,
    htmlUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
  };
}
