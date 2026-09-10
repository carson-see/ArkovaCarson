/**
 * `public/.well-known/agent-skills/index.json` publishes a `sha256:` digest for
 * every SKILL.md it lists. A client that honours the discovery spec fetches the
 * skill, hashes it, and REFUSES the mismatch — so a digest that trails its file
 * does not degrade to stale guidance, it takes the skill offline for anyone
 * checking, while looking perfectly healthy in the repo.
 *
 * Nothing recomputed those digests. The tool-name corrections in this change
 * would have shipped exactly that way: two edited SKILL.md files, two digests
 * still describing the previous bytes.
 *
 * The test hashes the files on disk. It is deliberately not a snapshot of the
 * expected hex — a snapshot would have to be updated by the same hand that
 * edited the file, which is the step that gets skipped.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SKILLS_DIR = join(ROOT, 'public', '.well-known', 'agent-skills');
const INDEX = join(SKILLS_DIR, 'index.json');

interface SkillEntry {
  name: string;
  type: string;
  description: string;
  url: string;
  digest: string;
}

const index = JSON.parse(readFileSync(INDEX, 'utf-8')) as { skills: SkillEntry[] };

const sha256 = (path: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

describe('agent-skills index.json digests', () => {
  it('lists at least one skill (fail-closed: an empty index proves nothing)', () => {
    expect(index.skills.length).toBeGreaterThan(0);
  });

  it.each(index.skills.map((s) => [s.name, s] as const))(
    'digest for %s matches the SKILL.md on disk',
    (name, skill) => {
      const file = join(SKILLS_DIR, name, 'SKILL.md');
      expect(existsSync(file)).toBe(true);
      expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(skill.digest).toBe(sha256(file));
    },
  );

  it('publishes the URL that corresponds to the file it hashed', () => {
    for (const skill of index.skills) {
      expect(skill.url).toBe(`https://app.arkova.ai/.well-known/agent-skills/${skill.name}/SKILL.md`);
    }
  });

  it('indexes every skill directory that exists — an unlisted skill is undiscoverable', () => {
    const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
    expect(index.skills.map((s) => s.name).sort()).toEqual(onDisk);
  });
});
