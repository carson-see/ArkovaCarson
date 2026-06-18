import { describe, it, expect } from 'vitest';
import { auditAgentsMd } from './check-agents-md-migration-collision.ts';

describe('auditAgentsMd — migration agents.md collision lint (S0-4.3 / CLAUDE.md §6)', () => {
  it('passes when every Recent-migrations block carries a distinct (PR #NNNN) discriminator', () => {
    const content = [
      '## Recent migrations (PR #817)',
      '- 0311_x.sql: ...',
      '## Recent migrations (PR #788)',
      '- 0300_y.sql: ...',
    ].join('\n');
    expect(auditAgentsMd(content)).toEqual([]);
  });

  it('accepts a SCRUM-id (or any parenthetical) discriminator — the legitimate historical form', () => {
    const content = [
      '## Recent migrations (SCRUM-2044)',
      '- a',
      '## Recent migrations (PR #868, renumbered from closed PR #807)',
      '- b',
    ].join('\n');
    expect(auditAgentsMd(content)).toEqual([]);
  });

  it('FAILS a bare "## Recent migrations" header with no discriminator', () => {
    const content = ['## Recent migrations', '- 0342_z.sql: ...'].join('\n');
    expect(auditAgentsMd(content).map((v) => v.code)).toContain('recent-migrations-missing-discriminator');
  });

  it('FAILS two identical headers (the #1031/#1022 EOF collision class)', () => {
    const content = [
      '## Recent migrations (PR #1031)',
      '- a',
      '## Recent migrations (PR #1031)',
      '- b',
    ].join('\n');
    expect(auditAgentsMd(content).map((v) => v.code)).toContain('recent-migrations-duplicate-header');
  });

  it('ignores headers that are not Recent-migrations blocks', () => {
    const content = ['## Release-drain migration reservations', '## Recent migrations (PR #42)'].join('\n');
    expect(auditAgentsMd(content)).toEqual([]);
  });
});
