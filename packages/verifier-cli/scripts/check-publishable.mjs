#!/usr/bin/env node
/**
 * `prepublishOnly` guard — refuse to publish while any installed dependency is
 * a local `file:` path.
 *
 * Why this exists: `arkova-verifier` is depended on as `file:../verifier` on
 * purpose (it is not on the registry yet, so a semver range would break a fresh
 * clone and CI). That path CANNOT be published — but npm does not stop you, and
 * the failure is SILENT. Publishing as-is produces a tarball whose install
 * prints `added 2 packages` and exits 0 while creating a dangling link; the
 * binary then dies only at runtime with `ERR_MODULE_NOT_FOUND: Cannot find
 * package 'arkova-verifier'`. npm publishes are irreversible, so a broken 0.1.0
 * would be permanent.
 *
 * PUBLISHING.md step 2 swaps the path for a version range between the two
 * publishes. This script is what makes that step unforgettable, rather than
 * something the operator has to remember at 2am.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// Both maps are installed by consumers, so both are publish hazards.
const offenders = [];
for (const field of ['dependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (typeof spec === 'string' && spec.trim().toLowerCase().startsWith('file:')) {
      offenders.push(`${field}.${name} = "${spec}"`);
    }
  }
}

if (offenders.length > 0) {
  console.error('\nREFUSING TO PUBLISH — local file: dependency present:\n');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    '\nA file: path cannot resolve from the registry. Publishing this would'
      + '\nsucceed, install with exit 0, and fail only at runtime with'
      + '\nERR_MODULE_NOT_FOUND — permanently, because npm publishes are'
      + '\nirreversible.'
      + '\n\nFix: follow PUBLISHING.md step 2 — publish arkova-verifier FIRST, then'
      + '\nswap the path for a version range (e.g. "^0.1.0") and re-run npm install.'
      + '\nRevert it afterwards (step 4).\n',
  );
  process.exit(1);
}

console.log('publish preflight OK — no file: dependencies.');
