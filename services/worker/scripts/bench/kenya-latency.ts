/**
 * Kenya Latency Benchmark (SCRUM-899 KENYA-RES-01)
 *
 * Measures p50 / p95 HTTPS RTT from the host running this script to a
 * candidate Supabase region. Intended to be run from a GCP `africa-south1`
 * (Johannesburg) VM as a reasonable proxy for Kenya-originating traffic
 * until a Nairobi test host is available.
 *
 * Usage:
 *   AI_PROVIDER=mock tsx scripts/bench/kenya-latency.ts \
 *     --target https://<project>.supabase.co/rest/v1/ \
 *     --key <anon-key> \
 *     --label "Supabase Frankfurt"
 *
 * Writes results to stdout as JSON + a human-readable summary. Append to
 * `docs/compliance/kenya/residency-options.md` §5.
 */

import { percentile } from '../lib/stats.js';

interface BenchInput {
  target: string;
  apiKey: string;
  label: string;
  iterations: number;
  concurrency: number;
}

interface SampleTiming {
  durationMs: number;
  ok: boolean;
  status?: number;
  error?: string;
}

interface BenchResult {
  label: string;
  target: string;
  iterations: number;
  concurrency: number;
  successCount: number;
  errorCount: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
}

async function runOne(target: string, apiKey: string): Promise<SampleTiming> {
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
    });
    return {
      durationMs: Date.now() - started,
      ok: response.ok,
      status: response.status,
    };
  } catch (err) {
    return {
      durationMs: Date.now() - started,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runBench(input: BenchInput): Promise<BenchResult> {
  const durations: number[] = [];
  let successCount = 0;
  let errorCount = 0;

  const queue = Array.from({ length: input.iterations }, (_, i) => i);
  const workers = Array.from({ length: input.concurrency }, async () => {
    while (queue.length > 0) {
      queue.pop();
      const sample = await runOne(input.target, input.apiKey);
      if (sample.ok) {
        durations.push(sample.durationMs);
        successCount += 1;
      } else {
        errorCount += 1;
      }
    }
  });
  await Promise.all(workers);

  durations.sort((a, b) => a - b);
  return {
    label: input.label,
    target: input.target,
    iterations: input.iterations,
    concurrency: input.concurrency,
    successCount,
    errorCount,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    min: durations[0] ?? 0,
    max: durations[durations.length - 1] ?? 0,
  };
}

function parseArgs(argv: string[]): BenchInput {
  const flag = (name: string): string | undefined => {
    const idx = argv.findIndex((a) => a === `--${name}`);
    if (idx === -1 || idx === argv.length - 1) return undefined;
    return argv[idx + 1];
  };
  const target = flag('target');
  const apiKey = flag('key') ?? process.env.SUPABASE_ANON_KEY;
  const label = flag('label') ?? 'unlabelled';
  const iterations = parseInt(flag('iterations') ?? '40', 10);
  const concurrency = parseInt(flag('concurrency') ?? '4', 10);
  if (!target) {
    throw new Error('--target is required (Supabase REST base URL)');
  }
  if (!apiKey) {
    throw new Error('--key or SUPABASE_ANON_KEY is required');
  }
  return { target, apiKey, label, iterations, concurrency };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = parseArgs(process.argv.slice(2));
  runBench(input).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    console.log('');
    console.log(`${result.label} (${result.target})`);
    console.log(`  p50: ${result.p50} ms   p95: ${result.p95} ms   p99: ${result.p99} ms`);
    console.log(`  mean: ${result.mean.toFixed(1)} ms   min: ${result.min} ms   max: ${result.max} ms`);
    console.log(`  success: ${result.successCount}/${result.iterations}   errors: ${result.errorCount}`);
  }).catch((err) => {
    console.error('benchmark failed:', err);
    process.exit(1);
  });
}
