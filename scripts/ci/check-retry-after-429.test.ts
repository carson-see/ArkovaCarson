import { describe, expect, it } from 'vitest';
import { scanContent } from './check-retry-after-429.js';

describe('check-retry-after-429', () => {
  it('flags a manual 429 without Retry-After', () => {
    const violations = scanContent('services/worker/src/example.ts', `
      export function handler(req, res) {
        res.status(429).json({ error: 'rate_limited' });
      }
    `);

    expect(violations).toEqual([
      {
        file: 'services/worker/src/example.ts',
        line: 3,
        text: "res.status(429).json({ error: 'rate_limited' });",
      },
    ]);
  });

  it('allows a manual 429 when Retry-After is set first', () => {
    const violations = scanContent('services/worker/src/example.ts', `
      export function handler(req, res) {
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: 'rate_limited' });
      }
    `);

    expect(violations).toEqual([]);
  });

  it('allows Express set() shorthand', () => {
    const violations = scanContent('services/worker/src/example.ts', `
      export function handler(req, res) {
        res.set('Retry-After', retryAfter.toString());
        res.status(429).json({ error: 'rate_limited' });
      }
    `);

    expect(violations).toEqual([]);
  });
});
