import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  rewrites: Array<{ source: string; destination: string }>;
};

describe('app signing-key discovery', () => {
  it('serves the key registry from the same production authority as DID discovery', () => {
    const did = config.rewrites.find((route) => route.source === '/.well-known/did.json');
    const keys = config.rewrites.filter((route) => route.source === '/.well-known/arkova-keys.json');
    expect(did).toBeDefined();
    expect(keys).toHaveLength(1);
    expect(keys[0].destination).toBe(
      new URL('/.well-known/arkova-keys.json', did!.destination).href,
    );
    expect(new URL(keys[0].destination).protocol).toBe('https:');
  });
});
