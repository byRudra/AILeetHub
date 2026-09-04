/**
 * Single source of truth for extension state.
 *
 * Everything lives in chrome.storage.local (never `sync`) because it holds a GitHub
 * token and a Groq key, and `sync` would replicate those to every machine signed
 * into the browser profile.
 */

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
    model: 'llama-3.3-70b-versatile',
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
