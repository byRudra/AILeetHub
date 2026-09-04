/**
 * Markdown composition: the per-problem README and the repository index table.
 */

import { markdownLangFor, primaryTopic } from './topics.js';

const DIFFICULTY_COLOR = {
  Easy: '00b8a3',
  Medium: 'ffc01e',
  Hard: 'ff375f',
};

function difficultyBadge(difficulty) {
  const color = DIFFICULTY_COLOR[difficulty] || '8b8b93';
  return `![${difficulty}](https://img.shields.io/badge/Difficulty-${encodeURIComponent(difficulty)}-${color}?style=flat-square)`;
}

/** Used when Groq is disabled, unconfigured, or errored — the push still happens. */
function fallbackExplanation(submission) {
  const topics = (submission.topicTags || []).map((tag) => tag.name).join(', ') || 'n/a';
  return [
    '## Approach',
    '',
    `Accepted ${submission.difficulty.toLowerCase()} solution in ${submission.langLabel || submission.lang}.`,
    `Relevant topics: ${topics}.`,
    '',
    '## Complexity',
    '',
    '- **Time:** _not analysed_',
    '- **Space:** _not analysed_',
  ].join('\n');
}

/**
 * @param {object} submission Enriched submission record from the content script.
 * @param {string|null} explanation Groq-generated markdown, or null for the fallback.
 */
export function buildProblemReadme(submission, explanation) {
  const heading = submission.frontendId
    ? `# ${submission.frontendId}. ${submission.title}`
    : `# ${submission.title}`;

  const tags = (submission.topicTags || [])
    .map((tag) => `\`${tag.name}\``)
    .join(' · ');

  const stats = [];
  if (submission.runtime) {
    stats.push(
      `**Runtime** ${submission.runtime}` +
        (submission.runtimePercentile != null
          ? ` (beats ${submission.runtimePercentile.toFixed(1)}%)`
          : ''),
    );
  }
  if (submission.memory) {
    stats.push(
      `**Memory** ${submission.memory}` +
        (submission.memoryPercentile != null
          ? ` (beats ${submission.memoryPercentile.toFixed(1)}%)`
          : ''),
    );
  }

  // `null` marks an optional block; blank strings are meaningful in Markdown and
  // must survive the filter.
  return [
    heading,
    '',
    `${difficultyBadge(submission.difficulty)} [Open on LeetCode](${submission.problemUrl})`,
    tags ? '' : null,
    tags || null,
    '',
    explanation || fallbackExplanation(submission),
    '',
    `## Solution (${submission.langLabel || submission.lang})`,
    '',
    `\`\`\`${markdownLangFor(submission.lang)}`,
    submission.code,
    '```',
    '',
    stats.length ? '---' : null,
    stats.length ? '' : null,
    stats.length ? stats.join(' · ') : null,
    stats.length ? '' : null,
    `<sub>Synced by AILeetHub on ${new Date(submission.solvedAt).toISOString().slice(0, 10)}.</sub>`,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const INDEX_START = '<!-- AILEETHUB:START -->';
const INDEX_END = '<!-- AILEETHUB:END -->';

const DIFFICULTY_ORDER = { Easy: 0, Medium: 1, Hard: 2 };

function indexTable(solved) {
  const rows = Object.values(solved)
    .sort((a, b) => Number(a.frontendId || 0) - Number(b.frontendId || 0))
    .map((entry) => {
      const link = `[${entry.title}](${encodeURI(entry.dir)}/)`;
      return `| ${entry.frontendId || ''} | ${link} | ${entry.difficulty} | ${entry.topic} | ${entry.langLabel || entry.lang} |`;
    });

  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  for (const entry of Object.values(solved)) {
    if (counts[entry.difficulty] != null) counts[entry.difficulty] += 1;
  }

  const summary = Object.keys(counts)
    .sort((a, b) => DIFFICULTY_ORDER[a] - DIFFICULTY_ORDER[b])
    .map((key) => `${difficultyBadge(key)} ${counts[key]}`)
    .join('  ');

  return [
    `**${Object.keys(solved).length} problems solved**`,
    '',
    summary,
    '',
    '| # | Problem | Difficulty | Topic | Language |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Regenerates the index block inside the repo's root README, leaving anything the
 * user wrote outside the markers untouched.
 */
export function buildRootReadme(existing, solved) {
  const block = `${INDEX_START}\n\n${indexTable(solved)}\n\n${INDEX_END}`;

  if (existing && existing.includes(INDEX_START) && existing.includes(INDEX_END)) {
    const before = existing.slice(0, existing.indexOf(INDEX_START));
    const after = existing.slice(existing.indexOf(INDEX_END) + INDEX_END.length);
    return `${before}${block}${after}`;
  }

  const header = [
    '# LeetCode Solutions',
    '',
    '_Synced automatically from LeetCode by [AILeetHub](https://github.com/), with explanations written by Groq._',
    '',
  ].join('\n');

  return `${existing ? `${existing.trimEnd()}\n\n` : header}${block}\n`;
}

export function commitMessage(submission) {
  const topic = primaryTopic(submission.topicTags).name;
  const id = submission.frontendId ? `${submission.frontendId}. ` : '';
  const perf = submission.runtime ? ` — ${submission.runtime}` : '';
  return `[${submission.difficulty}] ${id}${submission.title} (${topic})${perf}`;
}
