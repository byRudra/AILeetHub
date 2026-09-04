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
LeetCode page (ISOLATED world)  bridge.js        GraphQL enrich + toast UI
        │ chrome.runtime.sendMessage
Service worker (module)         service-worker.js  Groq + GitHub + storage
```

**Why the split matters:** content scripts never see the GitHub token or Groq key.
Every call carrying a secret happens in the service worker. Keep it that way — do not
move `github.js` or `groq.js` calls into `src/content/`.

### Detection (`src/content/interceptor.js`)

LeetCode polls `GET /submissions/detail/<id>/check/` until the judge returns
`state === "SUCCESS"`. That response is the only reliable "accepted" signal, so the
interceptor monkey-patches `window.fetch` and `XMLHttpRequest.prototype.open` in the
page's own world (`"world": "MAIN"`, `run_at: document_start` — it must patch before
the page's first call). It has no `chrome.*` access and must stay a plain script with
no imports.

**If syncing silently stops working, this file is almost always the cause.** It is the
one place coupled to LeetCode's private API.

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

### Repo writes (`src/lib/github.js`)

Writes go through the Git Data API (blob → tree → commit → ref), not repeated
`PUT /contents` calls, so solution + README + index land as **one** commit. The 404 path
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

Four keys in `chrome.storage.local`: `github`, `groq`, `settings`, `stats`. Never
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
often, so the options page fetches `/models` live rather than hard-coding a menu;
`DEFAULT_MODEL` only seeds a fresh install. A saved-but-delisted model is kept in the
dropdown marked `(unavailable)` so saving cannot silently switch models. The system
prompt pins the README section structure (`## Intuition`, `## Approach`, `## Complexity`)
— `readme.js` assumes those headings and owns the H1.

## Testing

`tests/logic.test.js` covers the pure modules (`topics`, `readme`, `stats`, base64).
`tests/manifest.test.js` asserts every manifest-referenced path exists, versions agree,
world assignments are right, and no `web_accessible_resources` leak. Anything touching
`chrome.*` or the network is untested — verify those by loading the extension.
