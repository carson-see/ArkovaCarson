import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSoakLaneDashboard,
  parseLatestSoakSummary,
  parseOpenPullRequests,
  parseScreenSessions,
  renderSoakLaneDashboard,
  soakCandidateReason,
} from './soak-lanes';

describe('soak lane dashboard helpers', () => {
  it('extracts active PR soak sessions from screen output', () => {
    const sessions = parseScreenSessions(`
There is a screen on:
\t48473.pr1055-t3-cron-soak-20260608T222454Z\t(Detached)
1 Socket in /tmp/.screen.
`);

    expect(sessions).toEqual([
      {
        laneId: '#1055',
        prNumber: 1055,
        sessionName: 'pr1055-t3-cron-soak-20260608T222454Z',
        state: 'Detached',
      },
    ]);
  });

  it('extracts active named release train soak sessions from screen output', () => {
    const sessions = parseScreenSessions(`
There are screens on:
\t54600.train-a-t3-cron-soak-20260611T141256Z\t(Detached)
\t54657.train-b-t3-cron-soak-20260611T141256Z\t(Detached)
2 Sockets in /tmp/.screen.
`);

    expect(sessions).toEqual([
      {
        laneId: 'train-a',
        sessionName: 'train-a-t3-cron-soak-20260611T141256Z',
        state: 'Detached',
      },
      {
        laneId: 'train-b',
        sessionName: 'train-b-t3-cron-soak-20260611T141256Z',
        state: 'Detached',
      },
    ]);
  });

  it('parses the latest minute soak summary', () => {
    const summary = parseLatestSoakSummary(`
[t+142633s] total=2380 rate=0.0/s
  cron       ok=2380 fail=0 err=0.0% p50=459ms p95=1159ms p99=2074ms statuses[200=2380]
`);

    expect(summary).toEqual({
      elapsedSeconds: 142633,
      total: 2380,
      mode: 'cron',
      ok: 2380,
      fail: 0,
      errorRate: '0.0%',
      statuses: '200=2380',
    });
  });

  it('classifies T3 and soak-pending PRs as idle soak candidates', () => {
    const prs = parseOpenPullRequests(JSON.stringify([
      { number: 1100, title: 'fix: anon metadata [T3, migration 0334, soak PENDING]', isDraft: true, mergeStateStatus: 'BLOCKED' },
      { number: 1105, title: 'chore(worker): eslint warnings [T0/T1]', isDraft: true, mergeStateStatus: 'BLOCKED' },
    ]));

    expect(soakCandidateReason(prs[0])).toBe('T3/migration/soak-pending');
    expect(soakCandidateReason(prs[1])).toBeNull();
  });

  it('renders active and idle lanes in one report', () => {
    const dashboard = renderSoakLaneDashboard({
      generatedAt: '2026-06-10T14:00:00Z',
      currentMainSha: '6779deb527f4de64ef183c438bc8b24dc9f0740a',
      activeLanes: [
        {
          laneId: '#1055',
          prNumber: 1055,
          sessionName: 'pr1055-t3-cron-soak-20260608T222454Z',
          state: 'Detached',
          summary: {
            elapsedSeconds: 142633,
            total: 2380,
            mode: 'cron',
            ok: 2380,
            fail: 0,
            errorRate: '0.0%',
            statuses: '200=2380',
          },
          evidenceJson: 'missing',
        },
      ],
      idleCandidates: [
        {
          number: 1100,
          title: 'fix: anon metadata [T3, migration 0334, soak PENDING]',
          isDraft: true,
          mergeStateStatus: 'BLOCKED',
          reason: 'T3/migration/soak-pending',
        },
      ],
      blockedCandidates: [
        {
          number: 1087,
          title: 'chore(worker): split runtime dependency bumps from 1071 (T3)',
          isDraft: true,
          mergeStateStatus: 'BLOCKED',
          reason: 'T3/migration/soak-pending',
          blockingLabels: ['do-not-merge'],
        },
      ],
    });

    expect(dashboard).toContain('| #1055 | Detached | cron | 2380 | 0 | 0.0% | 200=2380 | missing |');
    expect(dashboard).toContain('| #1100 | draft | BLOCKED | T3/migration/soak-pending | fix: anon metadata [T3, migration 0334, soak PENDING] |');
    expect(dashboard).toContain('| #1087 | draft | BLOCKED | do-not-merge | T3/migration/soak-pending | chore(worker): split runtime dependency bumps from 1071 (T3) |');
  });

  it('uses the log matching the active screen session before older stale logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'soak-lanes-'));
    const prRoot = join(root, 'pr-1055');
    mkdirSync(prRoot);
    const staleLog = join(prRoot, 'soak-pr-1055-t3-20260608T222011Z.stdout.log');
    const activeLog = join(prRoot, 'soak-pr-1055-t3-cron-20260608T222454Z.stdout.log');
    writeFileSync(staleLog, '[t+1s] total=10 rate=0.0/s\n  events     ok=0 fail=10 err=100.0% p50=1ms p95=1ms p99=1ms statuses[401=10]\n');
    writeFileSync(activeLog, '[t+2s] total=2380 rate=0.0/s\n  cron       ok=2380 fail=0 err=0.0% p50=1ms p95=1ms p99=1ms statuses[200=2380]\n');
    const newer = new Date('2026-06-10T10:00:00Z');
    const older = new Date('2026-06-10T09:00:00Z');
    utimesSync(staleLog, newer, newer);
    utimesSync(activeLog, older, older);

    const dashboard = buildSoakLaneDashboard({
      screenOutput: '48473.pr1055-t3-cron-soak-20260608T222454Z\t(Detached)\n',
      openPullRequests: [],
      evidenceRoot: root,
      generatedAt: '2026-06-10T14:00:00Z',
      currentMainSha: '6779deb527f4de64ef183c438bc8b24dc9f0740a',
    });

    expect(dashboard.activeLanes[0].summary?.mode).toBe('cron');
    expect(dashboard.activeLanes[0].summary?.ok).toBe(2380);
    expect(dashboard.activeLanes[0].summary?.fail).toBe(0);
  });

  it('uses train evidence roots for named train screen sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'soak-lanes-'));
    const trainRoot = join(root, 'train-a');
    mkdirSync(trainRoot);
    writeFileSync(
      join(trainRoot, 'soak-train-a-t3-cron-20260611T141256Z.stdout.log'),
      '[t+6666s] total=115 rate=0.0/s\n  cron       ok=115 fail=0 err=0.0% p50=1ms p95=2ms p99=3ms statuses[200=115]\n',
    );

    const dashboard = buildSoakLaneDashboard({
      screenOutput: '54600.train-a-t3-cron-soak-20260611T141256Z\t(Detached)\n',
      openPullRequests: [],
      evidenceRoot: root,
      generatedAt: '2026-06-11T16:00:00Z',
      currentMainSha: '3f906c991988f9b2ed6e71e1a70b64020cebd2fb',
    });

    expect(dashboard.activeLanes[0]).toMatchObject({
      laneId: 'train-a',
      summary: {
        mode: 'cron',
        ok: 115,
        fail: 0,
        statuses: '200=115',
      },
    });
  });

  it('moves blocked-label PRs out of the ready idle soak candidates', () => {
    const dashboard = buildSoakLaneDashboard({
      screenOutput: '',
      openPullRequests: parseOpenPullRequests(JSON.stringify([
        {
          number: 1087,
          title: 'chore(worker): split runtime dependency bumps from 1071 (T3)',
          isDraft: true,
          mergeStateStatus: 'BLOCKED',
          labels: [{ name: 'do-not-merge' }],
        },
        {
          number: 1100,
          title: 'fix: anon metadata [T3, migration 0334, soak PENDING]',
          isDraft: true,
          mergeStateStatus: 'BLOCKED',
          labels: [{ name: 'migration' }],
        },
      ])),
      evidenceRoot: mkdtempSync(join(tmpdir(), 'soak-lanes-')),
      generatedAt: '2026-06-10T14:00:00Z',
      currentMainSha: '6779deb527f4de64ef183c438bc8b24dc9f0740a',
    });

    expect(dashboard.idleCandidates.map((pr) => pr.number)).toEqual([1100]);
    expect(dashboard.blockedCandidates).toMatchObject([
      {
        number: 1087,
        blockingLabels: ['do-not-merge'],
      },
    ]);
  });
});
