/**
 * Hardened JSON parse for raw Nessie (fine-tuned Llama 3.1) model output.
 *
 * Nessie is exactly the class of model that Gemini Flash's parseModelJson
 * hardening (BUG-2026-06-24-014, gemini.ts) was written for: it routinely
 * wraps its JSON payload in ```json fences and occasionally appends trailing
 * prose/continuation tokens after the final `}`. A naked `JSON.parse` throws
 * SyntaxError on either shape, which previously surfaced as an unhandled
 * extraction failure from `NessieProvider.extractMetadata`.
 *
 * This mirrors gemini.ts's pipeline exactly (strip JS-style comments ->
 * strip markdown fence -> brace-salvage -> delimiter/trailing-comma repair)
 * as a Nessie-local equivalent, kept independent of gemini.ts so neither
 * provider's hardening path depends on the other's internals.
 */

import { stripJsonComments } from './strip-json-comments.js';

/**
 * Parses raw Nessie model text into a JSON object, recovering from markdown
 * code fences and truncated/trailing-prose responses. Throws if no
 * salvageable JSON object can be recovered.
 */
export function parseNessieJson(text: string): Record<string, unknown> {
  const cleaned = stripJsonComments(text).trim();
  const unfenced = stripMarkdownJsonFence(cleaned);

  try {
    return ensureJsonObject(JSON.parse(unfenced));
  } catch (initialError) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = unfenced.slice(start, end + 1);
      try {
        return ensureJsonObject(JSON.parse(candidate));
      } catch {
        return ensureJsonObject(JSON.parse(repairNessieJson(candidate)));
      }
    }
    const repaired = repairNessieJson(unfenced);
    if (repaired !== unfenced) return ensureJsonObject(JSON.parse(repaired));
    throw initialError;
  }
}

function repairNessieJson(text: string): string {
  const withoutControlChars = text
    .replace(/^\uFEFF/, '')
    // eslint-disable-next-line no-control-regex -- intentional: strip JSON-invalid control chars from model output
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const withoutTrailingCommas = withoutControlChars.replace(/,\s*([}\]])/g, '$1');
  const balanced = balanceJsonDelimiters(withoutTrailingCommas);
  return escapeBareNewlinesInStrings(balanced);
}

type JsonCharClass = 'escape-start' | 'escaped-char' | 'quote' | 'plain';

/** Classifies one char of the string/escape state machine shared by the delimiter and newline repairs below. */
function classifyJsonChar(
  char: string,
  state: { inString: boolean; escaped: boolean },
): JsonCharClass {
  if (state.escaped) {
    state.escaped = false;
    return 'escaped-char';
  }
  if (char === '\\') {
    state.escaped = true;
    return 'escape-start';
  }
  if (char === '"') {
    state.inString = !state.inString;
    return 'quote';
  }
  return 'plain';
}

function balanceJsonDelimiters(text: string): string {
  const state = { inString: false, escaped: false };
  const stack: string[] = [];

  for (const char of text) {
    const charClass = classifyJsonChar(char, state);
    if (charClass !== 'plain' || state.inString) continue;
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if ((char === '}' || char === ']') && stack.at(-1) === char) stack.pop();
  }

  stack.reverse();
  return text + stack.join('');
}

function escapeBareNewlinesInStrings(text: string): string {
  const state = { inString: false, escaped: false };
  let out = '';

  for (const char of text) {
    const charClass = classifyJsonChar(char, state);
    if (charClass === 'plain' && state.inString && char === '\n') {
      out += String.raw`\n`;
    } else if (charClass === 'plain' && state.inString && char === '\r') {
      out += String.raw`\r`;
    } else {
      out += char;
    }
  }

  return out;
}

function stripMarkdownJsonFence(cleaned: string): string {
  if (!cleaned.startsWith('```')) return cleaned;

  const firstLineBreak = cleaned.indexOf('\n');
  const withoutOpeningFence = firstLineBreak >= 0
    ? cleaned.slice(firstLineBreak + 1)
    : cleaned.slice(3);
  const trimmed = withoutOpeningFence.trim();

  return trimmed.endsWith('```')
    ? trimmed.slice(0, -3).trim()
    : trimmed;
}

function ensureJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Nessie extraction response was not a JSON object');
}
