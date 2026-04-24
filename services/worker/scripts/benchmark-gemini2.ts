#!/usr/bin/env tsx
/**
 * GEMB2-01 — Gemini Embedding 2 benchmark harness (SCRUM-1050).
 *
 * Human-run. Requires GCP creds via `gcloud auth application-default login`
 * + GCP_PROJECT_ID env var. Writes a Markdown table to --out.
 *
 * Usage:
 *   npx tsx services/worker/scripts/benchmark-gemini2.ts --dim=768  --out=bench-768.md
 *   npx tsx services/worker/scripts/benchmark-gemini2.ts --dim=3072 --out=bench-3072.md
 *
 * The sampled corpus is read from `services/worker/scripts/fixtures/gemb2-bench.txt`
 * (one UTF-8 text per line). Keep it under 50 lines so a benchmark run
 * stays under ~$0.10.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGemini2Client, type GembDim } from '../src/ai/embeddings/gemini2.js';

interface Args {
  dim: GembDim;
  out: string;
  corpus: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined =>
    argv.find((a) => a.startsWith(`${flag}=`))?.split('=')[1];
  const dim = Number(get('--dim') ?? '768');
  if (![768, 1536, 3072].includes(dim)) {
    throw new Error(`Invalid --dim: ${dim}. Use 768 | 1536 | 3072.`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    dim: dim as GembDim,
    out: get('--out') ?? `bench-${dim}.md`,
    corpus: get('--corpus') ?? resolve(here, 'fixtures', 'gemb2-bench.txt'),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(args.corpus)) {
    throw new Error(
      `Corpus not found at ${args.corpus}. Create it (one text per line) before running.`,
    );
  }
  const lines = readFileSync(args.corpus, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Corpus is empty: ${args.corpus}`);
  }

  // Defer the SDK import so unit tests can skip google-auth-library entirely.
  const { GoogleAuth } = await import('google-auth-library');
  const googleAuth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = createGemini2Client({
    auth: {
      async getAccessToken(): Promise<string> {
        const token = await googleAuth.getAccessToken();
        if (!token) throw new Error('GoogleAuth returned no token');
        return token;
      },
    },
  });

  const latencies: number[] = [];
  let errors = 0;
  const startedAt = Date.now();
  for (const text of lines) {
    try {
      const res = await client.embed({ text, dim: args.dim });
      latencies.push(res.latencyMs);
    } catch (err) {
      errors += 1;
      console.error(`[skip] ${(err as Error).message.slice(0, 120)}`);
    }
  }
  const durationMs = Date.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const totalChars = lines.reduce((sum, l) => sum + l.length, 0);

  const md = [
    `# GEMB2-01 benchmark — dim=${args.dim}`,
    '',
    `- **Ran at:** ${new Date().toISOString()}`,
    `- **Corpus:** \`${args.corpus}\` (${lines.length} entries, ${totalChars} chars)`,
    `- **Wall-clock:** ${durationMs} ms`,
    '',
    '| Dim | Count | p50 ms | p95 ms | p99 ms | Errors |',
    '|---|---|---|---|---|---|',
    `| ${args.dim} | ${lines.length} | ${percentile(latencies, 50)} | ${percentile(latencies, 95)} | ${percentile(latencies, 99)} | ${errors} |`,
    '',
    '> Paste this into the Confluence "GEMB2-01 — Gemini Embedding 2 benchmark" page.',
    '> Tokens-per-dollar estimate: multiply `totalChars / 4` by the current Vertex',
    '> `text-embedding` pricing-sheet cell and paste the total below.',
  ].join('\n');

  writeFileSync(args.out, md);
  console.log(`✔ wrote ${args.out}`);
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
