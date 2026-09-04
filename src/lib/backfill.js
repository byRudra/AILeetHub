/**
 * Imports a LeetCode account's existing accepted submissions into the repo, one
 * commit per problem, each dated with the moment the problem was actually solved.
 *
 * Two phases, both resumable:
 *   scanning  page through /api/submissions/, keeping one submission per problem
 *   pushing   walk that list oldest-first, committing each with a backdated author
 *
 * Resumability is not optional here: a run can take many minutes and an MV3 service
 * worker is killed when idle, so all progress lives in chrome.storage (`backfill`)
 * and an alarm restarts `tick()` where it left off.
 */

import { get, patch, getState, isConfigured } from './storage.js';
import * as github from './github.js';
import { explainSolution } from './groq.js';
import { buildProblemReadme, buildRootReadme, commitMessage } from './readme.js';
import { pathFor, primaryTopic } from './topics.js';
import { recordSolve } from './stats.js';

const PAGE_SIZE = 20;
const SCAN_DELAY = 400;
const ITEM_DELAY = 250;
const GROQ_DELAY = 1200;
const MAX_RETRIES = 4;
const MAX_RECORDED_FAILURES = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------- LeetCode transport */

let tabId = null;

async function ping(id) {
  try {
    const response = await chrome.tabs.sendMessage(id, { type: 'PING' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

/**
 * Finds (or opens) a LeetCode tab to proxy requests through. Requests must come
 * from the page's origin — LeetCode's session cookie is SameSite, so a fetch from
 * the extension origin would arrive signed out.
 */
async function ensureTab() {
  if (tabId != null && (await ping(tabId))) return tabId;

  const stored = (await get('backfill')).tabId;
  if (stored != null && (await ping(stored))) {
    tabId = stored;
    return tabId;
  }

  const tabs = await chrome.tabs.query({ url: 'https://leetcode.com/*' });
  for (const tab of tabs) {
    if (await ping(tab.id)) {
      tabId = tab.id;
      await patch('backfill', { tabId, createdTab: false });
      return tabId;
    }
  }

  const tab = await chrome.tabs.create({ url: 'https://leetcode.com/problemset/', active: false });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    if (await ping(tab.id)) {
      tabId = tab.id;
      await patch('backfill', { tabId, createdTab: true });
      return tabId;
    }
  }

  throw new Error('Could not reach a LeetCode tab. Open leetcode.com and make sure you are signed in.');
}

async function leetcode(payload) {
  const id = await ensureTab();
  const result = await chrome.tabs.sendMessage(id, { type: 'LEETCODE_FETCH', ...payload });
  if (!result?.ok) {
    const error = new Error(result?.message || 'LeetCode request failed.');
    error.status = result?.status;
    throw error;
  }
  return result.data;
}

/** Retries rate limits with exponential backoff; other errors propagate at once. */
async function withRetry(fn) {
  let delay = 2000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const retriable = error.status === 429 || error.status === 503;
      if (!retriable || attempt >= MAX_RETRIES) throw error;
      await setMessage(`Rate limited — waiting ${Math.round(delay / 1000)}s…`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

const SUBMISSION_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      code
      timestamp
      runtimeDisplay
      runtimePercentile
      memoryDisplay
      memoryPercentile
      lang { name verboseName }
      question { questionId titleSlug title difficulty }
    }
  }`;

const QUESTION_QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      difficulty
      content
      topicTags { name slug }
    }
  }`;

/* ------------------------------------------------------------ state helpers */

async function setMessage(message) {
  await patch('backfill', { message });
}

async function stop(status, message) {
  const state = await get('backfill');
  if (state.createdTab && state.tabId != null) {
    // Only close the tab we opened ourselves.
    await chrome.tabs.remove(state.tabId).catch(() => {});
  }
  await chrome.alarms.clear('ailh-backfill').catch(() => {});
  tabId = null;
  await patch('backfill', {
    status,
    message,
    finishedAt: Date.now(),
    tabId: null,
    createdTab: false,
  });
}

/* ---------------------------------------------------------------- scan phase */

function submissionsUrl(offset, lastKey) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE_SIZE) });
  if (lastKey) params.set('lastkey', lastKey);
  return `https://leetcode.com/api/submissions/?${params}`;
}

/**
 * Folds one page of LeetCode's submission dump into the candidate map, keeping a
 * single submission per problem. Pure, so the date-selection rule is testable.
 *
 * The history contains every attempt; only accepted ones matter, and a problem
 * solved five times must collapse to one commit.
 */
export function mergeSubmissionPage(candidates, dump, preferEarliest) {
  const merged = { ...candidates };

  for (const entry of dump) {
    if (entry.status_display !== 'Accepted') continue;

    const slug = entry.title_slug;
    const timestamp = Number(entry.timestamp);
    if (!slug || !Number.isFinite(timestamp)) continue;

    const existing = merged[slug];
    // "When did I solve this" is the first accept; "my best answer" is the last.
    const better =
      !existing || (preferEarliest ? timestamp < existing.timestamp : timestamp > existing.timestamp);

    if (better) {
      merged[slug] = {
        submissionId: String(entry.id),
        timestamp,
        lang: entry.lang,
        title: entry.title,
      };
    }
  }

  return merged;
}

/**
 * Turns the candidate map into the push queue: already-synced problems dropped,
 * the rest ordered oldest-first so the imported history reads forward in time.
 */
export function orderQueue(candidates, solved, skipExisting) {
  const entries = [];
  const skipped = [];

  for (const [slug, value] of Object.entries(candidates)) {
    if (skipExisting && solved[slug]) {
      skipped.push(slug);
      continue;
    }
    entries.push({ slug, ...value });
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return { entries, skipped };
}

async function scanStep() {
  const state = await get('backfill');

  const data = await withRetry(() =>
    leetcode({ path: submissionsUrl(state.scanOffset, state.scanLastKey) }),
  );

  const dump = data.submissions_dump || [];
  const candidates = mergeSubmissionPage(state.candidates, dump, state.options.preferEarliest);

  const scanned = state.scanned + dump.length;
  const hasNext = Boolean(data.has_next) && dump.length > 0;

  if (hasNext) {
    await patch('backfill', {
      candidates,
      scanned,
      scanOffset: state.scanOffset + PAGE_SIZE,
      scanLastKey: data.last_key || null,
      message: `Scanned ${scanned} submissions — found ${Object.keys(candidates).length} solved problems…`,
    });
    await sleep(SCAN_DELAY);
    return;
  }

  await buildQueue(candidates, scanned);
}

async function buildQueue(candidates, scanned) {
  const { stats } = await getState();
  const state = await get('backfill');

  const { entries, skipped } = orderQueue(candidates, stats.solved, state.options.skipExisting);

  await patch('backfill', {
    candidates: {},
    scanned,
    queue: entries,
    cursor: 0,
    skipped: skipped.length,
    status: entries.length ? 'pushing' : 'done',
    message: entries.length
      ? `Importing ${entries.length} problems…`
      : `Nothing to import — ${skipped.length} already in the repo.`,
    ...(entries.length ? {} : { finishedAt: Date.now() }),
  });

  if (!entries.length) await stop('done', `Nothing new to import (${skipped.length} already synced).`);
}

/* ---------------------------------------------------------------- push phase */

let cachedAuthor = null;

async function authorFor(token, timestamp) {
  if (!cachedAuthor) cachedAuthor = await github.resolveAuthor(token);
  return {
    name: cachedAuthor.name,
    email: cachedAuthor.email,
    date: new Date(timestamp * 1000).toISOString(),
  };
}

/** Rebuilds one historical submission into the same shape a live sync produces. */
async function loadSubmission(item) {
  const details = (
    await withRetry(() =>
      leetcode({
        graphql: { query: SUBMISSION_QUERY, variables: { submissionId: Number(item.submissionId) } },
      }),
    )
  )?.submissionDetails;

  if (!details?.code) throw new Error('LeetCode did not return the source for this submission.');

  const question = (
    await withRetry(() =>
      leetcode({ graphql: { query: QUESTION_QUERY, variables: { titleSlug: item.slug } } }),
    )
  )?.question;

  return {
    submissionId: item.submissionId,
    titleSlug: item.slug,
    title: question?.title || details.question?.title || item.title || item.slug,
    frontendId: question?.questionFrontendId || details.question?.questionId || '',
    difficulty: question?.difficulty || details.question?.difficulty || 'Unknown',
    topicTags: question?.topicTags || [],
    descriptionHtml: question?.content || '',
    code: details.code,
    lang: details.lang?.name || item.lang || 'text',
    langLabel: details.lang?.verboseName || item.lang || '',
    runtime: details.runtimeDisplay || '',
    runtimePercentile: details.runtimePercentile ?? null,
    memory: details.memoryDisplay || '',
    memoryPercentile: details.memoryPercentile ?? null,
    problemUrl: `https://leetcode.com/problems/${item.slug}/`,
    // The whole point of backfill: the original solve time, not now.
    solvedAt: item.timestamp * 1000,
  };
}

async function pushStep() {
  const state = await get('backfill');
  const item = state.queue[state.cursor];

  if (!item) {
    await finish();
    return;
  }

  const config = await getState();
  const { token, owner, repo, branch } = config.github;

  const position = `${state.cursor + 1}/${state.queue.length}`;
  await setMessage(`(${position}) ${item.title || item.slug}`);

  try {
    const submission = await loadSubmission(item);
    const paths = pathFor(submission, config.settings.folderStyle);
    const topic = primaryTopic(submission.topicTags).name;

    let explanation = null;
    if (state.options.aiReadme && config.groq.apiKey) {
      try {
        explanation = await explainSolution(config.groq.apiKey, config.groq.model, submission);
      } catch (error) {
        console.warn('[AILeetHub] backfill explanation failed:', error.message);
      }
      await sleep(GROQ_DELAY);
    }

    const head = await github.resolveHead(token, owner, repo, branch);
    const commit = await github.createCommit(token, {
      owner,
      repo,
      message: commitMessage(submission),
      files: [
        { path: paths.solution, content: submission.code },
        { path: paths.readme, content: buildProblemReadme(submission, explanation) },
      ],
      author: await authorFor(token, item.timestamp),
      parentSha: head.commitSha,
      baseTreeSha: head.treeSha,
    });

    // The ref moves after every problem rather than once at the end: an interrupted
    // run then resumes against real history instead of orphaning its commits.
    await github.setRef(token, {
      owner,
      repo,
      branch,
      sha: commit.sha,
      create: !head.commitSha,
    });

    const nextStats = recordSolve(config.stats, submission, {
      dir: paths.dir,
      topic,
      when: submission.solvedAt,
    });
    await patch('stats', nextStats);

    await patch('backfill', { cursor: state.cursor + 1, pushed: state.pushed + 1 });
  } catch (error) {
    // A bad token or a deleted repo will fail identically for every remaining
    // problem, so stop rather than burning through the queue.
    if (error instanceof github.GitHubError && [401, 403, 404].includes(error.status)) {
      await stop('error', error.message);
      return;
    }

    const failed = [...state.failed, { slug: item.slug, message: error.message }].slice(
      -MAX_RECORDED_FAILURES,
    );
    await patch('backfill', { cursor: state.cursor + 1, failed });
  }

  await sleep(ITEM_DELAY);
}

/** Final commit: refresh the root index once, rather than on every problem. */
async function finish() {
  const state = await get('backfill');
  const config = await getState();

  if (config.settings.updateIndex) {
    try {
      await setMessage('Updating repository index…');
      const { token, owner, repo, branch } = config.github;
      const existing = await github.getFileText(token, owner, repo, 'README.md', branch);
      const head = await github.resolveHead(token, owner, repo, branch);

      const commit = await github.createCommit(token, {
        owner,
        repo,
        message: `Update index (${state.pushed} problems imported)`,
        files: [{ path: 'README.md', content: buildRootReadme(existing, config.stats.solved) }],
        author: await authorFor(token, Math.floor(Date.now() / 1000)),
        parentSha: head.commitSha,
        baseTreeSha: head.treeSha,
      });

      await github.setRef(token, { owner, repo, branch, sha: commit.sha, create: !head.commitSha });
    } catch (error) {
      console.warn('[AILeetHub] index update after backfill failed:', error.message);
    }
  }

  const summary = [
    `Imported ${state.pushed} problems`,
    state.skipped ? `${state.skipped} already synced` : null,
    state.failed.length ? `${state.failed.length} failed` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  await stop('done', summary);
}

/* ------------------------------------------------------------------ control */

let running = false;

/** Drives the state machine until it finishes, pauses, or the worker dies. */
export async function tick() {
  if (running) return;
  running = true;

  try {
    for (;;) {
      const state = await get('backfill');
      if (state.status !== 'scanning' && state.status !== 'pushing') return;

      if (state.status === 'scanning') await scanStep();
      else await pushStep();
    }
  } catch (error) {
    console.error('[AILeetHub] backfill stopped:', error);
    await stop('error', error.message || 'Import failed.');
  } finally {
    running = false;
  }
}

export async function start(options = {}) {
  const config = await getState();
  if (!isConfigured(config)) {
    return { ok: false, message: 'Connect a GitHub repository first.' };
  }

  const current = await get('backfill');
  if (current.status === 'scanning' || current.status === 'pushing') {
    return { ok: false, message: 'An import is already running.' };
  }

  cachedAuthor = null;
  tabId = null;

  await patch('backfill', {
    status: 'scanning',
    message: 'Scanning your submission history…',
    scanOffset: 0,
    scanLastKey: null,
    scanned: 0,
    candidates: {},
    queue: [],
    cursor: 0,
    pushed: 0,
    skipped: 0,
    failed: [],
    options: { ...current.options, ...options },
    startedAt: Date.now(),
    finishedAt: 0,
  });

  // Restarts tick() if the service worker is torn down mid-run.
  chrome.alarms.create('ailh-backfill', { periodInMinutes: 0.5 });
  tick();

  return { ok: true };
}

export async function pause() {
  const state = await get('backfill');
  if (state.status !== 'scanning' && state.status !== 'pushing') {
    return { ok: false, message: 'Nothing is running.' };
  }
  await patch('backfill', { status: 'paused', message: 'Paused.' });
  return { ok: true };
}

export async function resume() {
  const state = await get('backfill');
  if (state.status !== 'paused') return { ok: false, message: 'Nothing to resume.' };

  // A paused run keeps its queue and cursor, so this picks up mid-list.
  await patch('backfill', {
    status: state.queue.length ? 'pushing' : 'scanning',
    message: 'Resuming…',
  });
  chrome.alarms.create('ailh-backfill', { periodInMinutes: 0.5 });
  tick();
  return { ok: true };
}

export async function cancel() {
  await stop('idle', 'Import cancelled.');
  return { ok: true };
}
