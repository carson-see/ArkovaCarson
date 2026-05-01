import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'supabase/migrations/0284_webhooks_public_id.sql'),
  'utf8',
);

describe('SCRUM-1445 webhook public-id migration', () => {
  it('generates endpoint public IDs in the database before NOT NULL enforcement', () => {
    expect(migration).toContain('CREATE TRIGGER set_webhook_endpoint_public_id');
    expect(migration).toContain('BEFORE INSERT ON webhook_endpoints');
    expect(migration).toContain("NEW.public_id := NULLIF(btrim(NEW.public_id), '')");
  });

  it('normalizes blank organization prefixes to IND for trigger and backfill paths', () => {
    expect(migration).toContain("COALESCE(NULLIF(btrim(v_org_prefix), ''), 'IND')");
    expect(migration).toContain("COALESCE(NULLIF(btrim(o.org_prefix), ''), 'IND')");
  });

  it('generates delivery-log public IDs even when callers explicitly insert blank values', () => {
    expect(migration).toContain('CREATE TRIGGER set_webhook_delivery_log_public_id');
    expect(migration).toContain('BEFORE INSERT ON webhook_delivery_logs');
    expect(migration).toContain("NEW.public_id := 'DLV-'");
  });
});
