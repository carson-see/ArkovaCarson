/**
 * Guards on the SCRUM-3873 soak driver.
 *
 * The driver's job is to produce evidence that is either honest or absent.
 * These tests pin the ways it must REFUSE — a driver that silently degrades to
 * a health check is worse than no driver, because the soak still looks green.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDriverArgs,
  validateLiveArgs,
  buildRow,
  CHANGED_BEHAVIOR,
} from './scrum3873-provisioning-driver.js';

describe('parseDriverArgs', () => {
  it('defaults to self-test so a bare invocation cannot be mistaken for evidence', () => {
    expect(parseDriverArgs([]).mode).toBe('self-test');
  });

  it('reads the live flag and its arguments', () => {
    const a = parseDriverArgs(['--live', '--target-url', 'https://rig.run.app', '--bearer-token', 't']);
    expect(a.mode).toBe('live');
    expect(a.targetUrl).toBe('https://rig.run.app');
  });
});

describe('validateLiveArgs', () => {
  it('self-test needs nothing', () => {
    expect(validateLiveArgs({ mode: 'self-test' })).toEqual([]);
  });

  it('blocks a live run with no target or tokens', () => {
    const b = validateLiveArgs({ mode: 'live' });
    expect(b.length).toBe(4);
  });

  it('requires the non-admin token — the 403 assertion is the point of this driver', () => {
    const b = validateLiveArgs({
      mode: 'live', targetUrl: 'https://rig.run.app', bearerToken: 't', collisionDomain: 'x.test',
    });
    expect(b.join(' ')).toMatch(/non-admin-token/);
  });

  it('refuses to run against production', () => {
    const b = validateLiveArgs({
      mode: 'live', targetUrl: 'https://app.arkova.ai', bearerToken: 't', nonAdminToken: 'n',
      collisionDomain: 'x.test',
    });
    expect(b.join(' ')).toMatch(/production/);
  });

  it('refuses a non-https target', () => {
    const b = validateLiveArgs({
      mode: 'live', targetUrl: 'http://rig.run.app', bearerToken: 't', nonAdminToken: 'n',
      collisionDomain: 'x.test',
    });
    expect(b.join(' ')).toMatch(/https/);
  });

  it('refuses a live run with no collision domain — F2 would go unexercised', () => {
    const b = validateLiveArgs({
      mode: 'live', targetUrl: 'https://rig.run.app', bearerToken: 't', nonAdminToken: 'n',
    });
    expect(b.join(' ')).toMatch(/collision-domain/);
  });

  it('accepts a fully-specified live run', () => {
    expect(validateLiveArgs({
      mode: 'live', targetUrl: 'https://rig.run.app', bearerToken: 't', nonAdminToken: 'n',
      collisionDomain: 'collide.test',
    })).toEqual([]);
  });
});

describe('buildRow', () => {
  it('never marks a self-test row as soak evidence', () => {
    const row = buildRow('self-test', { counts: {}, checks: {}, ok: true });
    expect(row.evidenceForSoak).toBe(false);
  });

  it('never marks a blocked live row as evidence', () => {
    const row = buildRow('live', { counts: {}, checks: {}, ok: true }, 'https://x', ['blocked']);
    expect(row.evidenceForSoak).toBe(false);
    expect(row.status).toBe('fail');
  });

  it('marks a clean live row as evidence and names the changed behavior', () => {
    const row = buildRow('live', { counts: {}, checks: { a: 'pass' }, ok: true }, 'https://x');
    expect(row.evidenceForSoak).toBe(true);
    expect(row.changedBehavior).toBe(CHANGED_BEHAVIOR);
  });

  it('fails the row when any check failed', () => {
    const row = buildRow('live', { counts: {}, checks: { a: 'FAIL got 200' }, ok: false }, 'https://x');
    expect(row.status).toBe('fail');
  });
});
