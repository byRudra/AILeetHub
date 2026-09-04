/**
 * Setup page. Runs as an extension page, so it holds host permissions for both
 * api.github.com and api.groq.com and can call the API clients directly instead of
 * routing verification through the service worker.
 */

import { getState, patch, DEFAULTS } from '../lib/storage.js';
import * as github from '../lib/github.js';
import { listModels, recommendedModels, DEFAULT_MODEL } from '../lib/groq.js';

const $ = (id) => document.getElementById(id);

const els = {
  githubToken: $('github-token'),
  githubConnect: $('github-connect'),
  githubState: $('github-state'),
  repoSection: $('repo-section'),
  repoSelect: $('repo-select'),
  repoRefresh: $('repo-refresh'),
  repoNewName: $('repo-new-name'),
  repoNewPrivate: $('repo-new-private'),
  repoCreate: $('repo-create'),
  groqKey: $('groq-key'),
  groqVerify: $('groq-verify'),
  groqState: $('groq-state'),
  groqModel: $('groq-model'),
  groqPicks: $('groq-picks'),
  groqMore: $('groq-more'),
  prefEnabled: $('pref-enabled'),
  prefAi: $('pref-ai'),
  prefIndex: $('pref-index'),
  prefFocus: $('pref-focus'),
  prefFolder: $('pref-folder'),
  save: $('save'),
  status: $('status'),
  backfillState: $('backfill-state'),
  backfillPrefer: $('backfill-prefer'),
  backfillSkip: $('backfill-skip'),
  backfillAi: $('backfill-ai'),
  backfillProgress: $('backfill-progress'),
  backfillFill: $('backfill-fill'),
  backfillMessage: $('backfill-message'),
  backfillFailures: $('backfill-failures'),
  backfillFailureList: $('backfill-failure-list'),
  backfillStart: $('backfill-start'),
  backfillPause: $('backfill-pause'),
  backfillResume: $('backfill-resume'),
  backfillCancel: $('backfill-cancel'),
};

let repos = [];

function setPill(el, text, state) {
  el.textContent = text;
  if (state) el.dataset.state = state;
  else delete el.dataset.state;
}

let statusTimer = null;
function setStatus(text, state) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  if (state) els.status.dataset.state = state;
  else delete els.status.dataset.state;
  if (text) statusTimer = setTimeout(() => setStatus(''), 4000);
}

/** Wraps an async click handler with disabled/busy state and error reporting. */
function withBusy(button, label, fn) {
  return async () => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await fn();
    } catch (error) {
      setStatus(error.message || 'Something went wrong.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };
}

function renderRepos(selectedFullName) {
  els.repoSelect.innerHTML = '';
  if (!repos.length) {
    els.repoSelect.append(new Option('No pushable repositories found', ''));
    return;
  }
  for (const repo of repos) {
    const option = new Option(`${repo.fullName}${repo.private ? '  · private' : ''}`, repo.fullName);
    els.repoSelect.append(option);
  }
  if (selectedFullName && repos.some((repo) => repo.fullName === selectedFullName)) {
    els.repoSelect.value = selectedFullName;
  }
}

async function connectGitHub(token, { silent = false } = {}) {
  if (!token) {
    setPill(els.githubState, 'Not connected');
    els.repoSection.hidden = true;
    return;
  }

  setPill(els.githubState, 'Checking…', 'busy');
  const user = await github.getUser(token);
  repos = await github.listRepos(token);

  setPill(els.githubState, `@${user.login}`, 'ok');
  els.repoSection.hidden = false;

  const { github: stored } = await getState();
  renderRepos(stored.owner && stored.repo ? `${stored.owner}/${stored.repo}` : null);
  await patch('github', { token, login: user.login });

  if (!silent) setStatus(`Connected as @${user.login}.`, 'ok');
}

/**
 * Renders the curated quick picks. The <select> below stays the single source of
 * truth for the chosen model; these radios just drive it.
 */
function renderModelPicks(models, selected) {
  const picks = recommendedModels(models);
  els.groqPicks.textContent = '';

  if (!picks.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No recommended models in this account — choose one below.';
    els.groqPicks.append(hint);
    els.groqMore.open = true;
    return;
  }

  picks.forEach((pick, index) => {
    const label = document.createElement('label');
    label.className = 'pick';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'groq-pick';
    radio.value = pick.id;
    radio.checked = pick.id === selected;
    radio.addEventListener('change', () => {
      els.groqModel.value = pick.id;
    });

    const body = document.createElement('div');
    body.className = 'pick__body';

    const title = document.createElement('div');
    title.className = 'pick__title';
    title.append(pick.label);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'pick__badge';
      badge.textContent = 'Recommended';
      title.append(badge);
    }

    const id = document.createElement('div');
    id.className = 'pick__id';
    id.textContent = pick.id;

    const blurb = document.createElement('div');
    blurb.className = 'pick__blurb';
    blurb.textContent = pick.blurb;

    body.append(title, id, blurb);
    label.append(radio, body);
    els.groqPicks.append(label);
  });

  // A model picked from the full list is not one of the three: show why nothing
  // is highlighted by leaving the disclosure open.
  els.groqMore.open = !picks.some((pick) => pick.id === selected);
}

/** Keeps the radios in step when the model is changed from the full list. */
function syncPicksTo(modelId) {
  for (const radio of els.groqPicks.querySelectorAll('input[type="radio"]')) {
    radio.checked = radio.value === modelId;
  }
}

async function loadGroqModels(apiKey, selected) {
  const models = await listModels(apiKey);

  els.groqModel.innerHTML = '';
  for (const model of models) {
    els.groqModel.append(new Option(model.id, model.id));
  }
  // Keep a saved model that Groq no longer lists, so saving does not silently
  // switch the user to a different one.
  if (selected && !models.some((model) => model.id === selected)) {
    els.groqModel.append(new Option(`${selected} (unavailable)`, selected));
  }

  const picks = recommendedModels(models);
  // A fresh install has never chosen a model; start it on the best available one.
  const resolved =
    selected && (models.some((model) => model.id === selected) || selected !== DEFAULT_MODEL)
      ? selected
      : picks[0]?.id || models[0]?.id || DEFAULT_MODEL;

  els.groqModel.value = resolved;
  renderModelPicks(models, resolved);
  return models.length;
}

async function restore() {
  const state = await getState();

  els.githubToken.value = state.github.token;
  els.groqKey.value = state.groq.apiKey;

  els.prefEnabled.checked = state.settings.enabled;
  els.prefAi.checked = state.settings.aiReadme;
  els.prefIndex.checked = state.settings.updateIndex;
  els.prefFocus.checked = state.settings.focusMode;
  els.prefFolder.value = state.settings.folderStyle;

  els.backfillPrefer.value = state.backfill.options.preferEarliest ? 'earliest' : 'latest';
  els.backfillSkip.checked = state.backfill.options.skipExisting;
  els.backfillAi.checked = state.backfill.options.aiReadme;
  renderBackfill(state.backfill);

  // Offer the saved model immediately; the full list arrives once the key verifies.
  els.groqModel.append(new Option(state.groq.model, state.groq.model));
  els.groqModel.value = state.groq.model;

  if (state.github.token) {
    try {
      await connectGitHub(state.github.token, { silent: true });
    } catch (error) {
      setPill(els.githubState, 'Token rejected', 'error');
    }
  }

  if (state.groq.apiKey) {
    try {
      await loadGroqModels(state.groq.apiKey, state.groq.model);
      setPill(els.groqState, 'Verified', 'ok');
    } catch {
      setPill(els.groqState, 'Key rejected', 'error');
    }
  }
}

async function save() {
  const selected = els.repoSelect.value;
  const repo = repos.find((item) => item.fullName === selected);

  await patch('github', {
    token: els.githubToken.value.trim(),
    ...(repo
      ? { owner: repo.owner, repo: repo.name, branch: repo.defaultBranch || 'main' }
      : {}),
  });

  await patch('groq', {
    apiKey: els.groqKey.value.trim(),
    model: els.groqModel.value || DEFAULT_MODEL,
  });

  await patch('settings', {
    enabled: els.prefEnabled.checked,
    aiReadme: els.prefAi.checked,
    updateIndex: els.prefIndex.checked,
    focusMode: els.prefFocus.checked,
    folderStyle: els.prefFolder.value,
  });

  setStatus(repo ? `Saved. Syncing to ${repo.fullName}.` : 'Saved.', 'ok');
}

els.githubConnect.addEventListener(
  'click',
  withBusy(els.githubConnect, 'Connecting…', () => connectGitHub(els.githubToken.value.trim())),
);

els.repoRefresh.addEventListener(
  'click',
  withBusy(els.repoRefresh, '…', async () => {
    repos = await github.listRepos(els.githubToken.value.trim());
    renderRepos(els.repoSelect.value);
    setStatus(`Found ${repos.length} repositories.`, 'ok');
  }),
);

els.repoCreate.addEventListener(
  'click',
  withBusy(els.repoCreate, 'Creating…', async () => {
    const name = els.repoNewName.value.trim();
    if (!name) throw new Error('Give the repository a name.');

    const created = await github.createRepo(
      els.githubToken.value.trim(),
      name,
      els.repoNewPrivate.checked,
    );
    repos = [created, ...repos];
    renderRepos(created.fullName);
    setStatus(`Created ${created.fullName}. Save to start syncing there.`, 'ok');
  }),
);

els.groqVerify.addEventListener(
  'click',
  withBusy(els.groqVerify, 'Verifying…', async () => {
    const key = els.groqKey.value.trim();
    if (!key) throw new Error('Paste a Groq API key first.');

    setPill(els.groqState, 'Checking…', 'busy');
    try {
      const count = await loadGroqModels(key, els.groqModel.value);
      setPill(els.groqState, 'Verified', 'ok');
      setStatus(`Groq key works — ${count} models available.`, 'ok');
    } catch (error) {
      setPill(els.groqState, 'Key rejected', 'error');
      throw error;
    }
  }),
);

els.groqModel.addEventListener('change', () => syncPicksTo(els.groqModel.value));

els.save.addEventListener('click', withBusy(els.save, 'Saving…', save));

/* ---------------------------------------------------------------- backfill */

const BACKFILL_PILL = {
  idle: ['Idle', null],
  scanning: ['Scanning…', 'busy'],
  pushing: ['Importing…', 'busy'],
  paused: ['Paused', 'busy'],
  done: ['Finished', 'ok'],
  error: ['Failed', 'error'],
};

function renderBackfill(backfill) {
  const [label, pillState] = BACKFILL_PILL[backfill.status] || BACKFILL_PILL.idle;
  setPill(els.backfillState, label, pillState);

  const active = backfill.status === 'scanning' || backfill.status === 'pushing';
  const paused = backfill.status === 'paused';

  els.backfillStart.hidden = active || paused;
  els.backfillStart.textContent = backfill.status === 'done' ? 'Import again' : 'Start import';
  els.backfillPause.hidden = !active;
  els.backfillResume.hidden = !paused;
  els.backfillCancel.hidden = !active && !paused;

  // Options are baked into a run when it starts; freeze them while it is going.
  for (const input of [els.backfillPrefer, els.backfillSkip, els.backfillAi]) {
    input.disabled = active || paused;
  }

  els.backfillProgress.hidden = backfill.status === 'idle';

  const scanning = backfill.status === 'scanning';
  els.backfillFill.dataset.indeterminate = String(scanning);
  if (!scanning) {
    const total = backfill.queue.length;
    const done = backfill.status === 'done' ? total : backfill.cursor;
    els.backfillFill.style.width = total ? `${(done / total) * 100}%` : '100%';
  } else {
    els.backfillFill.style.removeProperty('width');
  }

  const counts = [
    backfill.pushed ? `${backfill.pushed} imported` : null,
    backfill.skipped ? `${backfill.skipped} skipped` : null,
    backfill.failed.length ? `${backfill.failed.length} failed` : null,
  ].filter(Boolean);

  els.backfillMessage.textContent = [backfill.message, counts.join(' · ')]
    .filter(Boolean)
    .join(' — ');

  els.backfillFailures.hidden = backfill.failed.length === 0;
  els.backfillFailureList.textContent = '';
  for (const failure of backfill.failed) {
    const item = document.createElement('li');
    const slug = document.createElement('code');
    slug.textContent = failure.slug;
    item.append(slug, ` — ${failure.message}`);
    els.backfillFailureList.append(item);
  }
}

async function sendBackfill(type, options) {
  const result = await chrome.runtime.sendMessage({ type, options });
  if (!result?.ok) throw new Error(result?.message || 'Import command failed.');
  return result;
}

els.backfillStart.addEventListener(
  'click',
  withBusy(els.backfillStart, 'Starting…', async () => {
    // The run reads settings from storage, so persist any unsaved edits first.
    await save();
    await sendBackfill('BACKFILL_START', {
      preferEarliest: els.backfillPrefer.value === 'earliest',
      skipExisting: els.backfillSkip.checked,
      aiReadme: els.backfillAi.checked,
    });
  }),
);

els.backfillPause.addEventListener('click', () => sendBackfill('BACKFILL_PAUSE').catch(() => {}));
els.backfillResume.addEventListener('click', () => sendBackfill('BACKFILL_RESUME').catch(() => {}));
els.backfillCancel.addEventListener('click', () => sendBackfill('BACKFILL_CANCEL').catch(() => {}));

// The import runs in the service worker; this mirrors its progress live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.backfill) return;
  renderBackfill({ ...DEFAULTS.backfill, ...changes.backfill.newValue });
});

restore();
