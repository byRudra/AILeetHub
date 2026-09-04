/**
 * Isolated-world half of the content script pair.
 *
 * Receives accepted-submission events from interceptor.js (MAIN world), enriches
 * them with authoritative data from LeetCode's GraphQL API (same-origin, so the
 * user's session cookies apply), shows progress UI, and hands the finished record
 * to the service worker, which owns all GitHub and Groq calls.
 */
(() => {
  const CHANNEL = 'ailh:submission';
  const GRAPHQL = 'https://leetcode.com/graphql/';

  const inFlight = new Set();
  // Submission ids already pushed (or attempted). The interceptor reports the same
  // submission from several independent signals on purpose, so the winner runs and
  // the rest are dropped here.
  const handled = new Set();

  const debug = (() => {
    try {
      return localStorage.getItem('ailh:debug') === '1';
    } catch {
      return false;
    }
  })();
  const log = (...args) => debug && console.log('[AILeetHub/bridge]', ...args);

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

  const LATEST_SUBMISSION_QUERY = `
    query submissionList($questionSlug: String!) {
      questionSubmissionList(offset: 0, limit: 5, questionSlug: $questionSlug) {
        submissions { id statusDisplay timestamp }
      }
    }`;

  /* ------------------------------------------------------- judge result polling */

  /**
   * Asks the judge directly what happened to a submission.
   *
   * The interceptor can only report an "accepted" it happened to see go past. This
   * is the path that does not depend on LeetCode's result panel using any
   * particular transport: given a submission id from the submit call, we poll the
   * same endpoint the site polls, from the page's own origin so the session cookie
   * applies.
   */
  async function judge(submissionId) {
    const response = await fetch(`/submissions/detail/${submissionId}/check/`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Judge check returned ${response.status}`);
    return response.json();
  }

  const POLL_INTERVAL = 1200;
  const POLL_TIMEOUT = 90000;

  /**
   * Resolves to the terminal judge payload, or null if the submission never
   * settled. Silent by design: a rejected or still-running submission must not
   * raise a toast.
   */
  async function waitForVerdict(submissionId) {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (Date.now() < deadline) {
      let result = null;
      try {
        result = await judge(submissionId);
      } catch (error) {
        log('judge poll failed', error.message);
      }
      if (result?.state === 'SUCCESS') return result;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
    log('judge poll timed out', submissionId);
    return null;
  }

  /* ------------------------------------------------- LeetCode fetch proxy */

  /**
   * The service worker cannot call LeetCode directly: the session cookie is
   * SameSite, so a request from the extension's own origin arrives logged out.
   * Requests from this content script run in the page's origin and carry it, so
   * backfill routes every LeetCode call through here.
   */
  /**
   * Sorts a failed LeetCode response into 'auth' or 'throttle'.
   *
   * This distinction decides whether a backfill pauses for the user or simply
   * waits, so guessing is expensive. LeetCode overloads 403 for both a missing
   * session and aggressive paging, and it answers a logged-out API call with an
   * HTML login redirect rather than a status code — hence the body sniffing.
   */
  function classify(response, bodyText) {
    if (response.redirected && /\/accounts\/login/.test(response.url)) return 'auth';
    if (response.status === 401) return 'auth';
    if (response.status === 429) return 'throttle';

    const body = String(bodyText || '');
    if (response.status === 403) {
      if (/too many|rate|throttl|slow down/i.test(body)) return 'throttle';
      if (/login|signin|sign in|authenticat|permission/i.test(body)) return 'auth';
      // Bare 403 during a long run is far more often throttling than logout.
      return 'throttle';
    }
    if (response.status >= 500) return 'throttle';

    // An HTML body where JSON was expected means we were bounced to a login or
    // challenge page.
    if (/^\s*<(?:!doctype|html)/i.test(body)) return 'auth';
    return 'http';
  }

  const MESSAGES = {
    auth: 'LeetCode session expired — sign in again, then resume.',
    throttle: 'LeetCode is rate limiting requests.',
  };

  async function leetcodeFetch(message) {
    try {
      const response = message.graphql
        ? await fetch(GRAPHQL, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json', 'x-csrftoken': csrfToken() },
            body: JSON.stringify(message.graphql),
          })
        : await fetch(message.path, {
            credentials: 'include',
            headers: { accept: 'application/json' },
          });

      const text = await response.text();

      if (!response.ok) {
        const kind = classify(response, text);
        return {
          ok: false,
          kind,
          status: response.status,
          message: MESSAGES[kind] || `LeetCode returned ${response.status}`,
        };
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // 200 OK with HTML is the logged-out redirect.
        return { ok: false, kind: classify(response, text), message: MESSAGES.auth };
      }

      if (body.errors?.length) {
        const detail = body.errors[0].message || 'GraphQL error';
        const kind = /authenticat|permission|login|signin/i.test(detail) ? 'auth' : 'http';
        return { ok: false, kind, message: kind === 'auth' ? MESSAGES.auth : detail };
      }

      return { ok: true, data: message.graphql ? body.data : body };
    } catch (error) {
      // A dropped connection is worth retrying, not worth pausing for.
      return { ok: false, kind: 'throttle', message: error.message || 'LeetCode request failed.' };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Used by the service worker to confirm this script is live before backfilling.
    if (message?.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'LEETCODE_FETCH') {
      leetcodeFetch(message).then(sendResponse);
      return true;
    }

    return false;
  });

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

  /** Runs the push for a submission already known to be accepted. */
  async function sync(hints) {
    const { submissionId } = hints;
    if (inFlight.has(submissionId) || handled.has(submissionId)) return;
    inFlight.add(submissionId);

    try {
      // Undefined comes back if the service worker is gone (extension reloaded).
      const syncState = await chrome.runtime.sendMessage({ type: 'GET_SYNC_STATE' });
      if (!syncState?.enabled) {
        log('sync disabled or unconfigured', syncState);
        return;
      }

      handled.add(submissionId);
      toast('working', 'Collecting submission…');
      const submission = await collect(hints);

      toast('working', `Pushing ${submission.title}…`);
      const result = await chrome.runtime.sendMessage({ type: 'PUSH_SUBMISSION', submission });

      if (result?.ok) {
        toast('success', result.message || `Synced ${submission.title}`, result.htmlUrl);
      } else {
        // Let a failed push be retried by a later signal for the same submission.
        handled.delete(submissionId);
        toast('error', result?.message || 'Sync failed.');
      }
    } catch (error) {
      // An invalidated context means the extension was reloaded mid-flight.
      if (String(error?.message).includes('Extension context invalidated')) return;
      handled.delete(submissionId);
      console.error('[AILeetHub]', error);
      toast('error', error.message || 'Sync failed.');
    } finally {
      inFlight.delete(submissionId);
    }
  }

  /** A submit was observed; ask the judge how it turned out, then maybe push. */
  async function follow(submissionId) {
    if (inFlight.has(submissionId) || handled.has(submissionId)) return;
    // Reserve the id for the duration of the poll so the fast-path "accepted"
    // signal for the same submission does not start a second run.
    inFlight.add(submissionId);
    let verdict = null;
    try {
      verdict = await waitForVerdict(submissionId);
    } finally {
      inFlight.delete(submissionId);
    }

    if (!verdict) return;
    if (verdict.status_code !== 10 && verdict.status_msg !== 'Accepted') {
      log('not accepted', submissionId, verdict.status_msg);
      return;
    }

    await sync({
      submissionId,
      lang: verdict.lang || verdict.pretty_lang || null,
      code: typeof verdict.code === 'string' ? verdict.code : null,
      questionId: verdict.question_id != null ? String(verdict.question_id) : null,
      runtime: verdict.status_runtime || null,
      runtimePercentile: verdict.runtime_percentile ?? null,
      memory: verdict.status_memory || null,
      memoryPercentile: verdict.memory_percentile ?? null,
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.channel !== CHANNEL) return;

    log('received', event.data.kind, event.data.submissionId);
    if (event.data.kind === 'submitted') follow(event.data.submissionId);
    else if (event.data.kind === 'accepted') sync(event.data);
  });

  /* ------------------------------------------------------------- DOM fallback */

  /**
   * Last resort for when network interception sees nothing at all — LeetCode
   * swapping transports again, or the MAIN-world script losing the race to patch
   * `fetch`. The result banner is a stable, e2e-tagged hook, so an "Accepted" there
   * is trustworthy; the submission id it does not give us is recovered from the
   * user's own submission list.
   */
  async function latestAcceptedId() {
    const slug = slugFromLocation();
    if (!slug) return null;
    const data = await graphql(LATEST_SUBMISSION_QUERY, { questionSlug: slug });
    const submissions = data?.questionSubmissionList?.submissions || [];
    const accepted = submissions.find((item) => item.statusDisplay === 'Accepted');
    return accepted ? String(accepted.id) : null;
  }

  let domCheck = null;

  function onResultBanner() {
    const banner = document.querySelector('[data-e2e-locator="submission-result"]');
    if (!banner || !/^\s*Accepted/i.test(banner.textContent || '')) return;
    if (domCheck) return;

    // Give the interceptor a moment to win: it has the exact submission id, while
    // this path has to guess at "the most recent accepted one".
    domCheck = setTimeout(async () => {
      domCheck = null;
      try {
        const id = await latestAcceptedId();
        if (!id || handled.has(id) || inFlight.has(id)) return;
        log('DOM fallback firing for', id);
        await sync({ submissionId: id });
      } catch (error) {
        log('DOM fallback failed', error.message);
      }
    }, 4000);
  }

  // The editor mutates constantly while typing, so the selector runs on a timer
  // rather than on every mutation record.
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      onResultBanner();
    }, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });

  log('installed');
})();
