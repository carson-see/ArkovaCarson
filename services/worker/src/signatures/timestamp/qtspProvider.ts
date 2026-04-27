/**
 * QTSP Provider — Qualified Trust Service Provider selection, failover, and health monitoring.
 *
 * Manages primary and secondary TSA endpoints with circuit breaker failover
 * and periodic health checks.
 *
 * Story: PH3-ESIG-02 (SCRUM-423)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { TsaConfig, TsaRequest, TsaResponse } from '../types.js';
import type { Rfc3161Client } from './rfc3161Client.js';
import { DEFAULTS } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface QtspProvider {
  /**
   * Request a timestamp token from the best available TSA.
   * Handles failover from primary to secondary.
   */
  requestTimestamp(request: TsaRequest): Promise<TsaResponse>;

  /** Get the current health status of TSA providers. */
  getHealthStatus(): TsaHealthStatus[];

  /** Start periodic health checks. */
  startHealthChecks(): void;

  /** Stop periodic health checks. */
  stopHealthChecks(): void;
}

export interface TsaHealthStatus {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck: Date | null;
  failureCount: number;
  circuitOpen: boolean;
}

// ─── Circuit Breaker State ─────────────────────────────────────────────

interface CircuitBreakerState {
  failureCount: number;
  lastFailure: Date | null;
  circuitOpen: boolean;
  circuitOpenedAt: Date | null;
}

// ──��� Implementation ────────────────────────────────────────────────────

export class DefaultQtspProvider implements QtspProvider {
  private readonly client: Rfc3161Client;
  private readonly primary: TsaConfig;
  private readonly secondary: TsaConfig | null;
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly healthIntervalMs: number;

  constructor(
    client: Rfc3161Client,
    primary: TsaConfig,
    secondary: TsaConfig | null = null,
    options?: {
      failureThreshold?: number;
      resetMs?: number;
      healthIntervalMs?: number;
    },
  ) {
    this.client = client;
    this.primary = primary;
    this.secondary = secondary;
    this.failureThreshold = options?.failureThreshold ?? DEFAULTS.CIRCUIT_BREAKER_THRESHOLD;
    this.resetMs = options?.resetMs ?? DEFAULTS.CIRCUIT_BREAKER_RESET_MS;
    this.healthIntervalMs = options?.healthIntervalMs ?? DEFAULTS.TSA_HEALTH_INTERVAL_MS;

    // Initialize circuit breakers
    this.circuitBreakers.set(primary.url, createInitialState());
    if (secondary) {
      this.circuitBreakers.set(secondary.url, createInitialState());
    }
  }

  async requestTimestamp(request: TsaRequest): Promise<TsaResponse> {
    // Try primary first (if circuit not open)
    if (!this.isCircuitOpen(this.primary.url)) {
      try {
        const response = await this.client.timestamp(this.primary, request);
        this.recordSuccess(this.primary.url);
        return response;
      } catch (err) {
        this.recordFailure(this.primary.url, err);
        logger.warn({
          tsa: this.primary.name,
          error: err instanceof Error ? err.message : String(err),
        }, 'Primary TSA failed, attempting failover');
      }
    } else {
      logger.info({
        tsa: this.primary.name,
      }, 'Primary TSA circuit open, using secondary');
    }

    // Failover to secondary
    if (this.secondary && !this.isCircuitOpen(this.secondary.url)) {
      try {
        const response = await this.client.timestamp(this.secondary, request);
        this.recordSuccess(this.secondary.url);
        logger.info({
          tsa: this.secondary.name,
        }, 'Failover to secondary TSA succeeded');
        return response;
      } catch (err) {
        this.recordFailure(this.secondary.url, err);
        throw new Error(
          `Both TSA providers failed. Primary: ${this.primary.name}, Secondary: ${this.secondary.name}. ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw new Error(
      `No healthy TSA providers available. Primary: ${this.primary.name} (circuit: ${this.isCircuitOpen(this.primary.url) ? 'open' : 'closed'})` +
      (this.secondary ? `, Secondary: ${this.secondary.name} (circuit: ${this.isCircuitOpen(this.secondary.url) ? 'open' : 'closed'})` : ''),
    );
  }

  getHealthStatus(): TsaHealthStatus[] {
    const statuses: TsaHealthStatus[] = [];

    const addStatus = (config: TsaConfig) => {
      const state = this.circuitBreakers.get(config.url) || createInitialState();
      statuses.push({
        name: config.name,
        url: config.url,
        healthy: !state.circuitOpen,
        lastCheck: state.lastFailure,
        failureCount: state.failureCount,
        circuitOpen: state.circuitOpen,
      });
    };

    addStatus(this.primary);
    if (this.secondary) addStatus(this.secondary);

    return statuses;
  }

  startHealthChecks(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(async () => {
      await this.performHealthCheck(this.primary);
      if (this.secondary) {
        await this.performHealthCheck(this.secondary);
      }
    }, this.healthIntervalMs);

    logger.info({
      intervalMs: this.healthIntervalMs,
    }, 'TSA health checks started');
  }

  stopHealthChecks(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
      logger.info('TSA health checks stopped');
    }
  }

  private isCircuitOpen(url: string): boolean {
    const state = this.circuitBreakers.get(url);
    if (!state || !state.circuitOpen) return false;

    // Check if reset timeout has passed
    if (state.circuitOpenedAt) {
      const elapsed = Date.now() - state.circuitOpenedAt.getTime();
      if (elapsed >= this.resetMs) {
        // Half-open: allow one attempt
        state.circuitOpen = false;
        logger.info({ url }, 'Circuit breaker half-open');
        return false;
      }
    }

    return true;
  }

  private recordSuccess(url: string): void {
    const state = this.circuitBreakers.get(url);
    if (state) {
      state.failureCount = 0;
      state.circuitOpen = false;
      state.circuitOpenedAt = null;
    }
  }

  private recordFailure(url: string, _err: unknown): void {
    const state = this.circuitBreakers.get(url);
    if (!state) return;

    state.failureCount++;
    state.lastFailure = new Date();

    if (state.failureCount >= this.failureThreshold) {
      state.circuitOpen = true;
      state.circuitOpenedAt = new Date();
      logger.warn({
        url,
        failureCount: state.failureCount,
        threshold: this.failureThreshold,
      }, 'Circuit breaker opened');
    }
  }

  private async performHealthCheck(config: TsaConfig): Promise<void> {
    if (!this.isCircuitOpen(config.url)) return;

    try {
      // Send a minimal health ping using a test hash
      const testHash = crypto.createHash('sha256').update('health-check').digest();
      await this.client.timestamp(config, {
        messageImprint: testHash,
        hashAlgorithm: 'SHA-256',
        certReq: false,
      });

      this.recordSuccess(config.url);
      logger.info({
        tsa: config.name,
      }, 'TSA health check passed, circuit closed');
    } catch {
      logger.debug({ tsa: config.name }, 'TSA health check failed');
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function createInitialState(): CircuitBreakerState {
  return {
    failureCount: 0,
    lastFailure: null,
    circuitOpen: false,
    circuitOpenedAt: null,
  };
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createQtspProvider(
  client: Rfc3161Client,
  primary: TsaConfig,
  secondary?: TsaConfig | null,
): QtspProvider {
  return new DefaultQtspProvider(client, primary, secondary ?? null);
}
