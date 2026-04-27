import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function homepageSchemas(): Array<Record<string, unknown>> {
  const html = readFileSync('index.html', 'utf8');
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g)];
  return scripts.map((match) => JSON.parse(match[1]) as Record<string, unknown>);
}

describe('homepage JSON-LD', () => {
  it('keeps SoftwareApplication and adds Product + Service markup for GRC buyer search intent', () => {
    const schemas = homepageSchemas();
    const byType = new Map(schemas.map((schema) => [schema['@type'], schema]));

    expect(byType.get('SoftwareApplication')).toMatchObject({
      '@id': 'https://arkova.ai/#software',
      name: 'Arkova',
    });
    expect(byType.get('Product')).toMatchObject({
      '@id': 'https://arkova.ai/#product',
      brand: { '@id': 'https://arkova.ai/#org' },
      category: 'Compliance audit software',
      isRelatedTo: { '@id': 'https://arkova.ai/#software' },
    });
    expect(byType.get('Service')).toMatchObject({
      '@id': 'https://arkova.ai/#audit-automation-service',
      serviceType: 'Compliance audit automation',
      provider: { '@id': 'https://arkova.ai/#org' },
    });
  });
});
