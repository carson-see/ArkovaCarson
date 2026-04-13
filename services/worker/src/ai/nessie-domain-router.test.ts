/**
 * Tests for Nessie Domain Router (NMT-16)
 */

import { describe, it, expect } from 'vitest';
import {
  routeToDomain,
  isAdapterTrained,
  getTrainedAdapters,
  ROUTER_CONFIG,
  ACADEMIC_TYPES,
} from './nessie-domain-router.js';

describe('nessie-domain-router', () => {
  describe('routeToDomain — credential type routing', () => {
    it('routes SEC_FILING to sec adapter', () => {
      expect(routeToDomain('SEC_FILING').domain).toBe('sec');
    });

    it('routes FINANCIAL to sec adapter', () => {
      expect(routeToDomain('FINANCIAL').domain).toBe('sec');
    });

    it('routes LEGAL to legal adapter', () => {
      expect(routeToDomain('LEGAL').domain).toBe('legal');
    });

    it('routes REGULATION to regulatory adapter', () => {
      expect(routeToDomain('REGULATION').domain).toBe('regulatory');
    });

    it('routes CHARITY to regulatory adapter', () => {
      expect(routeToDomain('CHARITY').domain).toBe('regulatory');
    });

    it('routes DEGREE to academic adapter', () => {
      expect(routeToDomain('DEGREE').domain).toBe('academic');
    });

    it('routes PUBLICATION to academic adapter', () => {
      expect(routeToDomain('PUBLICATION').domain).toBe('academic');
    });

    it('routes ACCREDITATION to academic adapter', () => {
      expect(routeToDomain('ACCREDITATION').domain).toBe('academic');
    });

    // NMT-16: New domain groups (adapters are placeholder → fall back to default)
    it('routes LICENSE to default (professional adapter untrained)', () => {
      expect(routeToDomain('LICENSE').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes CLE to default (professional adapter untrained)', () => {
      expect(routeToDomain('CLE').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes BADGE to default (professional adapter untrained)', () => {
      expect(routeToDomain('BADGE').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes ATTESTATION to default (professional adapter untrained)', () => {
      expect(routeToDomain('ATTESTATION').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes MILITARY to default (identity adapter untrained)', () => {
      expect(routeToDomain('MILITARY').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes RESUME to default (identity adapter untrained)', () => {
      expect(routeToDomain('RESUME').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes MEDICAL to default (identity adapter untrained)', () => {
      expect(routeToDomain('MEDICAL').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes PATENT to academic adapter', () => {
      expect(routeToDomain('PATENT').domain).toBe('academic');
    });

    it('routes IDENTITY to default (identity adapter untrained)', () => {
      // Identity adapter is placeholder, so falls back to default
      expect(routeToDomain('IDENTITY').domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('is case-insensitive', () => {
      expect(routeToDomain('sec_filing').domain).toBe('sec');
      expect(routeToDomain('legal').domain).toBe('legal');
    });
  });

  describe('routeToDomain — keyword routing', () => {
    it('routes SEC keywords to sec adapter', () => {
      const result = routeToDomain(undefined, 'This is an EDGAR 10-K filing');
      expect(result.domain).toBe('sec');
    });

    it('routes legal keywords to legal adapter', () => {
      const result = routeToDomain(undefined, 'court opinion from the circuit court');
      expect(result.domain).toBe('legal');
    });

    it('routes professional keywords to default (adapter untrained)', () => {
      const result = routeToDomain(undefined, 'CLE continuing education certificate for license');
      expect(result.domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('routes identity keywords to default (adapter untrained)', () => {
      const result = routeToDomain(undefined, 'DD-214 military service record veteran');
      expect(result.domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });

    it('returns default adapter for unknown text', () => {
      const result = routeToDomain(undefined, 'hello world');
      expect(result.domain).toBe(ROUTER_CONFIG.defaultAdapter);
    });
  });

  describe('isAdapterTrained', () => {
    it('returns true for SEC adapter (has real model ID)', () => {
      expect(isAdapterTrained(ROUTER_CONFIG.adapters.sec)).toBe(true);
    });

    it('returns true for academic adapter', () => {
      expect(isAdapterTrained(ROUTER_CONFIG.adapters.academic)).toBe(true);
    });

    it('returns false for professional adapter (placeholder)', () => {
      expect(isAdapterTrained(ROUTER_CONFIG.adapters.professional)).toBe(false);
    });

    it('returns false for identity adapter (placeholder)', () => {
      expect(isAdapterTrained(ROUTER_CONFIG.adapters.identity)).toBe(false);
    });
  });

  describe('getTrainedAdapters', () => {
    it('returns only adapters with non-placeholder model IDs', () => {
      const trained = getTrainedAdapters();
      expect(trained.length).toBe(4); // sec, academic, legal, regulatory
      expect(trained.every(a => !a.modelId.startsWith('placeholder'))).toBe(true);
    });
  });

  describe('type sets', () => {
    it('has PATENT in academic types (not identity)', () => {
      expect(ACADEMIC_TYPES.has('PATENT')).toBe(true);
    });
  });

  describe('ROUTER_CONFIG', () => {
    it('has 6 adapters (4 existing + 2 new)', () => {
      expect(Object.keys(ROUTER_CONFIG.adapters)).toHaveLength(6);
    });

    it('has all required domains', () => {
      const domains = Object.keys(ROUTER_CONFIG.adapters);
      expect(domains).toContain('sec');
      expect(domains).toContain('academic');
      expect(domains).toContain('legal');
      expect(domains).toContain('regulatory');
      expect(domains).toContain('professional');
      expect(domains).toContain('identity');
    });
  });
});
