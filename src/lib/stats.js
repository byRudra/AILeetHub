/**
 * Derived statistics for the popup dashboard.
 *
 * All dates are keyed in the user's local timezone — a streak should break at the
 * user's midnight, not UTC's.
 */

export function dateKey(date = new Date()) {
  const local = new Date(date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  return local.toISOString().slice(0, 10);
}

function shiftDays(key, delta) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + delta);
  return dateKey(date);
}

/**
 * Adds (or refreshes) one solved problem. Re-syncing the same problem updates the
 * record in place but still counts as activity for the day.
 *
 * `when` (epoch ms) defaults to now for live syncs; backfill passes the original
 * solve time so imported problems land on the right day of the heatmap.
 */
export function recordSolve(stats, submission, { dir, topic, when = Date.now() }) {
  const solved = { ...stats.solved };
  const daily = { ...stats.daily };
  const key = dateKey(new Date(when));

  solved[submission.titleSlug] = {
    titleSlug: submission.titleSlug,
    title: submission.title,
    frontendId: submission.frontendId,
    difficulty: submission.difficulty,
    topic,
    lang: submission.lang,
    langLabel: submission.langLabel,
    dir,
    syncedAt: when,
  };
  daily[key] = (daily[key] || 0) + 1;

  return { solved, daily };
}

export function computeStreak(daily) {
  const today = dateKey();
  let cursor = daily[today] ? today : shiftDays(today, -1);

  let current = 0;
  while (daily[cursor]) {
    current += 1;
    cursor = shiftDays(cursor, -1);
  }

  const keys = Object.keys(daily).filter((key) => daily[key] > 0).sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const key of keys) {
    run = previous && shiftDays(previous, 1) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }

  return { current, longest };
}

export function difficultyCounts(solved) {
  const counts = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  for (const entry of Object.values(solved)) {
    const key = counts[entry.difficulty] != null ? entry.difficulty : 'Unknown';
    counts[key] += 1;
  }
  return counts;
}

export function topicCounts(solved, limit = 6) {
  const counts = new Map();
  for (const entry of Object.values(solved)) {
    counts.set(entry.topic, (counts.get(entry.topic) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/** Contribution-graph cells, oldest first, aligned so each column is one week. */
export function heatmap(daily, weeks = 17) {
  const cells = [];
  const today = new Date();
  // Pad forward to Saturday so the final column is a complete week.
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));

  for (let i = weeks * 7 - 1; i >= 0; i -= 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    const key = dateKey(date);
    cells.push({ date: key, count: daily[key] || 0, future: date > today });
  }
  return cells;
}

export function recentSolves(solved, limit = 5) {
  return Object.values(solved)
    .sort((a, b) => b.syncedAt - a.syncedAt)
    .slice(0, limit);
}
