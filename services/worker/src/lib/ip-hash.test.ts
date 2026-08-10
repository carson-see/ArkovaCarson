/**
 * Unit tests for the client-IP pseudonymisation primitive.
 *
 * DPA Schedules 1 + 2 warrant "hashed IP addresses". Two properties have to
 * hold for that warranty to be defensible, and each gets a test here:
 *
 *  1. The output is never the input. A raw IP must not survive into anything
 *     we persist, under any argument shape.
 *  2. The digest is KEYED. Bare SHA-256 of an IPv4 is not a pseudonymisation
 *     control — the whole IPv4 space is ~4.3e9 values, enumerable in seconds,
 *     so an unsalted digest is a reversible encoding of the address. The test
 *     below pins that our digest is NOT the bare sha256 an attacker precomputes.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { hashClientIp, auditIpHash, IpPepperUnavailableError } from './ip-hash.js';

const PEPPER = 'test-ip-pepper-0123456789abcdef';
const IPV4 = '203.0.113.42';

describe('hashClientIp', () => {
  it('returns a 64-char hex digest that is not the raw IP', () => {
    const hash = hashClientIp(IPV4, PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203.0.113');
  });

  it('is a KEYED digest — not the bare sha256 an attacker can precompute', () => {
    const bare = createHash('sha256').update(IPV4, 'utf8').digest('hex');
    const keyed = createHmac('sha256', PEPPER).update(IPV4, 'utf8').digest('hex');

    expect(hashClientIp(IPV4, PEPPER)).toBe(keyed);
    expect(hashClientIp(IPV4, PEPPER)).not.toBe(bare);
  });

  it('produces different digests under different peppers (rotation is meaningful)', () => {
    expect(hashClientIp(IPV4, PEPPER)).not.toBe(hashClientIp(IPV4, 'a-different-pepper-value-16+'));
  });

  it('is stable for the same IP + pepper (correlation across requests still works)', () => {
    expect(hashClientIp(IPV4, PEPPER)).toBe(hashClientIp(IPV4, PEPPER));
  });

  it('normalizes an IPv4-mapped IPv6 address to its IPv4 form', () => {
    // Express reports `::ffff:203.0.113.42` when the socket is dual-stack and
    // no proxy header is trusted. Same client, same digest — otherwise abuse
    // correlation silently splits in two.
    expect(hashClientIp('::ffff:203.0.113.42', PEPPER)).toBe(hashClientIp(IPV4, PEPPER));
  });

  it('normalizes IPv6 case and surrounding whitespace', () => {
    expect(hashClientIp('  2001:DB8::1  ', PEPPER)).toBe(hashClientIp('2001:db8::1', PEPPER));
  });

  it('returns undefined for an absent or blank IP (nothing to hash)', () => {
    expect(hashClientIp(null, PEPPER)).toBeUndefined();
    expect(hashClientIp(undefined, PEPPER)).toBeUndefined();
    expect(hashClientIp('   ', PEPPER)).toBeUndefined();
  });

  it('throws rather than falling back to a bare sha256 when the pepper is unset', () => {
    expect(() => hashClientIp(IPV4, undefined)).toThrow(IpPepperUnavailableError);
    expect(() => hashClientIp(IPV4, '')).toThrow(IpPepperUnavailableError);
  });
});

describe('auditIpHash', () => {
  it('returns the keyed digest when a pepper is available', () => {
    expect(auditIpHash(IPV4, PEPPER)).toBe(hashClientIp(IPV4, PEPPER));
  });

  it('returns null — never the raw IP — when the pepper is unavailable', () => {
    // Fire-and-forget audit writers cannot throw. They must degrade to "no
    // value" and never to "the raw value".
    const result = auditIpHash(IPV4, undefined);
    expect(result).toBeNull();
    expect(result).not.toBe(IPV4);
  });

  it('returns null for an absent IP', () => {
    expect(auditIpHash(null, PEPPER)).toBeNull();
    expect(auditIpHash(undefined, PEPPER)).toBeNull();
  });
});
