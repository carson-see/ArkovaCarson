#!/usr/bin/env node
/**
 * scripts/fetch-ner-model.ts — vendor the self-hosted NER PII model weights.
 *
 * S1.4 / WEBEXT-CSP (SCRUM-2503). On-device PII stripping
 * (src/lib/nerPiiDetector.ts) loads the NER model from the Arkova app origin
 * (`/models/...`, served from `public/models/`) with `env.allowRemoteModels =
 * false`, so transformers.js never reaches the HuggingFace CDN at runtime (that
 * fetch is blocked by the production CSP and used to cause a SILENT regex
 * fallback — a §1.6 fail-OPEN). This OPS step pulls the q8 (8-bit quantized)
 * weights + tokenizer for `Xenova/bert-base-NER` into the served directory.
 *
 * The downloaded weights are LARGE (~130 MB) and are deliberately NOT committed
 * — `public/models/` is git-ignored. Run this:
 *   - once in local dev before exercising the on-device NER path, and
 *   - in the build/deploy pipeline (before `vite build`) so the model ships to
 *     the same app origin as the bundle.
 *
 * Usage:
 *   npx tsx scripts/fetch-ner-model.ts          # download (skips files already present)
 *   npx tsx scripts/fetch-ner-model.ts --force  # re-download even if present
 *   npx tsx scripts/fetch-ner-model.ts --check   # verify presence only, exit 1 if missing
 *
 * Exit 0 on success, 1 on any failure (so CI/build can gate on it).
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo + revision are pinned so a self-host refresh is reproducible. Bumping
// the model is a deliberate, reviewed change (it shifts PII-detection behavior).
const MODEL_REPO = 'Xenova/bert-base-NER';
const MODEL_REVISION = 'main';
const HF_BASE = 'https://huggingface.co';

/**
 * Files transformers.js requests for this repo when loading
 * `token-classification` with `dtype: 'q8'` on the wasm/webgpu backend.
 * `dtype: 'q8'` maps to `onnx/model_quantized.onnx`. Keep this list in sync
 * with the loader config in src/lib/nerPiiDetector.ts.
 */
const REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const;

/** Optional files — fetched if present, never fatal if 404. */
const OPTIONAL_FILES = ['special_tokens_map.json'] as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// Mirrors NER_LOCAL_MODEL_PATH ('/models/') in src/lib/nerPiiDetector.ts.
const DEST_ROOT = join(REPO_ROOT, 'public', 'models', MODEL_REPO);

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');

function srcUrl(file: string): string {
  return `${HF_BASE}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function download(file: string, optional: boolean): Promise<boolean> {
  const dest = join(DEST_ROOT, file);

  if (!force && (await exists(dest))) {
    console.log(`✓ ${file} (already present, skipping)`);
    return true;
  }

  const url = srcUrl(file);
  const res = await fetch(url);
  if (!res.ok) {
    if (optional && res.status === 404) {
      console.log(`· ${file} (optional, not in repo — skipping)`);
      return true;
    }
    console.error(`✗ ${file} — HTTP ${res.status} ${res.statusText} (${url})`);
    return false;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    console.error(`✗ ${file} — empty response body`);
    return false;
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  const mb = (buf.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`✓ ${file} (${mb} MB)`);
  return true;
}

async function runCheck(): Promise<number> {
  let missing = 0;
  for (const file of REQUIRED_FILES) {
    const ok = await exists(join(DEST_ROOT, file));
    console.log(`${ok ? '✓' : '✗'} ${file}`);
    if (!ok) missing++;
  }
  if (missing > 0) {
    console.error(
      `\n${missing} required model file(s) missing under ${DEST_ROOT}.\n` +
        'Run: npx tsx scripts/fetch-ner-model.ts',
    );
    return 1;
  }
  console.log(`\nAll ${REQUIRED_FILES.length} required model files present.`);
  return 0;
}

async function main(): Promise<number> {
  console.log(
    `Self-hosting NER model: ${MODEL_REPO}@${MODEL_REVISION}\n` +
      `Destination: ${DEST_ROOT}\n`,
  );

  if (checkOnly) {
    return runCheck();
  }

  await mkdir(DEST_ROOT, { recursive: true });

  let failed = 0;
  for (const file of REQUIRED_FILES) {
    if (!(await download(file, false))) failed++;
  }
  for (const file of OPTIONAL_FILES) {
    if (!(await download(file, true))) failed++;
  }

  if (failed > 0) {
    console.error(`\n${failed} file(s) failed to download.`);
    return 1;
  }

  console.log(
    '\nDone. Weights vendored under public/models/ (git-ignored — do NOT commit the binary).\n' +
      'The on-device NER PII detector will now load from the app origin with remote models disabled.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
