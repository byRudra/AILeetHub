/**
 * Single source of truth for extension state.
 *
 * Everything lives in chrome.storage.local (never `sync`) because it holds a GitHub
 * token and a Groq key, and `sync` would replicate those to every machine signed
 * into the browser profile.
 */

import { DEFAULT_MODEL } from './groq.js';

export const DEFAULTS = {
  github: {
    token: '',
    login: '',
    owner: '',
    repo: '',
    branch: 'main',
  },
  groq: {
    apiKey: '',
    model: DEFAULT_MODEL,
  },
  settings: {
    enabled: true,
    aiReadme: true,
    focusMode: false,
    updateIndex: true,
    folderStyle: 'topic', // 'topic' | 'difficulty' | 'flat'
  },
  stats: {
    // slug -> { title, difficulty, topic, lang, syncedAt, path }
    solved: {},
    // ISO date (YYYY-MM-DD) -> count, used by the popup heatmap and streak.
    daily: {},
  },
  /**
   * Progress of a history import. Persisted (rather than held in memory) because
   * an MV3 service worker is terminated when idle: the alarm restarts the run and
   * it resumes from `cursor` instead of starting over.
   */
  backfill: {
    status: 'idle', // idle | scanning | pushing | paused | done | error
    message: '',
    // Scan phase: LeetCode's submission dump is paginated by offset + lastKey.
    scanOffset: 0,
    scanLastKey: null,
    scanned: 0,
    // slug -> { submissionId, timestamp, lang, title }
    candidates: {},
    // Push phase: [{ slug, submissionId, timestamp }] sorted oldest first.
    queue: [],
    cursor: 0,
    pushed: 0,
    skipped: 0,
    failed: [], // [{ slug, message }]
    options: {
      preferEarliest: true, // the submission that first solved it = the real date
      aiReadme: false, // off by default: hundreds of Groq calls hit rate limits
      skipExisting: true,
    },
    startedAt: 0,
    finishedAt: 0,
    // Set when backfill opened its own LeetCode tab, so it can close it again.
    tabId: null,
    createdTab: false,
  },
};

const KEYS = Object.keys(DEFAULTS);

/** Shallow-merges stored values over defaults so new keys appear after upgrades. */
export async function getState() {
  const stored = await chrome.storage.local.get(KEYS);
  const state = {};
  for (const key of KEYS) {
    state[key] = { ...DEFAULTS[key], ...(stored[key] || {}) };
  }
  return state;
}

export async function get(key) {
  const stored = await chrome.storage.local.get(key);
  return { ...DEFAULTS[key], ...(stored[key] || {}) };
}

export async function patch(key, values) {
  const current = await get(key);
  const next = { ...current, ...values };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/** True once the extension has enough configuration to push a solution. */
export function isConfigured(state) {
  return Boolean(state.github.token && state.github.owner && state.github.repo);
}
