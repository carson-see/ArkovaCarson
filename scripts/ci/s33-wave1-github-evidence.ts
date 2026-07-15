#!/usr/bin/env -S npx tsx
/// <reference lib="es2022" />
/** Thin CLI adapter; the trust root and private brand live in Lane 3. */

import {
  recursivelyFreeze,
  runS33Wave1GitHubEvidenceCli,
  type S33Wave1GitHubActionsEnvironment,
} from '../../services/worker/src/ai/eval/s33-wave1-github-evidence.js';

const environment: Readonly<S33Wave1GitHubActionsEnvironment> = recursivelyFreeze({
  GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
  GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
  GITHUB_REF: process.env.GITHUB_REF,
  GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
  RUNNER_TEMP: process.env.RUNNER_TEMP,
  S33_UPLOAD_ARTIFACT_ID: process.env.S33_UPLOAD_ARTIFACT_ID,
  S33_UPLOAD_ARTIFACT_URL: process.env.S33_UPLOAD_ARTIFACT_URL,
  S33_UPLOAD_ARTIFACT_DIGEST: process.env.S33_UPLOAD_ARTIFACT_DIGEST,
});

runS33Wave1GitHubEvidenceCli(process.argv.slice(2), environment).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`S3.3 Wave-1 GitHub evidence: FAIL — ${message}\n`);
  process.exitCode = 1;
});
