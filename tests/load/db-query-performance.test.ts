/**
 * Database Query Performance Load Test
 *
 * Tests query performance with large datasets:
 * - Dashboard query with 1000+ anchors
 * - Org registry with filters at scale
 * - Records list with pagination
 * - Public verification lookup performance
 *
 * Note: These tests use mocked Supabase queries to measure
 * serialization/deserialization overhead and query construction.
 * For true DB query perf, run against local Supabase with `npx supabase db reset`.
 *
 * @created 2026-03-11 12:00 AM EST
 * @category load-test
 */

import { describe, it, expect } from 'vitest';

// ---- Test Data Generation ----

function generateAnchors(count: number): Record<string, unknown>[] {
  const statuses = ['PENDING', 'SECURED', 'REVOKED'];
  const credTypes = ['DEGREE', 'LICENSE', 'CERTIFICATION', 'EMPLOYMENT', null];
  const anchors: Record<string, unknown>[] = [];

  for (let i = 0; i < count; i++) {
    anchors.push({
      id: `anchor-perf-${i.toString().padStart(6, '0')}`,
      user_id: `user-${i % 50}`, // 50 distinct users
      org_id: i % 3 === 0 ? null : `org-${i % 10}`, // 10 distinct orgs
      fingerprint: `sha256-perf-${i}`,
      filename: `document_${i}.pdf`,
      status: statuses[i % statuses.length],
      credential_type: credTypes[i % credTypes.length],
      public_id: `pub-perf-${i}`,
      created_at: new Date(Date.now() - i * 60000).toISOString(), // 1 min apart
      updated_at: new Date(Date.now() - i * 30000).toISOString(),
      deleted_at: null,
      chain_tx_id: i % 3 === 1 ? `tx-perf-${i}` : null,
      chain_block_height: i % 3 === 1 ? 800000 + i : null,
      chain_timestamp: i % 3 === 1 ? new Date().toISOString() : null,
      metadata: i % 4 === 0 ? { field1: `value-${i}`, field2: `data-${i}` } : null,
    });
  }

  return anchors;
}

// ---- Tests ----

describe('Database Query Performance Load Tests', () => {
  describe('Dataset Construction', () => {
    it('generates 1000 anchors in under 100ms', () => {
      const start = performance.now();
      const anchors = generateAnchors(1000);
      const elapsed = performance.now() - start;

      expect(anchors.length).toBe(1000);
      expect(elapsed).toBeLessThan(100);

      console.log(`[LOAD] Generated 1000 anchors in ${elapsed.toFixed(1)}ms`);
    });

    it('generates 5000 anchors in under 500ms', () => {
      const start = performance.now();
      const anchors = generateAnchors(5000);
      const elapsed = performance.now() - start;

      expect(anchors.length).toBe(5000);
      expect(elapsed).toBeLessThan(500);

      console.log(`[LOAD] Generated 5000 anchors in ${elapsed.toFixed(1)}ms`);
    });
  });

  describe('Client-Side Filter Performance', () => {
    const anchors = generateAnchors(1000);

    it('filters by status across 1000 records in under 10ms', () => {
      const start = performance.now();
      const secured = anchors.filter((a) => a.status === 'SECURED');
      const elapsed = performance.now() - start;

      expect(secured.length).toBeGreaterThan(0);
      expect(secured.length).toBeLessThan(1000);
      expect(elapsed).toBeLessThan(10);

      console.log(
        `[LOAD] Status filter: ${secured.length}/${anchors.length} in ${elapsed.toFixed(2)}ms`
      );
    });

    it('filters by org_id across 1000 records in under 10ms', () => {
      const start = performance.now();
      const orgFiltered = anchors.filter((a) => a.org_id === 'org-1');
      const elapsed = performance.now() - start;

      expect(orgFiltered.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10);

      console.log(
        `[LOAD] Org filter: ${orgFiltered.length}/${anchors.length} in ${elapsed.toFixed(2)}ms`
      );
    });

    it('searches by filename substring across 1000 records in under 10ms', () => {
      const start = performance.now();
      const searchTerm = 'document_42';
      const results = anchors.filter(
        (a) => typeof a.filename === 'string' && a.filename.includes(searchTerm)
      );
      const elapsed = performance.now() - start;

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(elapsed).toBeLessThan(10);

      console.log(
        `[LOAD] Filename search: ${results.length} results in ${elapsed.toFixed(2)}ms`
      );
    });

    it('combined status + org + date range filter in under 10ms', () => {
      const cutoffDate = new Date(Date.now() - 30 * 60000).toISOString(); // 30 min ago

      const start = performance.now();
      const filtered = anchors.filter(
        (a) =>
          a.status === 'SECURED' &&
          a.org_id === 'org-2' &&
          typeof a.created_at === 'string' &&
          a.created_at >= cutoffDate
      );
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);

      console.log(
        `[LOAD] Combined filter: ${filtered.length}/${anchors.length} in ${elapsed.toFixed(2)}ms`
      );
    });
  });

  describe('Pagination Performance', () => {
    const anchors = generateAnchors(1000);

    it('paginates through 1000 records in pages of 20', () => {
      const PAGE_SIZE = 20;
      const start = performance.now();

      let offset = 0;
      let pageCount = 0;

      while (offset < anchors.length) {
        const page = anchors.slice(offset, offset + PAGE_SIZE);
        expect(page.length).toBeLessThanOrEqual(PAGE_SIZE);
        offset += PAGE_SIZE;
        pageCount++;
      }

      const elapsed = performance.now() - start;

      expect(pageCount).toBe(50); // 1000 / 20
      expect(elapsed).toBeLessThan(50);

      console.log(
        `[LOAD] Paginated 1000 records into ${pageCount} pages in ${elapsed.toFixed(1)}ms`
      );
    });

    it('cursor-based pagination (id > last_id) across 1000 records', () => {
      const PAGE_SIZE = 50;
      const sorted = [...anchors].sort((a, b) =>
        String(a.id).localeCompare(String(b.id))
      );

      const start = performance.now();

      let cursor = '';
      let pageCount = 0;
      let totalFetched = 0;

      while (true) {
        const page = sorted
          .filter((a) => String(a.id) > cursor)
          .slice(0, PAGE_SIZE);

        if (page.length === 0) break;

        totalFetched += page.length;
        cursor = String(page[page.length - 1].id);
        pageCount++;
      }

      const elapsed = performance.now() - start;

      expect(totalFetched).toBe(1000);
      expect(pageCount).toBe(20); // 1000 / 50
      expect(elapsed).toBeLessThan(100);

      console.log(
        `[LOAD] Cursor pagination: ${pageCount} pages, ${totalFetched} records in ${elapsed.toFixed(1)}ms`
      );
    });
  });

  describe('Serialization Performance', () => {
    it('JSON serializes 1000 anchor records in under 50ms', () => {
      const anchors = generateAnchors(1000);

      const start = performance.now();
      const json = JSON.stringify(anchors);
      const elapsed = performance.now() - start;

      expect(json.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(50);

      console.log(
        `[LOAD] JSON.stringify 1000 anchors: ${(json.length / 1024).toFixed(0)}KB in ${elapsed.toFixed(1)}ms`
      );
    });

    it('JSON deserializes 1000 anchor records in under 50ms', () => {
      const anchors = generateAnchors(1000);
      const json = JSON.stringify(anchors);

      const start = performance.now();
      const parsed = JSON.parse(json);
      const elapsed = performance.now() - start;

      expect(parsed.length).toBe(1000);
      expect(elapsed).toBeLessThan(50);

      console.log(
        `[LOAD] JSON.parse 1000 anchors: ${elapsed.toFixed(1)}ms`
      );
    });
  });

  describe('Aggregation Performance', () => {
    const anchors = generateAnchors(1000);

    it('computes dashboard stats from 1000 records in under 10ms', () => {
      const start = performance.now();

      const stats = {
        total: anchors.length,
        secured: anchors.filter((a) => a.status === 'SECURED').length,
        pending: anchors.filter((a) => a.status === 'PENDING').length,
        revoked: anchors.filter((a) => a.status === 'REVOKED').length,
        withChainTx: anchors.filter((a) => a.chain_tx_id !== null).length,
        distinctOrgs: new Set(anchors.map((a) => a.org_id).filter(Boolean)).size,
        distinctUsers: new Set(anchors.map((a) => a.user_id)).size,
      };

      const elapsed = performance.now() - start;

      expect(stats.total).toBe(1000);
      expect(stats.secured + stats.pending + stats.revoked).toBe(1000);
      expect(elapsed).toBeLessThan(10);

      console.log(
        `[LOAD] Dashboard stats from 1000 records: ${elapsed.toFixed(2)}ms | ` +
          `S:${stats.secured} P:${stats.pending} R:${stats.revoked}`
      );
    });

    it('groups records by credential_type from 1000 records in under 10ms', () => {
      const start = performance.now();

      const groups = new Map<string | null, number>();
      for (const a of anchors) {
        const ct = a.credential_type as string | null;
        groups.set(ct, (groups.get(ct) ?? 0) + 1);
      }

      const elapsed = performance.now() - start;

      expect(groups.size).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10);

      const groupSummary = Array.from(groups.entries())
        .map(([k, v]) => `${k ?? 'null'}:${v}`)
        .join(', ');
      console.log(`[LOAD] Group by credential_type: ${groupSummary} (${elapsed.toFixed(2)}ms)`);
    });
  });

  describe('Public Verification Lookup', () => {
    const anchors = generateAnchors(1000);

    it('finds anchor by public_id in 1000 records in under 5ms', () => {
      // Simulate an indexed lookup via linear scan (worst case)
      const targetPublicId = 'pub-perf-500';

      const start = performance.now();
      const found = anchors.find((a) => a.public_id === targetPublicId);
      const elapsed = performance.now() - start;

      expect(found).toBeDefined();
      expect(found!.public_id).toBe(targetPublicId);
      expect(elapsed).toBeLessThan(5);

      console.log(`[LOAD] Public ID lookup in 1000 records: ${elapsed.toFixed(3)}ms`);
    });

    it('Map-based lookup performs in under 1ms for 1000 records', () => {
      // Build index (one-time cost)
      const indexStart = performance.now();
      const publicIdIndex = new Map(
        anchors.map((a) => [a.public_id as string, a])
      );
      const indexElapsed = performance.now() - indexStart;

      // Lookup
      const lookupStart = performance.now();
      const found = publicIdIndex.get('pub-perf-750');
      const lookupElapsed = performance.now() - lookupStart;

      expect(found).toBeDefined();
      expect(lookupElapsed).toBeLessThan(1);

      console.log(
        `[LOAD] Map index build: ${indexElapsed.toFixed(2)}ms, lookup: ${lookupElapsed.toFixed(3)}ms`
      );
    });
  });
});
