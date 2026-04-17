/**
 * NVI-07 — Claude Opus teacher adapter (SCRUM-811).
 *
 * Builds on the shared `scripts/common/anthropic.ts` client. Tests must
 * not import this module — use a `MockTeacher`. `ANTHROPIC_API_KEY` is
 * required at runtime.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { TeacherModel, VariationQuery } from './types';
import { callAnthropicJson } from '../common/anthropic';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Loaded once at module init — keeps the 5,000-call batch loop cheap. */
const SYSTEM_PROMPT = readFileSync(resolve(__dirname, 'opus-system-prompt-fcra.md'), 'utf8');

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

  return {
    name: `opus:${model}`,
    async infer(v: VariationQuery, ragContext: string): Promise<IntelligenceAnswer> {
      const userContent =
        `# Verified source registry (RAG context)\n${ragContext}\n\n# Query\n${v.query}\n\n` +
        `Answer in the JSON schema from the system prompt. Do not include prose outside the JSON.`;
      return callAnthropicJson<IntelligenceAnswer>({
        apiKey,
        model,
        system: SYSTEM_PROMPT,
        userContent,
        maxTokens,
      });
    },
  };
}
