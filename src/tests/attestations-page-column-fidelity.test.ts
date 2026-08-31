/**
 * Column fidelity for AttestationsPage (2026-08-31).
 *
 * WHY THIS EXISTS. `AttestationsPage.tsx` reads the `attestations` table
 * through `const dbAny = supabase as any`, then casts the result to a
 * hand-written local `Attestation` interface. That cast means TypeScript
 * cannot tell the page it is reading a column the table does not have — so
 * a field declared here that does not exist in the database is `undefined`
 * at runtime, forever, silently.
 *
 * That is exactly what happened with the SCRUM-1874 notarization UI: the page
 * declared `notarized_at`, `notary_name`, `notary_commission_state` and
 * `docusign_envelope_id` as optional fields and fed them to
 * `<NotarizationBadge>`. Those four columns live on
 * `legally_binding_attestations`, NOT on `attestations` — verified against
 * prod `vzwyaatejekddvltxyye` on 2026-08-31. The badge therefore rendered
 * nothing, on every row, since it shipped.
 *
 * A census cannot hold this: the next person to add a field behind the same
 * cast reintroduces the bug. So the invariant is enforced mechanically —
 * every field on the page's local interface must exist on the generated
 * `attestations` Row type.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'src/pages/AttestationsPage.tsx');
const typesPath = path.resolve(process.cwd(), 'src/types/database.types.ts');

/** Field names declared on the page's local `interface Attestation`. */
function pageInterfaceFields(): string[] {
  const source = fs.readFileSync(pagePath, 'utf8');
  const start = source.indexOf('interface Attestation {');
  expect(start, 'AttestationsPage must declare `interface Attestation`').toBeGreaterThan(-1);

  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Column names on the generated `attestations` Row type. */
function generatedRowColumns(): string[] {
  const source = fs.readFileSync(typesPath, 'utf8');
  const start = source.indexOf('      attestations: {');
  expect(start, 'database.types.ts must contain the attestations table').toBeGreaterThan(-1);

  const rowStart = source.indexOf('Row: {', start);
  const body = source.slice(rowStart, source.indexOf('\n        }', rowStart));
  return [...body.matchAll(/^\s{10}(\w+):/gm)].map((m) => m[1]);
}

describe('AttestationsPage column fidelity', () => {
  it('declares no field that the attestations table does not have', () => {
    const declared = pageInterfaceFields();
    const actual = new Set(generatedRowColumns());

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((field) => !actual.has(field))).toEqual([]);
  });

  it('pins the four notarization columns as absent from `attestations`', () => {
    // Guards the premise. If a migration ever adds these to `attestations`,
    // this test fails and the notarization UI should be re-wired deliberately
    // rather than by accident. See supabase/migrations/0314 for the table that
    // actually owns them.
    const actual = new Set(generatedRowColumns());

    for (const column of [
      'notarized_at',
      'notary_name',
      'notary_commission_state',
      'docusign_envelope_id',
    ]) {
      expect(actual.has(column), `${column} unexpectedly present`).toBe(false);
    }
  });
});
