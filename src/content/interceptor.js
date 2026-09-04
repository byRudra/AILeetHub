/**
 * Runs in the page's MAIN world so it can see LeetCode's own network traffic.
 *
 * LeetCode submits code, then polls GET /submissions/detail/<id>/check/ until the
 * judge returns state === "SUCCESS". That response is the only reliable signal that
 * a submission was accepted, so we tap both fetch and XMLHttpRequest and forward
 * accepted submissions to the isolated-world bridge via window.postMessage.
 *
 * This file must not import anything: content scripts in the MAIN world are plain
 * scripts and have no access to the chrome.* APIs.
 */
(() => {
  const CHANNEL = 'ailh:submission-accepted';
  const CHECK_URL = /\/submissions\/detail\/(\d+)\/check\/?/;

  const seen = new Set();

  function report(submissionId, result) {
    // The judge can return the same terminal payload on several polls; only the
    // first one should trigger a push.
    if (seen.has(submissionId)) return;
    seen.add(submissionId);

    window.postMessage(
      {
        channel: CHANNEL,
        submissionId,
        // Everything below is best-effort; the bridge re-fetches authoritative
        // data over GraphQL and treats these as fallbacks.
        lang: result.lang || result.pretty_lang || null,
        code: typeof result.code === 'string' ? result.code : null,
        questionId: result.question_id != null ? String(result.question_id) : null,
        runtime: result.status_runtime || null,
        runtimePercentile: result.runtime_percentile ?? null,
        memory: result.status_memory || null,
        memoryPercentile: result.memory_percentile ?? null,
        totalCorrect: result.total_correct ?? null,
        totalTestcases: result.total_testcases ?? null,
        url: location.href,
      },
      location.origin,
    );
  }

  function inspect(url, bodyText) {
    const match = typeof url === 'string' && url.match(CHECK_URL);
    if (!match) return;

    let result;
    try {
      result = JSON.parse(bodyText);
    } catch {
      return;
    }
    if (!result || result.state !== 'SUCCESS') return;
    if (result.status_msg !== 'Accepted') return;

    report(String(result.submission_id ?? match[1]), result);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    return nativeFetch.apply(this, arguments).then((response) => {
      if (url && CHECK_URL.test(url)) {
        // Clone so the page still gets an unread body.
        response
          .clone()
          .text()
          .then((text) => inspect(url, text))
          .catch(() => {});
      }
      return response;
    });
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ailhUrl = url;
    if (typeof url === 'string' && CHECK_URL.test(url)) {
      this.addEventListener('load', () => {
        // responseType 'json' exposes the parsed object instead of responseText.
        try {
          const body =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : JSON.stringify(this.response);
          inspect(url, body);
        } catch {
          /* ignore */
        }
      });
    }
    return nativeOpen.apply(this, arguments);
  };
})();
