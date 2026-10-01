#!/usr/bin/env node
// Manual dispatch is a build rehearsal. Only a pushed sdk-v<package version> tag
// can admit the separate credential-bearing npm publish step.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(resolve(repo, 'packages/sdk/package.json'), 'utf8'));
const eventName = process.env.GITHUB_EVENT_NAME;
const ref = process.env.GITHUB_REF;
const output = process.env.GITHUB_OUTPUT;

if (!output || typeof manifest.version !== 'string') {
  process.stderr.write('SDK publication admission unavailable.\n');
  process.exitCode = 1;
} else if (eventName === 'workflow_dispatch') {
  appendFileSync(output, 'publish=false\n');
} else if (eventName === 'push' && ref === `refs/tags/sdk-v${manifest.version}`) {
  appendFileSync(output, 'publish=true\n');
} else {
  process.stderr.write('SDK publication denied: event, tag, and package version do not match.\n');
  process.exitCode = 1;
}
