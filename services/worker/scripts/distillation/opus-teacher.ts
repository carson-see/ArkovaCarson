/**
 * NVI-07 — Claude Opus teacher adapter (SCRUM-811).
 *
 * Production implementation of the `TeacherModel` interface. Calls the
 * Anthropic Messages API via `fetch` (no SDK dependency — keeps the worker
 * build lean). Uses the canonical FCRA distillation system prompt (see
 * `opus-system-prompt-fcra.md`) and the verified-source RAG context. The
 * caller is responsible for building the RAG context string — typically
 * the registry entries for the template's expectedSources.
 *
 * Tests MUST NOT import this module — use a MockTeacher instead. This
 * module requires `ANTHROPIC_API_KEY` at runtime.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { TeacherModel, VariationQuery } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
}

function loadSystemPrompt(): string {
  const p = resolve(__dirname, 'opus-system-prompt-fcra.md');
  return readFileSync(p, 'utf8');
}

export interface OpusTeacherOpts {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export function createOpusTeacher(opts: OpusTeacherOpts = {}): TeacherModel {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the Opus teacher');
  const model = opts.model ?? 'claude-opus-4-7';
  const maxTokens = opts.maxTokens ?? 1500;
  const systemPrompt = loadSystemPrompt();

  return {
    name: `opus:${model}`,
    async infer(v: VariationQuery, ragContext: string): Promise<IntelligenceAnswer> {
      const userContent =
        `# Verified source registry (RAG context)\n${ragContext}\n\n# Query\n${v.query}\n\n` +
        `Answer in the JSON schema from the system prompt. Do not include prose outside the JSON.`;

      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 500)}`);
      }

      const body = (await res.json()) as AnthropicMessagesResponse;
      const text = body.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
        .trim();

      const jsonText = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
      try {
        return JSON.parse(jsonText) as IntelligenceAnswer;
      } catch (err) {
        throw new Error(`teacher response was not valid JSON: ${(err as Error).message}\n--\n${text.slice(0, 400)}`);
      }
    },
  };
}
