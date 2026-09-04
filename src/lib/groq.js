/**
 * Groq client. Groq exposes an OpenAI-compatible surface, so this is a thin wrapper
 * over /openai/v1/chat/completions plus a live model listing.
 *
 * Model IDs on Groq are retired fairly often, so the options page fetches the list
 * from the API instead of relying on a hard-coded menu; DEFAULT_MODEL is only the
 * starting point for a fresh install.
 */

const BASE = 'https://api.groq.com/openai/v1';

export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

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
    // Whisper/TTS models share the endpoint listing but cannot do chat completion.
    .filter((model) => !/whisper|tts|guard|prompt-guard/i.test(model.id))
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
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new GroqError('Groq returned an empty explanation.', 502);

  // Some models wrap the whole answer in a markdown fence despite the instruction.
  return content.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/m, '$1').trim();
}
