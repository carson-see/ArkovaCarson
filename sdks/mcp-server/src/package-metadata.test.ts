import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  overrides?: Record<string, string>;
};

// 2026-09-21 independent-review finding (npm audit --omit=dev, exact tree at
// this PR's head): both vulnerable versions ship at RUNTIME through
// @modelcontextprotocol/sdk@1.30.0 (which does not itself bump these), not
// through a devDependency-only build toolchain the way the postcss/nanoid
// findings in sibling packages were:
//   - fast-uri@3.1.5 (via ajv@8.20.0, used by the MCP SDK's own request/
//     schema validation) — HIGH: GHSA-jqff-g426-hqxp (host confusion via
//     percent-encoded scheme normalization), GHSA-f65p-4m7j-42xc (SSRF via
//     malformed IPv6 normalization), GHSA-fph4-wmhf-6fwf (SSRF via repeated
//     hostname percent-decoding), GHSA-5jgf-p345-68v8 (host confusion via
//     skipped IDN canonicalization). Fixed in 3.1.6+; pinned to the patched
//     3.x line (^3.1.8) rather than the 4.x major to avoid an unreviewed
//     major bump of a transitive dependency in a security-only fix.
//   - qs@6.15.3 (via express@5.2.1, body-parser) — MODERATE:
//     GHSA-x5fp-wj9c-mxmx (array-limit bypass via bracket-key comma
//     parsing), GHSA-4mjr-xmp4-gh2g (DoS via attacker-controlled isBuffer).
//     Fixed in 6.16.0 (same major line as the version already in use).
describe('runtime dependency overrides (npm audit --omit=dev findings)', () => {
  it('pins fast-uri to the patched 3.x line (HIGH: 4 GHSAs, ships via ajv at runtime)', () => {
    expect(manifest.overrides?.['fast-uri']).toBeDefined();
    expect(manifest.overrides!['fast-uri']).toMatch(/^\^?3\.1\.[89]/);
  });

  it('pins qs to its fixed-in version (MODERATE: 2 GHSAs, ships via express at runtime)', () => {
    expect(manifest.overrides?.qs).toBeDefined();
    expect(manifest.overrides!.qs).toMatch(/^\^?6\.16\.0/);
  });
});
