/**
 * Dashboard popup. Reads only from chrome.storage — every number here is derived
 * from sync history the service worker has already written, so opening the popup
 * makes no network calls.
 */

import { getState, patch, isConfigured } from '../lib/storage.js';
import {
  computeStreak,
  difficultyCounts,
  heatmap,
  recentSolves,
} from '../lib/stats.js';

const $ = (id) => document.getElementById(id);

function renderDifficulty(counts) {
  const container = $('difficulty');
  container.textContent = '';
  const max = Math.max(1, ...Object.values(counts));

  for (const name of ['Easy', 'Medium', 'Hard']) {
    const row = document.createElement('div');
    row.className = 'bar-row';

    const label = document.createElement('span');
    label.className = 'bar-row__name';
    label.textContent = name;

    const track = document.createElement('div');
    track.className = 'bar-row__track';
    const fill = document.createElement('div');
    fill.className = 'bar-row__fill';
    fill.dataset.difficulty = name;
    fill.style.width = `${(counts[name] / max) * 100}%`;
    track.append(fill);

    const count = document.createElement('span');
    count.className = 'bar-row__count';
    count.textContent = counts[name];

    row.append(label, track, count);
    container.append(row);
  }
}

function renderHeatmap(daily) {
  const container = $('heatmap');
  container.textContent = '';

  for (const cell of heatmap(daily)) {
    const box = document.createElement('i');
    // Three buckets is enough resolution for a 360px popup.
    box.dataset.level = cell.count === 0 ? '0' : cell.count === 1 ? '1' : cell.count <= 3 ? '2' : '3';
    if (cell.future) box.dataset.future = 'true';
    box.title = `${cell.date}: ${cell.count} synced`;
    container.append(box);
  }
}

function renderRecent(solved) {
  const list = $('recent');
  list.textContent = '';
  const entries = recentSolves(solved);

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing synced yet — solve something on LeetCode.';
    list.append(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement('li');

    const link = document.createElement('a');
    link.href = `https://leetcode.com/problems/${entry.titleSlug}/`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = entry.frontendId ? `${entry.frontendId}. ${entry.title}` : entry.title;

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.difficulty = entry.difficulty;
    tag.textContent = entry.difficulty;

    item.append(link, tag);
    list.append(item);
  }
}

async function render() {
  const state = await getState();
  const configured = isConfigured(state);

  $('setup').hidden = configured;
  $('dashboard').hidden = !configured;

  $('toggle-enabled').checked = state.settings.enabled;

  if (configured) {
    const fullName = `${state.github.owner}/${state.github.repo}`;
    $('repo-label').textContent = fullName;
    const link = $('repo-link');
    link.href = `https://github.com/${fullName}`;
    link.hidden = false;

    const streak = computeStreak(state.stats.daily);
    $('stat-streak').textContent = streak.current;
    $('stat-best').textContent = streak.longest;
    $('stat-total').textContent = Object.keys(state.stats.solved).length;

    renderDifficulty(difficultyCounts(state.stats.solved));
    renderHeatmap(state.stats.daily);
    renderRecent(state.stats.solved);
  }
}

$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('setup-cta').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('toggle-enabled').addEventListener('change', (event) => {
  patch('settings', { enabled: event.target.checked });
});

render();
