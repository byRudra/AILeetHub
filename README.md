# AILeetHub

Chrome extension that pushes your accepted LeetCode solutions to a GitHub repository,
organised by DSA topic, with a README written by **Groq**.

- **One commit per accepted submission** — solution file, problem README, and the
  repo index all land in a single commit.
- **Topic-based layout** — `Dynamic Programming/0322-coin-change/solution.py`.
- **AI explanations** — intuition, approach and complexity, via any chat model on Groq.
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
and click *Verify*. The model list is fetched live from Groq, so retired model IDs
never leave you with a broken dropdown. This step is optional: without a key, READMEs
are still generated from a template.

**3. Preferences** — auto-sync, AI READMEs, repo index, focus mode, folder layout.

Solve a problem on LeetCode. When the judge returns *Accepted*, a toast appears in the
bottom-right and the commit link is one click away.

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
