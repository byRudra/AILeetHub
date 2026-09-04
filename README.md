# AILeetHub

Chrome extension that pushes your accepted LeetCode solutions to a GitHub repository,
organised by DSA topic, with a README written by **Groq**.

- **One commit per accepted submission** — solution file, problem README, and the
  repo index all land in a single commit.
- **Import your history** — backfill every problem you've already solved, each commit
  backdated to the moment you actually solved it.
- **Topic-based layout** — `Dynamic Programming/0322-coin-change/solution.py`.
- **AI explanations** — intuition, approach and complexity, written by GPT OSS 120B on Groq
  (or any other model your account can reach).
- **Repo index** — a solved-problems table maintained in the root README.
- **Dashboard** — streak, difficulty split, activity heatmap and recent syncs.
- **Focus mode** — optionally hides LeetCode's premium upsell banners.

Tokens and API keys are stored in `chrome.storage.local` on your machine only. The
extension talks to exactly three hosts: `leetcode.com`, `api.github.com`, `api.groq.com`.

## Install

No build step — the repository *is* the extension.

```bash
git clone <this repo>
cd AILeetHub
npm run icons        # only needed if icons/ is missing
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Requires Chrome 111+ (the interceptor uses a `MAIN`-world content script).

## Setup

The options page opens automatically on install (or via the popup's ⚙ button).

**1. GitHub** — paste a personal access token and click *Connect*:

- Fine-grained token with **Contents: Read and write** on the target repo, or
- Classic token with the **repo** scope

Then pick a repository, or create a new one from the same panel.

**2. Groq** — paste a key from [console.groq.com/keys](https://console.groq.com/keys)
and click *Verify*, then pick a model:

| Pick | When to use it |
| --- | --- |
| **GPT OSS 120B** *(default)* | Best quality. Strongest reasoning, so the complexity analysis is the most reliable. |
| **GPT OSS 20B** | Noticeably faster and lighter on rate limits. Fine for most write-ups. |
| **Qwen 3** | Alternative reasoning model — a useful second opinion on tricky solutions. |

Every other chat model on your account is available under *Use a different model*. The
list is resolved live against Groq's API, so a retired model ID never leaves a dead
option in the UI. This whole step is optional: without a key, READMEs are still
generated from a template.

**3. Preferences** — auto-sync, AI READMEs, repo index, focus mode, folder layout.

Solve a problem on LeetCode. When the judge returns *Accepted*, a toast appears in the
bottom-right and the commit link is one click away.

## Import your past solutions

Setup step 4 walks your entire LeetCode submission history and commits everything you
have already solved — **each commit backdated to the moment you actually solved it**,
so your contribution graph reflects real history rather than the day you installed this.

Choose which submission represents a problem:

- **First accepted** (default) — the date you actually solved it
- **Most recent accepted** — your latest, usually better, code

The import is resumable: it survives the service worker being suspended, and *Pause* /
*Resume* / *Cancel* work mid-run. Re-running it is safe — problems already in the repo
are skipped by default.

**If LeetCode signs you out mid-import**, the run pauses and focuses the LeetCode tab
instead of failing. Sign back in and press *Resume*; it continues from the problem it
stopped on, with nothing lost and nothing marked failed.

Large histories are paced adaptively: the delay between requests widens whenever
LeetCode throttles and narrows again after a clean streak, so a 600-problem import
settles into a rate the account tolerates rather than hammering until it gets blocked.

AI READMEs are **off** for imports by default: hundreds of sequential Groq calls will
hit rate limits. Turn it on only for a small history.

**For the contribution graph to light up**, GitHub requires that the commit's author
email belong to your account and that the repo is public (or that private contributions
are enabled on your profile). AILeetHub uses your account's verified email, falling
back to your `@users.noreply.github.com` address — both count.

Requires an open, signed-in leetcode.com tab: LeetCode's session cookie is `SameSite`,
so history requests have to originate from the page. One is opened automatically if
needed, and closed again afterwards.

## What gets committed

```
Dynamic Programming/
  0322-coin-change/
    solution.py
    README.md      # badge, tags, AI explanation, source, runtime/memory
README.md          # index table between <!-- AILEETHUB:START/END --> markers
```

Anything you write outside those index markers in the root README is preserved.

## Development

```bash
npm test             # logic + manifest tests (node:test, no dependencies)
npm run icons        # regenerate icons/ from tools/make-icons.mjs
npm run package      # dist/aileethub-v<version>.zip for the Chrome Web Store
```

After editing, hit reload on `chrome://extensions`. Reloading the service worker does
not reload content scripts — refresh the LeetCode tab too.

## Known limitations

- Detection hangs off LeetCode's `/submissions/detail/<id>/check/` polling endpoint.
  If LeetCode changes that flow, `src/content/interceptor.js` is the single place to fix.
- Focus-mode selectors target LeetCode's stable hooks, not its generated class names,
  so some upsell surfaces may survive.
- Groq failures never block a push — the solution is committed with a template README.
