#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1306 (R0-7) rule: feedback_dont_recommend_do.
 *
 * Advisory CI comment scanning PR descriptions and changed markdown files
 * for passive "you should X" / "please X" / "consider doing X" patterns.
 * This catches AI agents recommending instead of doing.
 *
 * Always exits 0 (advisory only). Prints warnings when matches are found.
 * No override label needed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { changedFiles, REPO } from '../lib/ciContext.js';

const PASSIVE_PATTERNS = [
  /\byou should\b/i,
  /\bplease consider\b/i,
  /\brecommend doing\b/i,
  /\bsuggest that\b/i,
  /\byou could try\b/i,
];

interface Warning {
  source: string;
  line: number;
  text: string;
}

function scanText(source: string, content: string): Warning[] {
  const warnings: Warning[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (PASSIVE_PATTERNS.some((re) => re.test(lines[i]))) {
      warnings.push({ source, line: i + 1, text: lines[i].trim() });
    }
  }
  return warnings;
}

function scanPrBody(): Warning[] {
  const body = process.env.GITHUB_PR_BODY ?? process.env.PR_BODY ?? '';
  if (!body) return [];
  return scanText('PR description', body);
}

function scanChangedMarkdown(): Warning[] {
  const files = changedFiles().filter((f) => /\.md$/i.test(f));
  const warnings: Warning[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(resolve(REPO, file), 'utf8');
    } catch {
      continue;
    }
    warnings.push(...scanText(file, content));
  }
  return warnings;
}

export function run(): { ok: boolean; message: string } {
  const warnings = [...scanPrBody(), ...scanChangedMarkdown()];

  if (warnings.length === 0) {
    return { ok: true, message: '✅ feedback_dont_recommend_do: no passive recommendation patterns detected.' };
  }

  const lines = [
    `Advisory: detected ${warnings.length} passive recommendation pattern(s):`,
  ];
  for (const w of warnings) {
    lines.push(`  ${w.source}:${w.line}  ${w.text}`);
  }
  lines.push('');
  lines.push('Agents should DO, not recommend. See memory/feedback_dont_recommend_do.md.');
  lines.push('(This check is advisory only and does not block the PR.)');

  // Advisory only — always return ok: true
  return { ok: true, message: lines.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
}
