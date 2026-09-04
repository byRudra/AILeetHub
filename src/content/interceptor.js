/**
 * Runs in the page's MAIN world so it can see LeetCode's own network traffic.
 *
 * There is no single endpoint that reliably means "accepted", because LeetCode has
 * moved the result panel between transports more than once. So this taps three
 * independent signals and lets the bridge decide:
 *
 *   submitted  POST /problems/<slug>/submit/   -> { submission_id }
 *   accepted   GET  /submissions/detail/<id>/check/ -> state SUCCESS + Accepted
 *   accepted   POST /graphql/ submissionDetails -> statusCode 10
 *
 * `submitted` is the load-bearing one: it fires on the request that *starts* every
 * submission, so even if LeetCode changes how results are polled the bridge still
 * has an id and can poll the judge itself. The other two are fast paths that skip
 * that polling when they happen to fire.
 *
 * This file must not import anything: content scripts in the MAIN world are plain
 * scripts and have no access to the chrome.* APIs.
 */
(() => {
  const CHANNEL = 'ailh:submission';
  const CHECK_URL = /\/submissions\/detail\/(\d+)\/check\/?/;
  const SUBMIT_URL = /\/submit\/?(?:\?|$)/;
  const GRAPHQL_URL = /\/graphql\/?(?:\?|$)/;

  const debug = (() => {
    try {
      return localStorage.getItem('ailh:debug') === '1';
    } catch {
      return false;
    }
  })();
  const log = (...args) => debug && console.log('[AILeetHub/interceptor]', ...args);

  // The judge returns the same terminal payload on several polls, and a submit can
  // be observed by both the fetch and the XHR patch. Key on kind+id so a fast-path
  // "accepted" is still delivered after its own "submitted".
  const seen = new Set();

  function post(kind, submissionId, extra) {
    const key = `${kind}:${submissionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    log('signal', key);
    window.postMessage(
      { channel: CHANNEL, kind, submissionId: String(submissionId), url: location.href, ...extra },
      location.origin,
    );
  }

  /** Best-effort fields from the judge; the bridge re-fetches authoritative data. */
  function fallbackFields(result) {
    return {
      lang: result.lang || result.pretty_lang || null,
      code: typeof result.code === 'string' ? result.code : null,
      questionId: result.question_id != null ? String(result.question_id) : null,
      runtime: result.status_runtime || null,
      runtimePercentile: result.runtime_percentile ?? null,
      memory: result.status_memory || null,
      memoryPercentile: result.memory_percentile ?? null,
    };
  }

  /** Normalizes every shape `fetch` accepts — string, URL, or Request — to a string. */
  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------- signal readers */

  function readSubmit(url, bodyText) {
    if (!SUBMIT_URL.test(url)) return;
    // /interpret_solution/ (the Run button) returns an interpret_id, not a
    // submission_id, so requiring the numeric field keeps test runs out.
    const body = parse(bodyText);
    const id = body && body.submission_id;
    if (id == null || !/^\d+$/.test(String(id))) return;
    post('submitted', id, {});
  }

  function readCheck(url, bodyText) {
    const match = url.match(CHECK_URL);
    if (!match) return;
    const result = parse(bodyText);
    if (!result || result.state !== 'SUCCESS') return;
    // status_code 10 is the machine-readable form of "Accepted"; older payloads
    // only carry status_msg, so accept either.
    const accepted = result.status_code === 10 || result.status_msg === 'Accepted';
    if (!accepted) return;
    post('accepted', String(result.submission_id ?? match[1]), fallbackFields(result));
  }

  function readGraphql(url, requestBody, bodyText) {
    if (!GRAPHQL_URL.test(url)) return;
    const request = parse(requestBody);
    if (request?.operationName !== 'submissionDetails') return;

    const details = parse(bodyText)?.data?.submissionDetails;
    if (!details || details.statusCode !== 10) return;

    const id = request.variables?.submissionId;
    if (id == null) return;
    post('accepted', String(id), {
      lang: details.lang?.name || null,
      code: typeof details.code === 'string' ? details.code : null,
      runtime: details.runtimeDisplay || null,
      runtimePercentile: details.runtimePercentile ?? null,
      memory: details.memoryDisplay || null,
      memoryPercentile: details.memoryPercentile ?? null,
    });
  }

  function inspect(url, requestBody, bodyText) {
    if (!url) return;
    try {
      readSubmit(url, bodyText);
      readCheck(url, bodyText);
      readGraphql(url, requestBody, bodyText);
    } catch (error) {
      log('inspect failed', error);
    }
  }

  /** Cheap pre-filter so we do not clone every response the page makes. */
  function interesting(url) {
    return CHECK_URL.test(url) || SUBMIT_URL.test(url) || GRAPHQL_URL.test(url);
  }

  /* -------------------------------------------------------------- fetch patch */

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = urlOf(input);
    // The body can live on the Request object rather than init, and reading it
    // there would consume the stream the page is about to send — so only the
    // plain-init case is inspected, which is what LeetCode's client uses.
    const requestBody = typeof init?.body === 'string' ? init.body : null;

    const response = nativeFetch.apply(this, arguments);
    if (!url || !interesting(url)) return response;

    return response.then((res) => {
      // Clone so the page still gets an unread body.
      res
        .clone()
        .text()
        .then((text) => inspect(url, requestBody, text))
        .catch(() => {});
      return res;
    });
  };

  /* ---------------------------------------------------------------- XHR patch */

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ailhUrl = typeof url === 'string' ? url : urlOf(url);
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__ailhUrl;
    if (url && interesting(url)) {
      // loadend rather than load: it also fires for the abort/error paths, and by
      // then responseText is settled regardless of which one happened.
      this.addEventListener('loadend', () => {
        try {
          // responseType 'json' exposes the parsed object instead of responseText.
          const text =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : JSON.stringify(this.response);
          inspect(url, typeof body === 'string' ? body : null, text);
        } catch (error) {
          log('xhr read failed', error);
        }
      });
    }
    return nativeSend.apply(this, arguments);
  };

  log('installed');
})();
