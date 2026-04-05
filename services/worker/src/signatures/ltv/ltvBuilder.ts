/**
 * LTV Builder — Long-Term Validation data aggregation.
 *
 * For B-LT and B-LTA levels, aggregates OCSP responses and CRLs for all
 * certificates in the signing chain, enabling offline verification decades
 * after signing.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { logger } from '../../utils/logger.js';
import type { LtvData, OcspResponse, CrlEntry } from '../types.js';
import type { CertificateManager, CertificateInfo } from '../pki/certificateManager.js';
import type { OcspClient } from '../pki/ocspClient.js';
import type { CrlManager } from '../pki/crlManager.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface LtvBuilder {
  /**
   * Aggregate LTV data for a certificate chain.
   * Fetches OCSP responses and CRLs for every certificate in the chain.
   */
  buildLtvData(leafPem: string, chainPem: string[]): Promise<LtvData>;
}

// ─── Implementation ────────────────────────────────────────────────────

export class DefaultLtvBuilder implements LtvBuilder {
  constructor(
    private readonly certManager: CertificateManager,
    private readonly ocspClient: OcspClient,
    private readonly crlManager: CrlManager,
  ) {}

  async buildLtvData(leafPem: string, chainPem: string[]): Promise<LtvData> {
    const allCerts = [leafPem, ...chainPem];
    const ocspResponses: OcspResponse[] = [];
    const crls: CrlEntry[] = [];
    const additionalCerts: string[] = [];

    logger.info('Building LTV data', { chainLength: allCerts.length });

    // For each certificate (except self-signed root), fetch OCSP and CRL
    for (let i = 0; i < allCerts.length; i++) {
      const certPem = allCerts[i];
      const issuerPem = i + 1 < allCerts.length ? allCerts[i + 1] : certPem; // root is self-signed
      const certInfo = this.certManager.parseCertificate(certPem);

      // Fetch OCSP response if OCSP URL available
      if (certInfo.ocspUrls.length > 0) {
        try {
          const ocsp = await this.ocspClient.checkStatus(
            certPem,
            issuerPem,
            certInfo.ocspUrls[0],
          );
          ocspResponses.push(ocsp);
        } catch (err) {
          logger.warn('OCSP fetch failed for LTV', {
            cert: certInfo.subjectCn,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fetch CRLs
      if (certInfo.crlUrls.length > 0) {
        const fetchedCrls = await this.crlManager.fetchCrlsForCert(
          certInfo.crlUrls,
          certInfo.issuerCn,
        );
        crls.push(...fetchedCrls);
      }

      // Include cert in additional certs for LTV embedding
      if (i > 0) {
        additionalCerts.push(certPem);
      }
    }

    logger.info('LTV data built', {
      ocspResponses: ocspResponses.length,
      crls: crls.length,
      additionalCerts: additionalCerts.length,
    });

    return {
      ocspResponses,
      crls,
      certificates: additionalCerts,
    };
  }
}

// ─── LTV Validator ─────────────────────────────────────────────────────

export interface LtvValidator {
  /** Validate that LTV data is sufficient for offline verification. */
  validateLtvData(ltvData: LtvData, chainLength: number): LtvValidationResult;
}

export interface LtvValidationResult {
  valid: boolean;
  errors: string[];
  ocspCoverage: number; // 0..1 (fraction of chain covered)
  crlCoverage: number;
}

export class DefaultLtvValidator implements LtvValidator {
  validateLtvData(ltvData: LtvData, chainLength: number): LtvValidationResult {
    const errors: string[] = [];

    // Need at least one OCSP response or CRL per non-root cert
    const expectedCoverage = Math.max(chainLength - 1, 1);
    const ocspCoverage = Math.min(ltvData.ocspResponses.length / expectedCoverage, 1);
    const crlCoverage = Math.min(ltvData.crls.length / expectedCoverage, 1);

    if (ocspCoverage === 0 && crlCoverage === 0) {
      errors.push('No OCSP responses or CRLs available — LTV data is empty');
    }

    // Check for revoked certificates in OCSP
    for (const ocsp of ltvData.ocspResponses) {
      if (ocsp.status === 'revoked') {
        errors.push(`Certificate revoked at ${ocsp.revocationTime?.toISOString()}: ${ocsp.revocationReason}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      ocspCoverage,
      crlCoverage,
    };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createLtvBuilder(
  certManager: CertificateManager,
  ocspClient: OcspClient,
  crlManager: CrlManager,
): LtvBuilder {
  return new DefaultLtvBuilder(certManager, ocspClient, crlManager);
}

export function createLtvValidator(): LtvValidator {
  return new DefaultLtvValidator();
}
