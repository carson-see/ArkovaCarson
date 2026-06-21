#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export interface ScreenSoakSession {
  laneId: string;
  prNumber?: number;
  sessionName: string;
  state: string;
}

export interface SoakSummary {
  elapsedSeconds: number;
  total: number;
  mode: string;
  ok: number;
  fail: number;
  errorRate: string;
  statuses: string;
}

export interface OpenPullRequest {
  number: number;
  title: string;
  isDraft: boolean;
  mergeStateStatus: string;
  headRefOid?: string;
  baseRefOid?: string;
  labels?: { name: string }[];
}

export interface ActiveLane {
  laneId: string;
  prNumber?: number;
  sessionName: string;
  state: string;
  summary: SoakSummary | null;
  evidenceJson: 'present' | 'missing';
}

export interface IdleCandidate {
  number: number;
  title: string;
  isDraft: boolean;
  mergeStateStatus: string;
  reason: string;
}

export interface BlockedCandidate extends IdleCandidate {
  blockingLabels: string[];
}

export interface SoakLaneDashboard {
  generatedAt: string;
  currentMainSha: string;
  activeLanes: ActiveLane[];
  idleCandidates: IdleCandidate[];
  blockedCandidates: BlockedCandidate[];
}

function linesOf(text: string): string[] {
  return text.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function firstToken(value: string): string {
  const trimmed = value.trim();
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === ' ' || char === '\t') {
      return trimmed.slice(0, i);
    }
  }
  return trimmed;
}

function prNumberFromSessionName(sessionName: string): number | null {
  const lower = sessionName.toLowerCase();
  if (!lower.startsWith('pr')) return null;
  let offset = 2;
  if (sessionName[offset] === '-') offset += 1;
  let end = offset;
  while (end < sessionName.length && sessionName[end] >= '0' && sessionName[end] <= '9') {
    end += 1;
  }
  if (end === offset) return null;
  return Number.parseInt(sessionName.slice(offset, end), 10);
}

function trainIdFromSessionName(sessionName: string): string | null {
  const match = /^train-[a-z0-9]+(?:-|$)/i.exec(sessionName);
  return match === null ? null : match[0].replace(/-$/, '').toLowerCase();
}

function parseScreenSessionLine(line: string): ScreenSoakSession | null {
  const stateEnd = line.lastIndexOf(')');
  const stateStart = stateEnd === line.length - 1 ? line.lastIndexOf('(') : -1;
  if (stateStart === -1 || stateStart >= stateEnd) return null;

  const screenToken = firstToken(line.slice(0, stateStart));
  const dot = screenToken.indexOf('.');
  const sessionName = dot === -1 ? screenToken : screenToken.slice(dot + 1);
  const prNumber = prNumberFromSessionName(sessionName);
  const trainId = trainIdFromSessionName(sessionName);
  if (prNumber === null && trainId === null) return null;

  return {
    laneId: prNumber === null ? trainId as string : `#${prNumber}`,
    ...(prNumber === null ? {} : { prNumber }),
    sessionName,
    state: line.slice(stateStart + 1, stateEnd),
  };
}

export function parseScreenSessions(output: string): ScreenSoakSession[] {
  return linesOf(output)
    .map((line) => parseScreenSessionLine(line.trim()))
    .filter((session): session is ScreenSoakSession => session !== null);
}

function numberField(line: string, field: string): number | null {
  const prefix = `${field}=`;
  const start = line.indexOf(prefix);
  if (start === -1) return null;
  let end = start + prefix.length;
  while (end < line.length && line[end] >= '0' && line[end] <= '9') {
    end += 1;
  }
  if (end === start + prefix.length) return null;
  return Number.parseInt(line.slice(start + prefix.length, end), 10);
}

function textField(line: string, field: string): string | null {
  const prefix = `${field}=`;
  const start = line.indexOf(prefix);
  if (start === -1) return null;
  let end = start + prefix.length;
  while (end < line.length && line[end] !== ' ' && line[end] !== '\t') {
    end += 1;
  }
  return line.slice(start + prefix.length, end);
}

function statusesField(line: string): string | null {
  const prefix = 'statuses[';
  const start = line.indexOf(prefix);
  if (start === -1) return null;
  const valueStart = start + prefix.length;
  const end = line.indexOf(']', valueStart);
  return end === -1 ? null : line.slice(valueStart, end);
}

function parseHeaderLine(line: string): Pick<SoakSummary, 'elapsedSeconds' | 'total'> | null {
  const prefix = '[t+';
  if (!line.startsWith(prefix)) return null;
  const elapsedEnd = line.indexOf('s]');
  if (elapsedEnd === -1) return null;
  const elapsedSeconds = Number.parseInt(line.slice(prefix.length, elapsedEnd), 10);
  const total = numberField(line, 'total');
  if (!Number.isFinite(elapsedSeconds) || total === null) return null;
  return { elapsedSeconds, total };
}

function parseModeLine(line: string, header: Pick<SoakSummary, 'elapsedSeconds' | 'total'>): SoakSummary | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const mode = firstToken(trimmed);
  const ok = numberField(trimmed, 'ok');
  const fail = numberField(trimmed, 'fail');
  const errorRate = textField(trimmed, 'err');
  const statuses = statusesField(trimmed);
  if (ok === null || fail === null || errorRate === null || statuses === null) return null;
  return {
    ...header,
    mode,
    ok,
    fail,
    errorRate,
    statuses,
  };
}

export function parseLatestSoakSummary(logText: string): SoakSummary | null {
  let currentHeader: Pick<SoakSummary, 'elapsedSeconds' | 'total'> | null = null;
  let latest: SoakSummary | null = null;

  for (const line of linesOf(logText)) {
    const header = parseHeaderLine(line);
    if (header !== null) {
      currentHeader = header;
      continue;
    }
    if (currentHeader === null) continue;
    latest = parseModeLine(line, currentHeader) ?? latest;
  }

  return latest;
}

export function parseOpenPullRequests(json: string): OpenPullRequest[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError('Expected gh PR list JSON to be an array.');
  }
  return parsed.map((item) => {
    const pr = item as Partial<OpenPullRequest>;
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ''),
      isDraft: Boolean(pr.isDraft),
      mergeStateStatus: String(pr.mergeStateStatus ?? 'UNKNOWN'),
      headRefOid: pr.headRefOid,
      baseRefOid: pr.baseRefOid,
      labels: Array.isArray(pr.labels) ? pr.labels.map(normalizeLabel) : [],
    };
  });
}

function normalizeLabel(label: unknown): { name: string } {
  if (typeof label !== 'object' || label === null || !('name' in label)) {
    return { name: '' };
  }
  const { name } = label;
  return { name: typeof name === 'string' ? name : '' };
}

export function soakCandidateReason(pr: OpenPullRequest): string | null {
  const title = pr.title.toLowerCase();
  if (/\bt3\b/.test(title) || /\bmigration\s+\d{4}\b/.test(title) || /\bsoak pending\b/.test(title)) {
    return 'T3/migration/soak-pending';
  }
  return null;
}

function blockingLabels(pr: OpenPullRequest): string[] {
  const labels = pr.labels ?? [];
  return labels
    .map((label) => label.name.toLowerCase())
    .filter((name) => name === 'do-not-merge' || name === 'no-touch' || name === 'blocked');
}

function safeCell(value: string): string {
  return value.split('|').join(String.raw`\|`).split(/\r?\n/).join(' ');
}

function renderActiveLaneRows(lanes: ActiveLane[]): string[] {
  if (lanes.length === 0) {
    return ['| none | - | - | - | - | - | - | - |'];
  }
  return lanes.map((lane) => {
    const s = lane.summary;
    return `| ${safeCell(lane.laneId)} | ${safeCell(lane.state)} | ${s?.mode ?? '-'} | ${s?.ok ?? '-'} | ${s?.fail ?? '-'} | ${s?.errorRate ?? '-'} | ${safeCell(s?.statuses ?? '-')} | ${lane.evidenceJson} |`;
  });
}

function renderIdleCandidateRows(candidates: IdleCandidate[]): string[] {
  if (candidates.length === 0) {
    return ['| none | - | - | - | - |'];
  }
  return candidates.map((pr) =>
    `| #${pr.number} | ${pr.isDraft ? 'draft' : 'ready'} | ${safeCell(pr.mergeStateStatus)} | ${safeCell(pr.reason)} | ${safeCell(pr.title)} |`,
  );
}

function renderBlockedCandidateRows(candidates: BlockedCandidate[]): string[] {
  if (candidates.length === 0) {
    return ['| none | - | - | - | - | - |'];
  }
  return candidates.map((pr) =>
    `| #${pr.number} | ${pr.isDraft ? 'draft' : 'ready'} | ${safeCell(pr.mergeStateStatus)} | ${safeCell(pr.blockingLabels.join(', '))} | ${safeCell(pr.reason)} | ${safeCell(pr.title)} |`,
  );
}

export function renderSoakLaneDashboard(dashboard: SoakLaneDashboard): string {
  const lines = [
    `# Soak Lane Dashboard - ${dashboard.generatedAt}`,
    '',
    `Current main SHA: \`${dashboard.currentMainSha || 'unknown'}\``,
    '',
    '## Active Soak Lanes',
    '',
    '| Lane | Screen state | Mode | OK | Fail | Error rate | Statuses | Final JSON |',
    '| --- | --- | --- | ---: | ---: | --- | --- | --- |',
    ...renderActiveLaneRows(dashboard.activeLanes),
    '',
    '## Idle Soak Candidates',
    '',
    '| PR | Draft | Merge state | Reason | Title |',
    '| --- | --- | --- | --- | --- |',
    ...renderIdleCandidateRows(dashboard.idleCandidates),
    '',
    '## Blocked Soak Candidates',
    '',
    '| PR | Draft | Merge state | Blocking labels | Reason | Title |',
    '| --- | --- | --- | --- | --- | --- |',
    ...renderBlockedCandidateRows(dashboard.blockedCandidates),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function execText(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const maybe = err as { stdout?: Buffer | string };
    return typeof maybe.stdout === 'string' ? maybe.stdout : maybe.stdout?.toString('utf8') ?? '';
  }
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return [path];
  });
}

function newestMatchingFile(root: string, predicate: (path: string) => boolean): string | null {
  const files = listFiles(root).filter(predicate);
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function evidenceRootForSession(evidenceRoot: string, session: ScreenSoakSession): string {
  if (session.prNumber !== undefined) return join(evidenceRoot, `pr-${session.prNumber}`);
  return join(evidenceRoot, session.laneId);
}

function evidenceStateForSession(evidenceRoot: string, session: ScreenSoakSession): 'present' | 'missing' {
  const root = evidenceRootForSession(evidenceRoot, session);
  const evidence = newestMatchingFile(root, (path) => path.endsWith('.json') && path.includes('soak'));
  return evidence === null ? 'missing' : 'present';
}

function logHintsForSession(session: ScreenSoakSession): string[] {
  const suffix = session.prNumber === undefined
    ? session.sessionName.replace(new RegExp(`^${session.laneId}-?`, 'i'), '')
    : session.sessionName.replace(/^pr-?\d+-?/, '');
  if (!suffix || suffix === session.sessionName) return [];
  const normalizedSuffix = suffix.replace('-soak-', '-');
  const prefix = session.prNumber === undefined ? `soak-${session.laneId}` : `soak-pr-${session.prNumber}`;
  return [...new Set([`${prefix}-${suffix}`, `${prefix}-${normalizedSuffix}`])];
}

function summaryForSession(evidenceRoot: string, session: ScreenSoakSession): SoakSummary | null {
  const root = evidenceRootForSession(evidenceRoot, session);
  const hints = logHintsForSession(session);
  const log = newestMatchingFile(
    root,
    (path) => path.endsWith('.stdout.log') && hints.some((hint) => basename(path).includes(hint)),
  );
  const fallbackLog = log ?? newestMatchingFile(root, (path) => path.endsWith('.stdout.log') && path.includes('soak'));
  if (fallbackLog === null) return null;
  return parseLatestSoakSummary(readFileSync(fallbackLog, 'utf8'));
}

function collectOpenPullRequests(repo: string, cwd: string): OpenPullRequest[] {
  const output = execText('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,title,isDraft,mergeStateStatus,headRefOid,baseRefOid,labels',
  ], cwd);
  if (!output.trim()) return [];
  return parseOpenPullRequests(output);
}

function currentMainSha(cwd: string): string {
  const output = execText('git', ['ls-remote', 'origin', 'refs/heads/main'], cwd).trim();
  return output.split(/\s+/)[0] ?? '';
}

export function buildSoakLaneDashboard(input: {
  screenOutput: string;
  openPullRequests: OpenPullRequest[];
  evidenceRoot: string;
  generatedAt: string;
  currentMainSha: string;
}): SoakLaneDashboard {
  const sessions = parseScreenSessions(input.screenOutput);
  const activePrs = new Set(
    sessions.flatMap((session) => session.prNumber === undefined ? [] : [session.prNumber]),
  );
  const activeLanes = sessions.map((session) => ({
    ...session,
    summary: summaryForSession(input.evidenceRoot, session),
    evidenceJson: evidenceStateForSession(input.evidenceRoot, session),
  }));
  const candidateEntries = input.openPullRequests
    .map((pr) => ({ pr, reason: soakCandidateReason(pr) }))
    .filter((entry): entry is { pr: OpenPullRequest; reason: string } => entry.reason !== null)
    .filter(({ pr }) => !activePrs.has(pr.number));
  const idleCandidates = candidateEntries
    .filter(({ pr }) => blockingLabels(pr).length === 0)
    .map(({ pr, reason }) => ({
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      reason,
    }));
  const blockedCandidates = candidateEntries
    .map(({ pr, reason }) => ({ pr, reason, labels: blockingLabels(pr) }))
    .filter(({ labels }) => labels.length > 0)
    .map(({ pr, reason, labels }) => ({
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      mergeStateStatus: pr.mergeStateStatus,
      reason,
      blockingLabels: labels,
    }));

  return {
    generatedAt: input.generatedAt,
    currentMainSha: input.currentMainSha,
    activeLanes,
    idleCandidates,
    blockedCandidates,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.GITHUB_REPOSITORY ?? 'carson-see/ArkovaCarson' },
      'evidence-root': { type: 'string', default: '/Volumes/Extreme/Arkova/release-evidence' },
      json: { type: 'boolean', default: false },
    },
  });
  const cwd = process.cwd();
  const screenOutput = execText('screen', ['-ls'], cwd);
  const openPullRequests = collectOpenPullRequests(String(values.repo), cwd);
  const dashboard = buildSoakLaneDashboard({
    screenOutput,
    openPullRequests,
    evidenceRoot: String(values['evidence-root']),
    generatedAt: new Date().toISOString(),
    currentMainSha: currentMainSha(cwd),
  });
  if (values.json) {
    console.log(JSON.stringify(dashboard, null, 2));
  } else {
    console.log(renderSoakLaneDashboard(dashboard));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
