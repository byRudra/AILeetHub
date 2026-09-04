# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                              # all tests (node:test, zero dependencies)
node --test tests/logic.test.js       # one file
node --test --test-name-pattern "streak"   # one test by name
npm run icons                         # regenerate icons/ from tools/make-icons.mjs
npm run package                       # dist/aileethub-v<version>.zip for the web store
```

There is no bundler, transpiler, linter, or install step — `node_modules/` is empty by
design and `npm test` runs against the same files Chrome loads. Load the extension with
**Load unpacked** at `chrome://extensions` pointed at the repo root.

`package.json` exists only for the test/tooling scripts and to make Node treat `.js` as
ESM; Chrome ignores it. `npm run package` refuses to build when `package.json` and
`manifest.json` versions disagree — bump both.

Reloading the extension does **not** reload content scripts. After touching anything in
`src/content/`, reload at `chrome://extensions` *and* refresh the LeetCode tab.

## Architecture

A single data flow, split across three execution contexts by what each one is allowed
to touch:

```
LeetCode page (MAIN world)      interceptor.js   patches fetch + XHR
        │ window.postMessage
LeetCode page (ISOLATED world)  bridge.js        GraphQL enrich, toast UI,
        │                                        LeetCode fetch proxy
        │ chrome.runtime.sendMessage
Service worker (module)         service-worker.js  live sync
                                backfill.js        history import
```

**Why the split matters:** content scripts never see the GitHub token or Groq key.
Every call carrying a secret happens in the service worker. Keep it that way — do not
move `github.js` or `groq.js` calls into `src/content/`.

### Detection (`src/content/interceptor.js` + the poll in `bridge.js`)

The interceptor monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open`/`send`
in the page's own world (`"world": "MAIN"`, `run_at: document_start` — it must patch
before the page's first call). It has no `chrome.*` access and must stay a plain script
with no imports.

**Detection is deliberately redundant, because LeetCode has moved the result panel
between transports before and single-signal detection died silently when it did.** Three
signals go over one `window.postMessage` channel:

| Signal | Source | Role |
| --- | --- | --- |
| `submitted` | `POST …/submit/` → `submission_id` | **Load-bearing.** Fires on the request that *starts* every submission |
| `accepted` | `GET /submissions/detail/<id>/check/` → `SUCCESS` + `status_code 10` | Fast path |
| `accepted` | `POST /graphql/` `submissionDetails` → `statusCode 10` | Fast path |

`submitted` carries no verdict, so `bridge.js` polls the judge itself (`waitForVerdict`,
same-origin so the session cookie applies) and pushes only on an accept. That is what
makes detection survive a transport change: any future result mechanism still starts
with a `/submit/` call. The fast paths only skip the polling when they happen to fire.
A rejected submission and a poll timeout are both **silent** — no toast.

`bridge.js` also carries a DOM fallback for the case where interception sees nothing at
all: `[data-e2e-locator="submission-result"]` reading "Accepted" recovers the id from
`questionSubmissionList`. It waits 4s first so the interceptor, which knows the exact id,
wins. Dedupe across all four routes is the `handled`/`inFlight` pair keyed by submission id.

Set `localStorage['ailh:debug'] = '1'` on leetcode.com to trace both scripts.

### Enrichment (`src/content/bridge.js`)

Runs in the isolated world, so it has `chrome.*` *and* shares the page's cookies for
same-origin requests. It re-fetches authoritative data over LeetCode's GraphQL API
(`submissionDetails` for code/lang/perf, `questionData` for difficulty/tags/statement),
because the check endpoint's payload is inconsistent. Interceptor values are fallbacks
only. Requires the `csrftoken` cookie as an `x-csrftoken` header.

### Orchestration (`src/background/service-worker.js`)

`pushSubmission()` is the whole pipeline. Two invariants to preserve:

1. **A Groq failure must never cost the user their commit.** It is caught, the README
   falls back to a template, and the toast says "without AI notes".
2. **A root-README index failure must never cost the user their commit either** — same
   pattern, the index file is just dropped from the commit.

### History import (`src/lib/backfill.js`)

Imports already-solved problems, one commit each, **backdated to the original solve
time**. Four things here are load-bearing:

1. **All LeetCode calls are proxied through a tab.** LeetCode's session cookie is
   `SameSite`, so a `fetch` from the service worker's origin arrives signed out.
   `ensureTab()` finds or opens a leetcode.com tab and sends `LEETCODE_FETCH` to
   `bridge.js`, which performs the request in the page's origin. Do not "simplify" this
   into a direct fetch — it fails silently with an empty history rather than an error.
2. **Progress lives in storage, not memory.** An MV3 worker is killed when idle, so
   `backfill.status` / `cursor` / `queue` are persisted after every problem and a
   `chrome.alarms` tick restarts `tick()` where it stopped. The `running` module flag
   keeps two ticks from overlapping.
3. **The ref moves after every problem**, not once at the end. That costs one API call
   per problem and buys resumption against real history instead of orphaned commits.
4. **Backdating is the author date.** `createCommit` sends `author.date`/`committer.date`
   from the submission timestamp, and `recordSolve` takes `when` so the local heatmap
   agrees with the repo.

`mergeSubmissionPage` and `orderQueue` are pure and tested — they decide which
submission represents a problem (first accept = when you solved it) and the
oldest-first order.

**Failure handling is three-way, and the distinction is the whole design.** Getting it
wrong on a 600-problem history throws away the run:

| Class | Response | Why |
| --- | --- | --- |
| Auth (`AuthPause`) | Pause, focus the tab, **do not advance the cursor** | Recoverable and affects every remaining item |
| Throttle | Retry with backoff, widen `pace` permanently | LeetCode's tolerance varies; staying slow beats retrying |
| Per-problem | Record in `failed`, advance | One bad problem shouldn't stop the run |
| GitHub 401/403/404 | Stop the run | Will fail identically for everything left |

`bridge.js` classifies before backfill reacts (`classify()`): LeetCode overloads 403 for
both throttling and logout, and answers a logged-out API call with an **HTML login
redirect**, not a status code — so a bare 403 is read as throttling and an HTML body as
auth. Never collapse these back into "session expired"; that misreport is what made a
throttled run look like repeated logouts.

**Request budget matters here.** Per problem it is 1 LeetCode call (the scan captures
`code` from the dump when present, skipping `submissionDetails`) and 3 GitHub calls
(inline tree content instead of blob uploads, plus `cachedHead` avoiding a HEAD
re-resolve). That is down from 2 and 7. Anything that reintroduces a per-problem round
trip will bring the throttling back.

### Repo writes (`src/lib/github.js`)

Writes go through the Git Data API (blob → tree → commit → ref), not repeated
`PUT /contents` calls, so solution + README + index land as **one** commit. It is split
into `resolveHead` / `createCommit` / `setRef` so backfill can chain dated commits;
`commitFiles` is the one-shot wrapper for live syncs.

`resolveAuthor` matters for backfill: GitHub only counts a commit toward the
contribution graph when the author email belongs to the account, so it prefers the
public email, then a verified one, then the account's `@users.noreply.github.com`
address (which is account-bound and still counts). The 404 path
on `git/ref/heads/<branch>` means an empty repo and creates the ref instead of patching
it. `toBase64` chunks its input — `btoa(String.fromCharCode(...bytes))` blows the
argument limit on large files.

### Markdown (`src/lib/readme.js`)

`buildRootReadme` rewrites only the block between `<!-- AILEETHUB:START -->` and
`<!-- AILEETHUB:END -->`; anything the user wrote around it survives. In
`buildProblemReadme`, array entries use `null` for omitted blocks and `''` for
intentional blank lines — the filter drops `null` only, because blank lines are
semantic in Markdown.

### Layout rules (`src/lib/topics.js`)

`TOPIC_PRIORITY` is ordered most-specific-first because LeetCode returns topic tags in
arbitrary order — taking `topicTags[0]` would file DP problems under "Array". New tags
go in at the right specificity, not appended. `sanitizeSegment` strips characters Git
accepts but Windows cannot check out.

### State (`src/lib/storage.js`)

Five keys in `chrome.storage.local`: `github`, `groq`, `settings`, `stats`, `backfill`. Never
`chrome.storage.sync` — it would replicate the GitHub token and Groq key to every
machine on the browser profile. `getState()` merges stored values over `DEFAULTS`, so
new settings keys appear on upgrade without a migration.

`stats.solved` is keyed by `titleSlug` (re-solving updates in place); `stats.daily` is
keyed by **local** date, so streaks break at the user's midnight, not UTC's.

### UI

`src/popup/` (dashboard) and `src/options/` (setup) are extension pages with module
scripts, so they import `lib/` directly and call GitHub/Groq without going through the
service worker. The popup makes **no** network calls — every number is derived from
`stats`. Both are dark glassmorphic; shared token names (`--accent`, `--easy`,
`--medium`, `--hard`) are duplicated across the two stylesheets — change both.

CSP forbids inline scripts and remote resources on extension pages: no CDN, no inline
`onclick`, build DOM nodes rather than assigning untrusted `innerHTML`.

## Groq specifics

Groq is OpenAI-compatible at `https://api.groq.com/openai/v1`. Model IDs are retired
often, so nothing hard-codes a menu: `RECOMMENDED` holds regex matchers plus copy, and
`recommendedModels()` resolves them against the live `/models` response, dropping picks
that match nothing. Only the open-weight GPT OSS pair is curated — the rest of Groq's
catalogue is enterprise-gated or too small for a trustworthy complexity analysis, and
the full account listing stays reachable under "Use a different model".
The options page shows the curated picks as radio cards with the full list behind a
disclosure; the `<select>` remains the single source of truth and the radios just set it.

`DEFAULT_MODEL` (`openai/gpt-oss-120b`) only seeds a fresh install. A saved-but-delisted
model is kept marked `(unavailable)` so saving cannot silently switch models.

The picks are reasoning models, so `max_tokens` is roomy (thinking eats budget) and
`cleanExplanation` strips `<think>` blocks and whole-response fences. The system prompt
pins the README section structure (`## Intuition`, `## Approach`, `## Dry Run`,
`## Complexity`) — `readme.js` assumes those headings and owns the H1.

## Testing

- `logic.test.js` — pure modules (`topics`, `readme`, `stats`, base64)
- `backfill.test.js` — submission selection, queue ordering, historical dating
- `github.test.js` — request bodies against a stubbed `globalThis.fetch`; this is what
  pins the backdating, since a wrong author date is invisible until commits land on the
  wrong day
- `groq.test.js` — model ranking and response cleanup
- `manifest.test.js` — every referenced path exists, versions agree, world assignments
  are right, no `web_accessible_resources` leak

Anything touching `chrome.*` (tab proxying, alarms, storage) is untested — verify by
loading the extension. `classify()` in `bridge.js` is also untested: it lives inside a
content-script IIFE and is not importable. If it needs changing, lift it into `lib/`
first.
