# Screenshots & GIFs

Drop the following files into this folder using these exact names — the root
`README.md` already references them, so they'll appear automatically once
added, with no other edits needed.

| File | Type | What to capture | Status |
| --- | --- | --- | --- |
| `options-github.png` | Screenshot | The options page's GitHub panel — token connected, repo selected. | ✅ done |
| `options-groq.png` | Screenshot | The options page's Groq panel — key verified, model picker. | ✅ done |
| `options-preferences.png` | Screenshot | The options page's Preferences panel — sync, AI READMEs, index, focus mode, folder layout. | ✅ done |
| `options-import.png` | Screenshot | The options page's Import panel after a backfill run — progress bar and result count. | ✅ done |
| `sync-toast.gif` | GIF | Solve a problem on LeetCode, get **Accepted**, and record the toast that appears bottom-right with the commit link. | still wanted |
| `popup-dashboard.png` | Screenshot | The extension popup: streak, difficulty split, activity heatmap, recent syncs. | still wanted |
| `problem-readme.png` | Screenshot | A generated per-problem `README.md` on GitHub — Intuition / Approach / Complexity sections. | still wanted |

## How to capture

- **Screenshots**: `Win+Shift+S` (Windows) or the OS screenshot tool, crop tight
  to the panel, PNG format.
- **GIFs**: [ScreenToGif](https://www.screentogif.com/) or ShareX both work
  well on Windows and keep file size low. Aim for under 5 seconds and under
  3 MB so the README loads fast on GitHub.
- Redact your GitHub username/repo name and any token/key values before
  saving, if you'd rather not show them.

Once the files land here, commit and push:

```bash
git add screenshots/
git commit -m "Add screenshots and demo GIFs"
git push
```
