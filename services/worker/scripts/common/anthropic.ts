/**
 * Shared Anthropic Messages API client — `fetch`-based, no SDK dependency.
 *
 * Used by NVI-07 `opus-teacher.ts` (distillation) and NVI-12 `opus-judge.ts`
 * (benchmark judging). Both previously hand-rolled the same fetch + header
 * set + JSON-fence stripping. Consolidated here so a header bump or error-
 * handling change lands in one place.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface AnthropicCallOpts {
  apiKey: string;
  model: string;
  system: string;
  userContent: string;
  maxTokens: number;
}

/** Strip optional `» ```json` / `» ```` fencing the model sometimes wraps its JSON in. */
export function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '').trim();
}

/**
 * Call the Anthropic Messages API and return the concatenated text content.
 * Throws on non-2xx responses with the first 500 bytes of the error body.
 */
export async function callAnthropicMessages(opts: AnthropicCallOpts): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.userContent }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const body = (await res.json()) as AnthropicMessagesResponse;
  return body.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n')
    .trim();
}

/** Convenience: call Anthropic and parse the response as JSON. */
export async function callAnthropicJson<T>(opts: AnthropicCallOpts): Promise<T> {
  const text = await callAnthropicMessages(opts);
  const jsonText = stripJsonFence(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (err) {
    throw new Error(`Anthropic response was not valid JSON: ${(err as Error).message}\n--\n${text.slice(0, 400)}`);
  }
}
