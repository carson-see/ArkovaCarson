#!/usr/bin/env -S npx tsx
/** Thin CLI adapter; the trust root and private brand live in Lane 3. */

import { runS33Wave1GitHubEvidenceCli } from '../../services/worker/src/ai/eval/s33-wave1-github-evidence.js';

runS33Wave1GitHubEvidenceCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`S3.3 Wave-1 GitHub evidence: FAIL — ${message}\n`);
  process.exitCode = 1;
});
