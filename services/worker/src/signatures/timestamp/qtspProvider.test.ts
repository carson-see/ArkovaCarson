/**
 * QTSP Provider Tests — Phase III
 *
 * Tests circuit breaker failover, health checks, and multi-TSA management.
 *
 * Story: PH3-ESIG-02 (SCRUM-423)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { DefaultQtspProvider, createQtspProvider } from './qtspProvider.js';
import { MockRfc3161Client } from './rfc3161Client.js';
import type { TsaConfig, TsaRequest } from '../types.js';

const primaryTsa: TsaConfig = {
  name: 'Primary TSA',
  url: 'https://tsa-primary.example.com',
  qualified: true,
  timeoutMs: 5000,
};

const secondaryTsa: TsaConfig = {
  name: 'Secondary TSA',
  url: 'https://tsa-secondary.example.com',
  qualified: true,
  timeoutMs: 5000,
};

const testRequest: TsaRequest = {
  messageImprint: Buffer.alloc(32, 0x42),
  hashAlgorithm: 'SHA-256',
  certReq: true,
};

describe('QTSP Provider', () => {
  let client: MockRfc3161Client;
  let provider: DefaultQtspProvider;

  beforeEach(() => {
    client = new MockRfc3161Client();
    provider = new DefaultQtspProvider(client, primaryTsa, secondaryTsa, {
      failureThreshold: 2,
      resetMs: 1000,
    });
  });

  afterEach(() => {
    provider.stopHealthChecks();
  });

  describe('requestTimestamp', () => {
    it('should use primary TSA on success', async () => {
      const response = await provider.requestTimestamp(testRequest);

      expect(response.status).toBe(0);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].config.name).toBe('Primary TSA');
    });

    it('should failover to secondary when primary fails', async () => {
      // Make primary fail, secondary succeed
      let callCount = 0;
      const originalTimestamp = client.timestamp.bind(client);
      client.timestamp = async (config, request) => {
        callCount++;
        if (config.url === primaryTsa.url) {
          throw new Error('Primary TSA timeout');
        }
        return originalTimestamp(config, request);
      };

      const response = await provider.requestTimestamp(testRequest);

      expect(response.status).toBe(0);
      expect(callCount).toBe(2); // primary failed, secondary succeeded
    });

    it('should open circuit breaker after threshold failures', async () => {
      // Make only primary fail, secondary succeeds
      const origTimestamp = client.timestamp.bind(client);
      client.timestamp = async (config, request) => {
        if (config.url === primaryTsa.url) {
          throw new Error('Primary TSA down');
        }
        return origTimestamp(config, request);
      };

      // First call: primary fails, secondary succeeds
      await provider.requestTimestamp(testRequest);
      // Second call: primary fails again (hitting threshold), secondary succeeds
      await provider.requestTimestamp(testRequest);

      // Third call: primary circuit should be open, goes straight to secondary
      await provider.requestTimestamp(testRequest);

      // Should have called only secondary (primary circuit open)
      const health = provider.getHealthStatus();
      expect(health[0].circuitOpen).toBe(true);
      expect(health[0].name).toBe('Primary TSA');
    });

    it('should throw when no healthy providers available', async () => {
      // Create provider without secondary
      const soloProvider = new DefaultQtspProvider(client, primaryTsa, null, {
        failureThreshold: 1,
      });
      client.shouldFail = true;

      await expect(soloProvider.requestTimestamp(testRequest)).rejects.toThrow();

      // Now circuit is open, still fails
      client.shouldFail = false;
      // Circuit should be open after 1 failure
      // Next call still fails because circuit is open and no secondary
      const health = soloProvider.getHealthStatus();
      expect(health).toHaveLength(1);
    });
  });

  describe('getHealthStatus', () => {
    it('should report healthy status initially', () => {
      const status = provider.getHealthStatus();

      expect(status).toHaveLength(2);
      expect(status[0].name).toBe('Primary TSA');
      expect(status[0].healthy).toBe(true);
      expect(status[0].circuitOpen).toBe(false);
      expect(status[1].name).toBe('Secondary TSA');
      expect(status[1].healthy).toBe(true);
    });

    it('should track failure counts', async () => {
      client.shouldFail = true;

      try { await provider.requestTimestamp(testRequest); } catch { /* expected */ }

      const status = provider.getHealthStatus();
      expect(status[0].failureCount).toBeGreaterThan(0);
    });
  });

  describe('circuit breaker reset', () => {
    it('should reset circuit after timeout', async () => {
      // Open the circuit
      client.shouldFail = true;
      try { await provider.requestTimestamp(testRequest); } catch { /* expected */ }
      try { await provider.requestTimestamp(testRequest); } catch { /* expected */ }

      // Wait for reset timeout (1000ms in test config)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Circuit should be half-open
      client.shouldFail = false;
      const response = await provider.requestTimestamp(testRequest);
      expect(response.status).toBe(0);
    });
  });

  describe('factory', () => {
    it('should create provider with both TSAs', () => {
      const p = createQtspProvider(client, primaryTsa, secondaryTsa);
      const health = p.getHealthStatus();
      expect(health).toHaveLength(2);
    });

    it('should create provider with primary only', () => {
      const p = createQtspProvider(client, primaryTsa);
      const health = p.getHealthStatus();
      expect(health).toHaveLength(1);
    });
  });
});
