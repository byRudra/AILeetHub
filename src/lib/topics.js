/**
 * Maps LeetCode metadata onto repository layout: which folder a problem belongs in
 * and what file extension its solution gets.
 */

/**
 * LeetCode tags most problems with several topics, ordered arbitrarily. Picking the
 * first tag would scatter DP problems into "Array"; this list ranks tags from most
 * to least specific so a problem lands in the folder a human would look in.
 */
const TOPIC_PRIORITY = [
  'dynamic-programming',
  'backtracking',
  'divide-and-conquer',
  'segment-tree',
  'binary-indexed-tree',
  'union-find',
  'topological-sort',
  'shortest-path',
  'minimum-spanning-tree',
  'strongly-connected-component',
  'graph',
  'binary-search-tree',
  'binary-tree',
  'tree',
  'trie',
  'heap-priority-queue',
  'monotonic-stack',
  'monotonic-queue',
  'sliding-window',
  'two-pointers',
  'binary-search',
  'greedy',
  'bit-manipulation',
  'number-theory',
  'combinatorics',
  'geometry',
  'probability-and-statistics',
  'math',
  'design',
  'simulation',
  'memoization',
  'recursion',
  'sorting',
  'prefix-sum',
  'counting',
  'hash-table',
  'stack',
  'queue',
  'linked-list',
  'matrix',
  'string',
  'array',
  'database',
  'shell',
  'concurrency',
];

const LANG_EXTENSIONS = {
  cpp: 'cpp',
  c: 'c',
  java: 'java',
  python: 'py',
  python3: 'py',
  pythondata: 'py',
  csharp: 'cs',
  javascript: 'js',
  typescript: 'ts',
  php: 'php',
  swift: 'swift',
  kotlin: 'kt',
  dart: 'dart',
  golang: 'go',
  ruby: 'rb',
  scala: 'scala',
  rust: 'rs',
  racket: 'rkt',
  erlang: 'erl',
  elixir: 'ex',
  mysql: 'sql',
  mssql: 'sql',
  oraclesql: 'sql',
  postgresql: 'sql',
  bash: 'sh',
  react: 'jsx',
};

/** Fenced-code-block language hints for the generated README. */
const LANG_MARKDOWN = {
  python3: 'python',
  pythondata: 'python',
  csharp: 'csharp',
  golang: 'go',
  mysql: 'sql',
  mssql: 'sql',
  oraclesql: 'sql',
  postgresql: 'sql',
  react: 'jsx',
};

export function extensionFor(lang) {
  return LANG_EXTENSIONS[String(lang).toLowerCase()] || 'txt';
}

export function markdownLangFor(lang) {
  const key = String(lang).toLowerCase();
  return LANG_MARKDOWN[key] || (LANG_EXTENSIONS[key] ? key : 'text');
}

/** Picks the most specific tag, falling back to the first tag, then "Misc". */
export function primaryTopic(topicTags = []) {
  if (!topicTags.length) return { name: 'Misc', slug: 'misc' };

  for (const slug of TOPIC_PRIORITY) {
    const hit = topicTags.find((tag) => tag.slug === slug);
    if (hit) return hit;
  }
  return topicTags[0];
}

/**
 * Windows-safe path segment. Git will happily create paths that Windows cannot
 * check out, so illegal characters and trailing dots/spaces are stripped here
 * rather than at clone time.
 */
export function sanitizeSegment(value) {
  return String(value)
    .replace(/[<>:"/\\|?*]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

/**
 * Builds the repo paths for a submission, e.g.
 *   Dynamic Programming/0322-coin-change/solution.py
 */
export function pathFor(submission, folderStyle = 'topic') {
  const id = String(submission.frontendId || '').padStart(4, '0');
  const leaf = sanitizeSegment(id ? `${id}-${submission.titleSlug}` : submission.titleSlug);

  let folder;
  if (folderStyle === 'flat') {
    folder = '';
  } else if (folderStyle === 'difficulty') {
    folder = sanitizeSegment(submission.difficulty || 'Unknown');
  } else {
    folder = sanitizeSegment(primaryTopic(submission.topicTags).name);
  }

  const dir = folder ? `${folder}/${leaf}` : leaf;
  return {
    dir,
    solution: `${dir}/solution.${extensionFor(submission.lang)}`,
    readme: `${dir}/README.md`,
  };
}
