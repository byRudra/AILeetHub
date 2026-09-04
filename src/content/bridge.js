/**
 * Isolated-world half of the content script pair.
 *
 * Receives accepted-submission events from interceptor.js (MAIN world), enriches
 * them with authoritative data from LeetCode's GraphQL API (same-origin, so the
 * user's session cookies apply), shows progress UI, and hands the finished record
 * to the service worker, which owns all GitHub and Groq calls.
 */
(() => {
  const CHANNEL = 'ailh:submission-accepted';
  const GRAPHQL = 'https://leetcode.com/graphql/';

  const inFlight = new Set();

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? match[1] : '';
  }

  async function graphql(query, variables) {
    const response = await fetch(GRAPHQL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrftoken': csrfToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`LeetCode GraphQL returned ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors[0].message || 'GraphQL error');
    return body.data;
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

  function slugFromLocation() {
    const match = location.pathname.match(/\/problems\/([^/]+)/);
    return match ? match[1] : null;
  }

  async function collect(event) {
    let details = null;
    try {
      const data = await graphql(SUBMISSION_QUERY, { submissionId: Number(event.submissionId) });
      details = data?.submissionDetails ?? null;
    } catch (error) {
      console.warn('[AILeetHub] submissionDetails unavailable:', error.message);
    }

    const titleSlug = details?.question?.titleSlug || slugFromLocation();
    if (!titleSlug) throw new Error('Could not determine which problem this was.');

    let question = null;
    try {
      const data = await graphql(QUESTION_QUERY, { titleSlug });
      question = data?.question ?? null;
    } catch (error) {
      console.warn('[AILeetHub] questionData unavailable:', error.message);
    }

    const code = details?.code || event.code;
    if (!code) {
      throw new Error('Solution source was not returned by LeetCode. Try syncing from the submission page.');
    }

    return {
      submissionId: event.submissionId,
      titleSlug,
      title: question?.title || details?.question?.title || titleSlug,
      // questionFrontendId is the number shown on the site; questionId is internal.
      frontendId: question?.questionFrontendId || details?.question?.questionId || event.questionId || '',
      difficulty: question?.difficulty || details?.question?.difficulty || 'Unknown',
      topicTags: question?.topicTags || [],
      descriptionHtml: question?.content || '',
      code,
      lang: details?.lang?.name || event.lang || 'text',
      langLabel: details?.lang?.verboseName || event.lang || '',
      runtime: details?.runtimeDisplay || event.runtime || '',
      runtimePercentile: details?.runtimePercentile ?? event.runtimePercentile ?? null,
      memory: details?.memoryDisplay || event.memory || '',
      memoryPercentile: details?.memoryPercentile ?? event.memoryPercentile ?? null,
      problemUrl: `https://leetcode.com/problems/${titleSlug}/`,
      solvedAt: (details?.timestamp ? details.timestamp * 1000 : Date.now()),
    };
  }

  /* ---------------------------------------------------------------- toast UI */

  let toastEl = null;
  let hideTimer = null;

  function toast(state, message, link) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ailh-toast';
      document.documentElement.appendChild(toastEl);
    }
    clearTimeout(hideTimer);
    toastEl.dataset.state = state;
    toastEl.innerHTML = '';

    const dot = document.createElement('span');
    dot.className = 'ailh-toast__dot';
    const text = document.createElement('span');
    text.className = 'ailh-toast__text';
    text.textContent = message;
    toastEl.append(dot, text);

    if (link) {
      const anchor = document.createElement('a');
      anchor.className = 'ailh-toast__link';
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.textContent = 'View';
      toastEl.append(anchor);
    }

    toastEl.classList.add('ailh-toast--visible');
    if (state !== 'working') {
      hideTimer = setTimeout(() => toastEl.classList.remove('ailh-toast--visible'), 6000);
    }
  }

  /* ------------------------------------------------------------------ wiring */

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    const { submissionId } = event.data;
    if (inFlight.has(submissionId)) return;
    inFlight.add(submissionId);

    try {
      // Undefined comes back if the service worker is gone (extension reloaded).
      const syncState = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      if (!syncState?.enabled) return;

      toast('working', 'Collecting submission…');
      const submission = await collect(event.data);

      toast('working', `Pushing ${submission.title}…`);
      const result = await chrome.runtime.sendMessage({ type: 'PUSH_SUBMISSION', submission });

      if (result?.ok) {
        toast('success', result.message || `Synced ${submission.title}`, result.htmlUrl);
      } else {
        toast('error', result?.message || 'Sync failed.');
      }
    } catch (error) {
      // An invalidated context means the extension was reloaded mid-flight.
      if (String(error?.message).includes('Extension context invalidated')) return;
      console.error('[AILeetHub]', error);
      toast('error', error.message || 'Sync failed.');
    } finally {
      inFlight.delete(submissionId);
    }
  });
})();
