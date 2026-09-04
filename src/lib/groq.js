/**
 * Groq client. Groq exposes an OpenAI-compatible surface, so this is a thin wrapper
 * over /openai/v1/chat/completions plus a live model listing.
 *
 * Model IDs on Groq are retired fairly often, so the options page fetches the list
 * from the API instead of relying on a hard-coded menu; DEFAULT_MODEL is only the
 * starting point for a fresh install.
 */

const BASE = 'https://api.groq.com/openai/v1';

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/**
 * The models offered as one-click picks, best first.
 *
 * Matched against the live /models response rather than hard-coded as IDs: Groq
 * renames and retires models, and a pick that resolves to nothing is hidden instead
 * of failing at generation time. `preferLatest` takes the highest-sorting match so
 * a family (Qwen 3.6 / 3.8) resolves to its newest member.
 */
export const RECOMMENDED = [
  {
    match: /gpt-oss-120b/i,
    label: 'GPT OSS 120B',
    blurb: 'Best quality. Strongest reasoning, so complexity analysis is the most reliable.',
  },
  {
    match: /gpt-oss-20b/i,
    label: 'GPT OSS 20B',
    blurb: 'Noticeably faster and lighter on rate limits. Good enough for most write-ups.',
  },
  {
    match: /qwen-?3/i,
    label: 'Qwen 3',
    blurb: 'Alternative reasoning model — a useful second opinion on tricky solutions.',
    preferLatest: true,
  },
];

/** Resolves RECOMMENDED against a live model list. Pure, so it is testable. */
export function recommendedModels(models) {
  const picks = [];

  for (const entry of RECOMMENDED) {
    const matches = models
      .filter((model) => entry.match.test(model.id))
      .filter((model) => !picks.some((pick) => pick.id === model.id));
    if (!matches.length) continue;

    const chosen = entry.preferLatest
      ? [...matches].sort((a, b) => a.id.localeCompare(b.id)).at(-1)
      : matches[0];

    picks.push({ id: chosen.id, label: entry.label, blurb: entry.blurb });
  }

  return picks;
}

export class GroqError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
  }
}

async function request(apiKey, path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body.error?.message || `Groq returned ${response.status}`;
    if (response.status === 401) {
      throw new GroqError('Groq rejected the API key. Check it in Settings.', 401);
    }
    if (response.status === 429) {
      throw new GroqError('Groq rate limit reached. The solution was still pushed.', 429);
    }
    throw new GroqError(detail, response.status);
  }

  return body;
}

/** Chat-capable models, newest-looking first. Used to populate the options page. */
export async function listModels(apiKey) {
  const body = await request(apiKey, '/models');
  return (body.data || [])
    .filter((model) => model.active !== false)
    // Speech, TTS and moderation models share this listing but cannot write prose.
    .filter((model) => !/whisper|tts|orpheus|guard|safety|moderation/i.test(model.id))
    .map((model) => ({ id: model.id, owner: model.owned_by, context: model.context_window }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function verifyKey(apiKey) {
  const models = await listModels(apiKey);
  return { ok: true, models };
}

/** Very small HTML-to-text pass so the prompt carries the problem statement cheaply. */
function htmlToText(html, limit = 4000) {
  if (!html) return '';
  const text = html
    .replace(/<sup>/g, '^')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const SYSTEM_PROMPT = `You are a senior engineer writing the explanation section of a LeetCode solution README.

Rules:
- Output GitHub-flavored Markdown only. No preamble, no sign-off, no code fences around the whole response.
- Start at heading level 2 (##). Never emit an H1.
- Use exactly these sections, in order: "## Intuition", "## Approach", "## Complexity".
- Under "## Complexity", give "- **Time:** O(...)" and "- **Space:** O(...)" with one clause of justification each.
- Describe the algorithm that the provided code actually implements. Do not propose a different solution.
- Be concise and concrete: aim for 150-250 words total. No filler, no restating the problem statement verbatim.
- Do not repeat the source code; it already appears elsewhere in the README.`;

/**
 * Generates the explanation body for a solution README.
 * Throws GroqError; callers decide whether to fall back to a template README.
 */
export async function explainSolution(apiKey, model, submission) {
  const topics = (submission.topicTags || []).map((tag) => tag.name).join(', ') || 'n/a';
  const statement = htmlToText(submission.descriptionHtml);

  const userPrompt = [
    `Problem: ${submission.frontendId}. ${submission.title} (${submission.difficulty})`,
    `Topics: ${topics}`,
    `Language: ${submission.langLabel || submission.lang}`,
    statement ? `\nProblem statement:\n${statement}` : '',
    `\nAccepted solution:\n\`\`\`\n${submission.code}\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n');

  const body = await request(apiKey, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      temperature: 0.3,
      // Reasoning models spend part of the budget thinking before the answer, so
      // this is deliberately roomier than the ~250 words the prompt asks for.
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new GroqError('Groq returned an empty explanation.', 502);

  return cleanExplanation(content);
}

/** Strips the two artefacts reasoning models leak into `content`. */
export function cleanExplanation(content) {
  return (
    content
      // Some reasoning models emit their scratchpad inline instead of in `reasoning`.
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?(?:think|thinking|reasoning)>/gi, '')
      // Others wrap the whole answer in a fence despite being told not to.
      .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/, '$1')
      .trim()
  );
}
