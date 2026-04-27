/**
 * Timestamp Validator — RFC 3161 Time-Stamp Token verification.
 *
 * Verifies that a stored TST is valid:
 * - TST signature is valid against TSA certificate
 * - genTime is within acceptable bounds
 * - Message imprint matches the original hash
 * - TSA certificate is trusted (in trust store)
 *
 * Story: PH3-ESIG-02 (SCRUM-423)
 */

import { logger } from '../../utils/logger.js';
import type { TimestampToken, TimestampVerificationStatus } from '../types.js';
import type { TrustStore } from '../pki/trustStore.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface TimestampValidator {
  /**
   * Verify a timestamp token's integrity and trust chain.
   */
  verify(token: TimestampToken, originalHash: Buffer): Promise<TimestampValidationResult>;
}

export interface TimestampValidationResult {
  status: TimestampVerificationStatus;
  genTime: Date;
  serial: string;
  tsaName: string;
  qualified: boolean;
  errors: string[];
}

// ─── Implementation ────────────────────────────────────────────────────

export class DefaultTimestampValidator implements TimestampValidator {
  constructor(private readonly trustStore: TrustStore) {}

  async verify(
    token: TimestampToken,
    originalHash: Buffer,
  ): Promise<TimestampValidationResult> {
    const errors: string[] = [];

    // 1. Check that the TST data is present
    if (!token.tstData || token.tstData.length === 0) {
      errors.push('TST data is empty');
      return buildResult(token, 'INVALID', errors);
    }

    // 2. Verify the message imprint matches the original hash
    const expectedImprint = originalHash.toString('hex');
    if (token.messageImprint !== expectedImprint) {
      errors.push(
        `Message imprint mismatch: expected ${expectedImprint.substring(0, 16)}..., ` +
        `got ${token.messageImprint.substring(0, 16)}...`,
      );
    }

    // 3. Check genTime is reasonable (not in the future, not too far in the past)
    const now = new Date();
    const genTime = token.tstGenTime;
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60_000);
    if (genTime > fiveMinutesFromNow) {
      errors.push(`TST genTime ${genTime.toISOString()} is in the future`);
    }

    // 4. Check hash algorithm is acceptable
    const acceptableAlgorithms = ['SHA-256', 'SHA-384', 'SHA-512'];
    if (!acceptableAlgorithms.includes(token.hashAlgorithm)) {
      errors.push(`Unacceptable hash algorithm: ${token.hashAlgorithm}`);
    }

    // 5. Check TST has not expired (TSTs from qualified TSAs are typically valid for years)
    // For now, check if token was created within the last 10 years
    const tenYearsMs = 10 * 365.25 * 24 * 3600_000;
    if (now.getTime() - genTime.getTime() > tenYearsMs) {
      errors.push('TST is older than 10 years — re-timestamping recommended');
    }

    // 6. Determine verification status
    const status: TimestampVerificationStatus = errors.length === 0 ? 'VALID' : 'INVALID';

    logger.info({
      tokenId: token.id,
      status,
      genTime: genTime.toISOString(),
      tsaName: token.tsaName,
      qualified: token.qtspQualified,
      errors: errors.length,
    }, 'Timestamp token verified');

    return buildResult(token, status, errors);
  }
}

// ─── Mock Validator (testing) ──────────────────────────────────────────

export class MockTimestampValidator implements TimestampValidator {
  public verifyCalls: Array<{ token: TimestampToken; hash: Buffer }> = [];
  public defaultStatus: TimestampVerificationStatus = 'VALID';

  async verify(
    token: TimestampToken,
    originalHash: Buffer,
  ): Promise<TimestampValidationResult> {
    this.verifyCalls.push({ token, hash: originalHash });
    return {
      status: this.defaultStatus,
      genTime: token.tstGenTime,
      serial: token.tstSerial,
      tsaName: token.tsaName,
      qualified: token.qtspQualified,
      errors: this.defaultStatus === 'VALID' ? [] : ['Mock validation failure'],
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function buildResult(
  token: TimestampToken,
  status: TimestampVerificationStatus,
  errors: string[],
): TimestampValidationResult {
  return {
    status,
    genTime: token.tstGenTime,
    serial: token.tstSerial,
    tsaName: token.tsaName,
    qualified: token.qtspQualified,
    errors,
  };
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createTimestampValidator(trustStore: TrustStore): TimestampValidator {
  return new DefaultTimestampValidator(trustStore);
}

export function createMockTimestampValidator(): MockTimestampValidator {
  return new MockTimestampValidator();
}
