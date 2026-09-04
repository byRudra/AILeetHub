/**
 * Setup page. Runs as an extension page, so it holds host permissions for both
 * api.github.com and api.groq.com and can call the API clients directly instead of
 * routing verification through the service worker.
 */

import { getState, patch } from '../lib/storage.js';
import * as github from '../lib/github.js';
import { listModels, DEFAULT_MODEL } from '../lib/groq.js';

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
  prefEnabled: $('pref-enabled'),
  prefAi: $('pref-ai'),
  prefIndex: $('pref-index'),
  prefFocus: $('pref-focus'),
  prefFolder: $('pref-folder'),
  save: $('save'),
  status: $('status'),
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
  els.groqModel.value = selected || DEFAULT_MODEL;
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

els.save.addEventListener('click', withBusy(els.save, 'Saving…', save));

restore();
