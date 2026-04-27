#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1251 (R0-5) — Confluence DoD checkbox validator.
 *
 * Helper for Atlassian Automation rule R4 (block Done unless DoD ticked).
 *
 * Usage (from the worker, called by Atlassian Automation web-request action):
 *   POST /api/admin/check-confluence-dod
 *   { "issueKey": "SCRUM-1247", "confluencePageId": "27820033" }
 *
 * Or from CLI for local testing:
 *   CONFLUENCE_PAGE_ID=27820033 npx tsx check-confluence-dod.ts
 *
 * Returns:
 *   { ok: true } when the "Definition of Done" section contains zero `[ ]` (unticked) entries.
 *   { ok: false, untickedLines: [...] } otherwise.
 *
 * The validator deliberately requires a "Definition of Done" or "DoD" section
 * heading. Pages without that heading are treated as `ok: true` (assume the
 * page is informational, not a story DoD page).
 */

const CONFLUENCE_BASE = process.env.CONFLUENCE_BASE_URL ?? 'https://arkova.atlassian.net/wiki';
const CONFLUENCE_USER = process.env.CONFLUENCE_USER ?? '';
const CONFLUENCE_TOKEN = process.env.CONFLUENCE_API_TOKEN ?? '';

interface CheckResult {
  ok: boolean;
  pageId: string;
  totalCheckboxes?: number;
  untickedCount?: number;
  untickedLines?: { line: number; text: string }[];
  reason?: string;
}

interface ConfluenceContent {
  body: { storage: { value: string } } | { atlas_doc_format: { value: string } } | { view: { value: string } };
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${CONFLUENCE_USER}:${CONFLUENCE_TOKEN}`).toString('base64')}`;
}

async function fetchPageBody(pageId: string): Promise<string> {
  if (!CONFLUENCE_USER || !CONFLUENCE_TOKEN) {
    throw new Error('CONFLUENCE_USER and CONFLUENCE_API_TOKEN env vars required');
  }
  const url = `${CONFLUENCE_BASE}/rest/api/content/${pageId}?expand=body.storage`;
  const resp = await fetch(url, { headers: { Authorization: basicAuth(), Accept: 'application/json' } });
  if (!resp.ok) {
    throw new Error(`Confluence API ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as ConfluenceContent;
  const body = (json.body as { storage?: { value: string } }).storage?.value;
  if (!body) throw new Error('Confluence page body missing storage representation');
  return body;
}

/**
 * Locate the "Definition of Done" section in the page body and return the
 * unticked checkbox markers within it. Confluence storage format uses
 * `<ac:task><ac:task-status>incomplete|complete</ac:task-status>...` markup
 * inside `<ac:task-list>` blocks. We scan only between the DoD heading and
 * the next sibling heading.
 */
export function findUntickedDoDCheckboxes(storageBody: string): { line: number; text: string }[] {
  // Tolerate <h1>..<h6> with nested formatting (e.g. <strong>Definition of Done</strong>).
  const dodHeadingRe = /<h[1-6][^>]*>[\s\S]*?(?:Definition of Done|DoD)[\s\S]*?<\/h[1-6]>/i;
  const m = dodHeadingRe.exec(storageBody);
  if (!m) {
    // No DoD section means we can't enforce — treat as ok.
    return [];
  }
  const after = storageBody.slice(m.index + m[0].length);
  // Stop at the next heading sibling.
  const nextHeadingRe = /<h[1-6][^>]*>/;
  const stop = nextHeadingRe.exec(after);
  const section = stop ? after.slice(0, stop.index) : after;

  const unticked: { line: number; text: string }[] = [];
  // Confluence task storage form:
  //   <ac:task><ac:task-id>N</ac:task-id><ac:task-status>incomplete</ac:task-status>
  //     <ac:task-body>...</ac:task-body></ac:task>
  const taskRe = /<ac:task>[\s\S]*?<ac:task-status>(incomplete|complete)<\/ac:task-status>[\s\S]*?<ac:task-body>([\s\S]*?)<\/ac:task-body>[\s\S]*?<\/ac:task>/g;
  let line = 1;
  let lastIdx = 0;
  let tm: RegExpExecArray | null;
  while ((tm = taskRe.exec(section)) !== null) {
    line += (section.slice(lastIdx, tm.index).match(/\n/g)?.length ?? 0);
    lastIdx = tm.index;
    if (tm[1] === 'incomplete') {
      const text = tm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      unticked.push({ line, text });
    }
  }
  // Also catch raw markdown-style "- [ ]" written inside Confluence (some pages
  // are imported from .md and the markup is preserved as text). Allow either
  // line-start OR a Confluence wrapper tag like <p> / <li> right before.
  const mdRe = /(?:^|>)\s*[-*]?\s*\[ \]\s+([^<\n]+)/gm;
  let line2 = 1;
  let lastIdx2 = 0;
  while ((tm = mdRe.exec(section)) !== null) {
    line2 += (section.slice(lastIdx2, tm.index).match(/\n/g)?.length ?? 0);
    lastIdx2 = tm.index;
    unticked.push({ line: line2, text: tm[1].trim() });
  }

  return unticked;
}

export async function checkConfluencePageDoD(pageId: string): Promise<CheckResult> {
  const body = await fetchPageBody(pageId);
  const unticked = findUntickedDoDCheckboxes(body);
  if (unticked.length === 0) {
    return { ok: true, pageId, untickedCount: 0 };
  }
  return {
    ok: false,
    pageId,
    untickedCount: unticked.length,
    untickedLines: unticked,
    reason: `Definition of Done section has ${unticked.length} unticked checkbox(es)`,
  };
}

async function main(): Promise<void> {
  const pageId = process.env.CONFLUENCE_PAGE_ID ?? process.argv[2];
  if (!pageId) {
    console.error('Usage: CONFLUENCE_PAGE_ID=<id> npx tsx check-confluence-dod.ts');
    process.exit(2);
  }
  try {
    const result = await checkConfluencePageDoD(pageId);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

// Only run main when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
