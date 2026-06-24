#!/usr/bin/env node
/**
 * scripts/fetch-ner-model.ts — vendor + integrity-verify the self-hosted NER PII model.
 *
 * S1.4 + S1.4b / WEBEXT-CSP (SCRUM-2503). On-device PII stripping
 * (src/lib/nerPiiDetector.ts) loads the NER model from the Arkova app origin
 * (`/models/...`, served from `public/models/`) with `env.allowRemoteModels =
 * false`, so transformers.js never reaches the HuggingFace CDN at runtime (that
 * fetch is blocked by the production CSP and used to cause a SILENT regex
 * fallback — a §1.6 fail-OPEN). This OPS/BUILD step pulls the q8 (8-bit
 * quantized) weights + tokenizer for `Xenova/bert-base-NER` into the served
 * directory at a PINNED revision and VERIFIES each file's SHA-256 against the
 * committed lockfile (scripts/ner-weights.lock.json).
 *
 * Integrity (S1.4b): every downloaded file is hashed (SHA-256) and compared to
 * the lockfile. Any mismatch, wrong byte length, or missing REQUIRED file makes
 * this script exit NON-ZERO (fail the build closed) — a tampered/wrong weight
 * blob can never silently ship as the on-device PII model. Runtime never hits
 * the HF CDN; weights are served same-origin under CSP 'self'.
 *
 * The downloaded weights are LARGE (~104 MB) and are deliberately NOT committed
 * — `public/models/` is git-ignored. This runs:
 *   - once in local dev before exercising the on-device NER path, and
 *   - in the build pipeline via `npm run prebuild` (before `vite build`) so the
 *     model ships to the same app origin as the bundle.
 *
 * Usage:
 *   npx tsx scripts/fetch-ner-model.ts            # download + verify (skips files already present & matching)
 *   npx tsx scripts/fetch-ner-model.ts --force    # re-download + verify even if present
 *   npx tsx scripts/fetch-ner-model.ts --check     # verify presence + hashes only, exit 1 on any problem (no download)
 *   npx tsx scripts/fetch-ner-model.ts --update-lock  # MAINTAINER: re-download and REWRITE the lockfile from real hashes
 *
 * Exit 0 on success, 1 on any failure (so CI/build can gate on it).
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
export const LOCKFILE_PATH = join(__dirname, 'ner-weights.lock.json');
const HF_BASE = 'https://huggingface.co';

export interface LockedFile {
  sha256: string;
  bytes: number;
  /** REQUIRED files fail the build closed when missing/mismatched. */
  required: boolean;
}

export interface WeightsLock {
  modelId: string;
  revision: string;
  dtype: string;
  transformersJsVersion?: string;
  files: Record<string, LockedFile>;
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');
const updateLock = args.includes('--update-lock');

export async function readLock(lockPath: string = LOCKFILE_PATH): Promise<WeightsLock> {
  const raw = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(raw) as WeightsLock;
  if (!lock.modelId || !lock.revision || !lock.files) {
    throw new Error(`Malformed lockfile at ${lockPath}: missing modelId/revision/files`);
  }
  // The revision MUST be a pinned 40-char git SHA — never a floating ref like `main`.
  if (!/^[0-9a-f]{40}$/.test(lock.revision)) {
    throw new Error(
      `Lockfile revision '${lock.revision}' is not a pinned 40-char commit SHA. ` +
        'Floating refs (e.g. `main`) are forbidden for the on-device PII model.',
    );
  }
  return lock;
}

export function srcUrl(lock: WeightsLock, file: string): string {
  return `${HF_BASE}/${lock.modelId}/resolve/${lock.revision}/${file}`;
}

export function destPath(lock: WeightsLock, file: string): string {
  // Mirrors NER_LOCAL_MODEL_PATH ('/models/') + NER_MODEL_ID in
  // src/lib/nerPiiDetector.ts: public/models/<modelId>/<file>.
  return join(REPO_ROOT, 'public', 'models', lock.modelId, file);
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size === 0) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Verify a buffer against the locked hash + byte length. Returns an error string or null. */
export function verifyBuffer(file: string, locked: LockedFile, buf: Buffer): string | null {
  if (buf.byteLength !== locked.bytes) {
    return `${file}: byte length ${buf.byteLength} != locked ${locked.bytes}`;
  }
  const got = sha256(buf);
  if (got !== locked.sha256) {
    return `${file}: SHA-256 ${got} != locked ${locked.sha256}`;
  }
  return null;
}

async function fetchFile(url: string): Promise<{ buf: Buffer } | { status: number }> {
  const res = await fetch(url);
  if (!res.ok) return { status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf };
}

/**
 * Download (if needed) + verify a single file against the lockfile.
 * @returns true on success; false on a fatal problem (missing/mismatched required file).
 */
async function downloadAndVerify(lock: WeightsLock, file: string, locked: LockedFile): Promise<boolean> {
  const dest = destPath(lock, file);

  // Idempotent: if already present AND the hash matches, skip the re-download.
  if (!force) {
    const existing = await readIfExists(dest);
    if (existing) {
      const err = verifyBuffer(file, locked, existing);
      if (!err) {
        console.log(`✓ ${file} (present, hash verified — skipping)`);
        return true;
      }
      // Present but WRONG — fall through to re-download (handles a corrupt/partial file).
      console.warn(`! ${file} present but failed verification (${err}) — re-downloading`);
    }
  }

  const url = srcUrl(lock, file);
  const result = await fetchFile(url);
  if ('status' in result) {
    if (!locked.required && result.status === 404) {
      console.log(`· ${file} (optional, not at revision — skipping)`);
      return true;
    }
    console.error(`✗ ${file} — HTTP ${result.status} (${url})`);
    return false;
  }

  const err = verifyBuffer(file, locked, result.buf);
  if (err) {
    // Integrity failure: NEVER write an unverified blob into the served dir.
    console.error(`✗ INTEGRITY FAILURE — ${err}\n  url: ${url}`);
    return false;
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, result.buf);
  const mb = (result.buf.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`✓ ${file} (${mb} MB, hash verified)`);
  return true;
}

/** --check: verify presence + hash of every locked file on disk; no network. */
async function runCheck(lock: WeightsLock): Promise<number> {
  let problems = 0;
  for (const [file, locked] of Object.entries(lock.files)) {
    const buf = await readIfExists(destPath(lock, file));
    if (!buf) {
      if (locked.required) {
        console.error(`✗ ${file} (MISSING, required)`);
        problems++;
      } else {
        console.log(`· ${file} (optional, absent)`);
      }
      continue;
    }
    const err = verifyBuffer(file, locked, buf);
    if (err) {
      console.error(`✗ ${file} (${err})`);
      problems++;
    } else {
      console.log(`✓ ${file} (hash verified)`);
    }
  }
  if (problems > 0) {
    console.error(
      `\n${problems} model file problem(s) under public/models/${lock.modelId}.\n` +
        'Run: npx tsx scripts/fetch-ner-model.ts',
    );
    return 1;
  }
  console.log(`\nAll required model files present + hash-verified (${lock.modelId}@${lock.revision}).`);
  return 0;
}

/**
 * --update-lock: MAINTAINER flow. Re-download every file at the pinned revision,
 * write it into public/models/, and REWRITE the lockfile with the real hashes.
 * Use after bumping `revision` in the lockfile (then review the diff + re-soak).
 */
async function runUpdateLock(lock: WeightsLock): Promise<number> {
  console.log(`Updating lockfile from ${lock.modelId}@${lock.revision} …`);
  const nextFiles: Record<string, LockedFile> = {};
  let failed = 0;
  for (const [file, locked] of Object.entries(lock.files)) {
    const url = srcUrl(lock, file);
    const result = await fetchFile(url);
    if ('status' in result) {
      if (!locked.required && result.status === 404) {
        console.log(`· ${file} (optional, not at revision — dropping from lock)`);
        continue;
      }
      console.error(`✗ ${file} — HTTP ${result.status} (${url})`);
      failed++;
      continue;
    }
    const dest = destPath(lock, file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, result.buf);
    nextFiles[file] = {
      sha256: sha256(result.buf),
      bytes: result.buf.byteLength,
      required: locked.required,
    };
    console.log(`✓ ${file} → sha256 ${nextFiles[file].sha256} (${result.buf.byteLength} bytes)`);
  }
  if (failed > 0) {
    console.error(`\n${failed} file(s) failed — lockfile NOT rewritten.`);
    return 1;
  }
  // Preserve the `_comment` and any other top-level keys; only swap `files`.
  const raw = JSON.parse(await readFile(LOCKFILE_PATH, 'utf8')) as Record<string, unknown>;
  raw.files = nextFiles;
  await writeFile(LOCKFILE_PATH, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`\nLockfile rewritten: ${LOCKFILE_PATH}. Review the diff + re-soak before merging.`);
  return 0;
}

export async function main(): Promise<number> {
  const lock = await readLock();
  console.log(
    `Self-hosting NER model: ${lock.modelId}@${lock.revision} (dtype=${lock.dtype})\n` +
      `Destination: public/models/${lock.modelId}\n`,
  );

  if (updateLock) return runUpdateLock(lock);
  if (checkOnly) return runCheck(lock);

  let failed = 0;
  for (const [file, locked] of Object.entries(lock.files)) {
    if (!(await downloadAndVerify(lock, file, locked))) failed++;
  }

  if (failed > 0) {
    console.error(`\n${failed} file(s) failed download/verification — build must fail closed.`);
    return 1;
  }

  console.log(
    '\nDone. Weights vendored + hash-verified under public/models/ (git-ignored — do NOT commit the binary).\n' +
      'The on-device NER PII detector loads from the app origin with remote models disabled.',
  );
  return 0;
}

// Run only when executed directly (e.g. `npx tsx scripts/fetch-ner-model.ts` /
// `npm run prebuild`), NOT when imported by the test module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Unexpected error:', err);
      process.exit(1);
    });
}
