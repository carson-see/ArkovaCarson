import { describe, it, expect } from 'vitest';
import { toJsonLd } from './jsonLd';

describe('toJsonLd (SCRUM-4989 review)', () => {
  it('escapes </script so a string field cannot close the JSON-LD block', () => {
    const out = toJsonLd({ name: 'x</script><script>alert(1)</script>' });
    expect(out).not.toContain('</script');
    expect(out).toContain('<\\/script');
    expect(JSON.parse(out)).toEqual({ name: 'x</script><script>alert(1)</script>' });
  });

  it('is case-insensitive on the closing tag', () => {
    expect(toJsonLd({ a: '</SCRIPT>' })).not.toMatch(/<\/script/i);
  });

  it('leaves ordinary values untouched', () => {
    expect(toJsonLd({ a: 1, b: 'plain' })).toBe('{"a":1,"b":"plain"}');
  });
});
