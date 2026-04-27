#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1207 (AUDIT-26) — Automated Confluence-drift guard.
 *
 * Parses PR title/body/commit messages for `SCRUM-NNNN` references and
 * verifies each has a matching Confluence page in space `A`. Required to
 * make CLAUDE.md §0 rule 4 ("every Jira story MUST have a Confluence
 * page") enforceable at PR time instead of by post-hoc audit.
 *
 * Posture: warn-only by default (exit 0 with ::warning::). Set
 * `FAIL_ON_MISSING_CONFLUENCE=true` to upgrade to a blocking gate once
 * the Confluence backfill (SCRUM-1199) has cleared the long tail.
 *
 * Override label: `confluence-drift-skip` (e.g. for chore/deps PRs that
 * legitimately reference a story for context but aren't expected to ship
 * a doc).
 */
import { pathToFileURL } from 'node:url';
import { atlassianBasicAuthHeader, hasLabel, LABELS, prBody, prCommitsMsgs, prTitle } from './lib/ciContext.js';

const SCRUM_REF = /\bSCRUM-(\d{1,5})\b/g;
// Slash-separated continuation form (PR titles like `SCRUM-1187/1188/1189`)
// — capture the prefix + the trailing /NNNN segments and emit each as its
// own SCRUM-NNNN.
const SCRUM_REF_SLASH_CHAIN = /\bSCRUM-\d{1,5}(?:\/\d{1,5})+\b/g;

const FAIL_MODE = process.env.FAIL_ON_MISSING_CONFLUENCE === 'true';

const CONFLUENCE_BASE_URL =
  process.env.CONFLUENCE_BASE_URL ?? 'https://arkova.atlassian.net/wiki';
const CONFLUENCE_SPACE_KEY = process.env.CONFLUENCE_SPACE_KEY ?? 'A';
const JIRA_EMAIL = process.env.JIRA_EMAIL ?? '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? '';

/**
 * Pure parser — pulls every distinct `SCRUM-NNNN` ref out of the input
 * and returns them sorted by numeric suffix (so output is stable across
 * runs and the test snapshot doesn't depend on which mention came first).
 */
export function extractScrumRefs(text: string): string[] {
  if (!text) return [];
  const expanded = text.replace(SCRUM_REF_SLASH_CHAIN, (chain) => {
    const [head, ...rest] = chain.split('/');
    return [head, ...rest.map((n) => `SCRUM-${n}`)].join(' ');
  });
  const found = new Set<string>();
  for (const match of expanded.matchAll(SCRUM_REF)) {
    found.add(`SCRUM-${match[1]}`);
  }
  return Array.from(found).sort((a, b) => {
    const an = Number(a.split('-')[1]);
    const bn = Number(b.split('-')[1]);
    return an - bn;
  });
}

export type PageLookup = (ref: string) => Promise<boolean>;

/**
 * Pure missing-page detector. `lookup` is injected so tests don't have to
 * stub `fetch`. Lookup throws → treat as missing (fail-closed): the auditor
 * reading this CI run cares whether the page is *known to exist*, not
 * whether the lookup succeeded. Refs are checked concurrently; PR ref
 * counts are bounded (≤20 in practice), so an unbounded `Promise.all` is
 * fine and dodges the slowest-ref-blocks-the-rest stall.
 */
export async function findMissingPages(refs: string[], lookup: PageLookup): Promise<string[]> {
  if (refs.length === 0) return [];
  const results = await Promise.all(
    refs.map(async (ref) => {
      try {
        const present = await lookup(ref);
        return present ? null : ref;
      } catch {
        return ref;
      }
    }),
  );
  return results.filter((r): r is string => r !== null);
}

/**
 * Default lookup — uses Confluence CQL to find a page in `space=<key>`
 * whose title contains the ref. Pages in space A follow the convention
 * `SCRUM-NNNN — <summary>` so a `title ~ "SCRUM-1207"` match is
 * sufficient.
 */
function makeConfluenceLookup(): PageLookup {
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      'JIRA_EMAIL and JIRA_API_TOKEN must be set for Confluence-drift check.',
    );
  }
  const authHeader = atlassianBasicAuthHeader(JIRA_EMAIL, JIRA_API_TOKEN);
  return async (ref: string) => {
    const cql = encodeURIComponent(`space = "${CONFLUENCE_SPACE_KEY}" AND title ~ "${ref}"`);
    const url = `${CONFLUENCE_BASE_URL}/rest/api/content/search?cql=${cql}&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    // 4xx (other than 401) = authoritative "not found" / bad query → page is missing.
    // 5xx = transient — rethrow so findMissingPages' catch flags it as missing
    // but the surrounding logs make the cause visible to the on-call.
    if (res.status >= 500) {
      throw new Error(`Confluence transient error: ${res.status} ${res.statusText}`);
    }
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { results?: unknown[] };
    return Array.isArray(body.results) && body.results.length > 0;
  };
}

async function main(): Promise<number> {
  if (hasLabel(LABELS.confluenceDriftSkip)) {
    console.log(`Confluence-drift check skipped (label: ${LABELS.confluenceDriftSkip}).`);
    return 0;
  }

  const refs = extractScrumRefs([prTitle, prBody, prCommitsMsgs].join('\n'));
  if (refs.length === 0) {
    console.log('No SCRUM refs found in PR title/body/commits — nothing to check.');
    return 0;
  }

  console.log(`Checking ${refs.length} SCRUM ref(s) against Confluence space ${CONFLUENCE_SPACE_KEY}: ${refs.join(', ')}`);

  let lookup: PageLookup;
  try {
    lookup = makeConfluenceLookup();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`::warning::${msg} — skipping Confluence-drift check.`);
    return 0;
  }

  const missing = await findMissingPages(refs, lookup);
  if (missing.length === 0) {
    console.log(`✅ All ${refs.length} SCRUM refs have Confluence pages.`);
    return 0;
  }

  const level = FAIL_MODE ? 'error' : 'warning';
  console.log(`::${level}::Missing Confluence pages for: ${missing.join(', ')}`);
  console.log(
    'Per CLAUDE.md §0 rule 4, every Jira story must have a Confluence page in space A. ' +
      'Create one before merging, or add the `confluence-drift-skip` label if this PR ' +
      'legitimately references a story without expecting a new doc (e.g. dep bumps).',
  );

  return FAIL_MODE ? 1 : 0;
}

// pathToFileURL normalizes Windows drive letters + backslashes so the comparison
// against import.meta.url (always forward-slash, file:/// form) actually holds.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`::error::Unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(FAIL_MODE ? 1 : 0);
    });
}
