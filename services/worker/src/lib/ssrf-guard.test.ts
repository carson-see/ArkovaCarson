/**
 * SCRUM-2483 — ssrf-guard.ts extraction tests.
 *
 * The private-IP classification logic is lifted out of webhooks/delivery.ts
 * into a shared module so safeFetch and the webhook guard share ONE source of
 * truth. These tests pin the classifier behaviour so the extraction stays
 * byte-identical to the delivery.ts original (no behaviour delta).
 */

import { describe, it, expect } from 'vitest';
import { isPrivateIp, isPrivateHostname } from './ssrf-guard.js';

describe('ssrf-guard isPrivateIp', () => {
  it('blocks the cloud metadata IP', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('blocks RFC 1918 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('blocks loopback / link-local / CGNAT / 0.0.0.0', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('169.254.1.1')).toBe(true);
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('0.0.0.0')).toBe(true);
  });

  it('blocks IPv6 loopback / link-local / ULA', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIp('203.0.113.50')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });
});

describe('ssrf-guard isPrivateHostname', () => {
  it('blocks known-internal hostnames', () => {
    expect(isPrivateHostname('localhost')).toBe(true);
    expect(isPrivateHostname('metadata.google.internal')).toBe(true);
  });

  it('does not treat a normal public host as internal by name', () => {
    expect(isPrivateHostname('hooks.slack.com')).toBe(false);
    expect(isPrivateHostname('api.example.com')).toBe(false);
  });
});
