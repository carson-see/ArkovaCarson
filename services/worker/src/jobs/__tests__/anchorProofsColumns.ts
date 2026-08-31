/**
 * M4 — the real `anchor_proofs` column list, parsed from the generated types.
 *
 * The forgery guards (`SKELETON_FORBIDDEN_COLUMNS` in proof-materializer.ts and
 * `CLASSIFIER_READ_ONLY_COLUMNS` in proof-backcatalog-classifier.ts) exist to
 * make it structurally impossible for those jobs to write proof evidence. Both
 * were previously asserted against a HARDCODED literal list inside their own
 * tests — a census kept by hand, next to the set it was supposed to police. The
 * two agreed with each other and with nothing else, so when migration 0427
 * added `tx_inclusion_branch` / `tx_block_index` neither list changed and CI
 * went on reporting a healthy guard that had stopped covering the schema.
 *
 * This gives the tests a source of truth OUTSIDE themselves: the `Row` block of
 * `anchor_proofs` in `types/database.types.ts`, which is what `gen:types`
 * produces from the live schema. A column added there without being classified
 * in one of the guard lists now fails the suite by construction.
 *
 * TypeScript types are erased at runtime, so this reads the file. That is the
 * point — a type-level check could not enumerate the keys for a runtime
 * set-difference, and a runtime constant would just be the same hand-kept
 * census wearing a different hat.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES_PATH = resolve(HERE, '../../types/database.types.ts');

/**
 * Column names of `public.anchor_proofs`, in declaration order.
 *
 * Throws if the table or its `Row` block cannot be located — a silent empty
 * array would turn this detector back into the no-op it replaces.
 */
export function readAnchorProofsColumns(): string[] {
  const src = readFileSync(TYPES_PATH, 'utf8');
  const tableIdx = src.indexOf('\n      anchor_proofs: {');
  if (tableIdx === -1) {
    throw new Error(`anchor_proofs table not found in ${TYPES_PATH}`);
  }
  const rowIdx = src.indexOf('Row: {', tableIdx);
  if (rowIdx === -1) {
    throw new Error(`anchor_proofs Row block not found in ${TYPES_PATH}`);
  }
  const rowEnd = src.indexOf('\n        }', rowIdx);
  if (rowEnd === -1) {
    throw new Error(`anchor_proofs Row block is unterminated in ${TYPES_PATH}`);
  }

  const body = src.slice(rowIdx + 'Row: {'.length, rowEnd);
  const columns: string[] = [];
  for (const line of body.split('\n')) {
    // `          column_name: type` — the generated shape, one column per line.
    const match = /^\s{10}([a-z_][a-z0-9_]*)\??:/.exec(line);
    if (match) columns.push(match[1]);
  }
  if (columns.length === 0) {
    throw new Error(`parsed zero anchor_proofs columns from ${TYPES_PATH}`);
  }
  return columns;
}
