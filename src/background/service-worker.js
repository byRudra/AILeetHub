/**
 * Orchestrates a sync. The content scripts only observe and scrape; every call that
 * needs a secret (GitHub token, Groq key) happens here, so tokens never enter a
 * page's process.
 */

import { getState, patch, isConfigured } from '../lib/storage.js';
import * as github from '../lib/github.js';
import { explainSolution } from '../lib/groq.js';
import { buildProblemReadme, buildRootReadme, commitMessage } from '../lib/readme.js';
import { pathFor, primaryTopic } from '../lib/topics.js';
import { recordSolve } from '../lib/stats.js';

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

async function resolveBranch(state) {
  if (state.github.branch) return state.github.branch;
  const repo = await github.getRepo(state.github.token, state.github.owner, state.github.repo);
  const branch = repo.default_branch || 'main';
  await patch('github', { branch });
  return branch;
}

async function pushSubmission(submission) {
  const state = await getState();

  if (!isConfigured(state)) {
    return { ok: false, message: 'Connect a GitHub repository in AILeetHub settings first.' };
  }

  const branch = await resolveBranch(state);
  const paths = pathFor(submission, state.settings.folderStyle);
  const topic = primaryTopic(submission.topicTags).name;

  // The push must succeed even when Groq is off, unkeyed, rate-limited, or slow —
  // the README simply falls back to a template in that case.
  let explanation = null;
  let aiNote = '';
  if (state.settings.aiReadme && state.groq.apiKey) {
    try {
      explanation = await explainSolution(state.groq.apiKey, state.groq.model, submission);
    } catch (error) {
      console.warn('[AILeetHub] Groq explanation failed:', error.message);
      aiNote = ' (without AI notes)';
    }
  }

  const files = [
    { path: paths.solution, content: submission.code },
    { path: paths.readme, content: buildProblemReadme(submission, explanation) },
  ];

  const nextStats = recordSolve(state.stats, submission, { dir: paths.dir, topic });

  if (state.settings.updateIndex) {
    try {
      const existing = await github.getFileText(
        state.github.token,
        state.github.owner,
        state.github.repo,
        'README.md',
        branch,
      );
      files.push({ path: 'README.md', content: buildRootReadme(existing, nextStats.solved) });
    } catch (error) {
      // A failed index refresh should not cost the user their solution commit.
      console.warn('[AILeetHub] index update skipped:', error.message);
    }
  }

  const commit = await github.commitFiles(state.github.token, {
    owner: state.github.owner,
    repo: state.github.repo,
    branch,
    message: commitMessage(submission),
    files,
  });

  await patch('stats', nextStats);
  flashBadge('✓', '#2ecc71');

  return {
    ok: true,
    message: `Pushed ${submission.title}${aiNote}`,
    htmlUrl: commit.htmlUrl,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_SYNC_STATE') {
    getState().then((state) => {
      sendResponse({ enabled: state.settings.enabled && isConfigured(state) });
    });
    return true;
  }

  if (message?.type === 'PUSH_SUBMISSION') {
    pushSubmission(message.submission)
      .catch((error) => {
        console.error('[AILeetHub] push failed:', error);
        flashBadge('!', '#ff4d4f');
        return { ok: false, message: error.message || 'Push failed.' };
      })
      .then(sendResponse);
    // Keeps the message channel open for the async response.
    return true;
  }

  return false;
});
