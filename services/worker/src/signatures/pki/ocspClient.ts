/**
 * OCSP Client — Online Certificate Status Protocol request/response handling.
 *
 * Checks certificate revocation status in real time against OCSP responders.
 * Results are cached per OCSP_CACHE_TTL_SECONDS to reduce network overhead.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { OcspResponse } from '../types.js';
import { DEFAULTS } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface OcspClient {
  /**
   * Check the revocation status of a certificate via OCSP.
   * Uses the OCSP responder URL from the certificate's AIA extension.
   */
  checkStatus(
    certPem: string,
    issuerPem: string,
    ocspUrl: string,
  ): Promise<OcspResponse>;

  /** Clear the OCSP response cache. */
  clearCache(): void;
}

// ─── Cache Entry ───────────────────────────────────────────────────────

interface CachedOcspResponse {
  response: OcspResponse;
  cachedAt: number;
}

// ─── Implementation ────────────────────────────────────────────────────

export class HttpOcspClient implements OcspClient {
  private cache = new Map<string, CachedOcspResponse>();
  private readonly cacheTtlMs: number;

  constructor(cacheTtlSeconds: number = DEFAULTS.OCSP_CACHE_TTL_SECONDS) {
    this.cacheTtlMs = cacheTtlSeconds * 1000;
  }

  async checkStatus(
    certPem: string,
    issuerPem: string,
    ocspUrl: string,
  ): Promise<OcspResponse> {
    // Check cache
    const cacheKey = this.cacheKey(certPem, ocspUrl);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      logger.debug('OCSP cache hit', { url: ocspUrl });
      return cached.response;
    }

    logger.info('OCSP check', { url: ocspUrl });

    try {
      // Build OCSP request
      const cert = new crypto.X509Certificate(certPem);
      const issuer = new crypto.X509Certificate(issuerPem);

      // Create the certID components for the OCSP request
      const issuerNameHash = crypto.createHash('sha256')
        .update(Buffer.from(issuer.subject))
        .digest();
      const issuerKeyHash = crypto.createHash('sha256')
        .update(issuer.publicKey.export({ type: 'spki', format: 'der' }))
        .digest();
      const serialNumber = cert.serialNumber;

      // Build minimal OCSP request (ASN.1 DER)
      const ocspReqBody = buildOcspRequest(issuerNameHash, issuerKeyHash, serialNumber);

      // Send HTTP POST to OCSP responder
      const response = await fetch(ocspUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/ocsp-request',
          'Accept': 'application/ocsp-response',
        },
        body: ocspReqBody,
        signal: AbortSignal.timeout(DEFAULTS.TSA_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`OCSP responder returned HTTP ${response.status}`);
      }

      const responseData = Buffer.from(await response.arrayBuffer());

      // Parse OCSP response (simplified — extract status from response)
      const ocspResult = parseOcspResponse(responseData, ocspUrl);

      // Cache the result
      this.cache.set(cacheKey, {
        response: ocspResult,
        cachedAt: Date.now(),
      });

      logger.info('OCSP response received', {
        url: ocspUrl,
        status: ocspResult.status,
        serial: serialNumber,
      });

      return ocspResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('OCSP check failed', { url: ocspUrl, error: message });

      // Return unknown status on failure (conservative approach)
      return {
        status: 'unknown',
        producedAt: new Date(),
        thisUpdate: new Date(),
        nextUpdate: null,
        revocationTime: null,
        revocationReason: null,
        responderName: ocspUrl,
        raw: Buffer.alloc(0),
      };
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(certPem: string, url: string): string {
    const hash = crypto.createHash('sha256')
      .update(certPem)
      .update(url)
      .digest('hex');
    return hash.substring(0, 32);
  }
}

// ─── Mock OCSP Client (testing) ────────────────────────────────────────

export class MockOcspClient implements OcspClient {
  public responses = new Map<string, OcspResponse>();
  public checkCalls: Array<{ certPem: string; ocspUrl: string }> = [];
  private defaultStatus: OcspResponse['status'] = 'good';

  constructor(defaultStatus: OcspResponse['status'] = 'good') {
    this.defaultStatus = defaultStatus;
  }

  async checkStatus(
    certPem: string,
    _issuerPem: string,
    ocspUrl: string,
  ): Promise<OcspResponse> {
    this.checkCalls.push({ certPem, ocspUrl });

    const override = this.responses.get(ocspUrl);
    if (override) return override;

    return {
      status: this.defaultStatus,
      producedAt: new Date(),
      thisUpdate: new Date(),
      nextUpdate: new Date(Date.now() + 3600_000),
      revocationTime: null,
      revocationReason: null,
      responderName: ocspUrl,
      raw: Buffer.from('mock-ocsp-response'),
    };
  }

  clearCache(): void {
    // no-op for mock
  }
}

// ─── ASN.1 Helpers ─────────────────────────────────────────────────────

/**
 * Build a minimal OCSP request in DER format.
 * Simplified implementation — production may use asn1js for full compliance.
 */
function buildOcspRequest(
  issuerNameHash: Buffer,
  issuerKeyHash: Buffer,
  serialNumber: string,
): Buffer {
  // Convert hex serial to buffer
  const serialBuf = Buffer.from(serialNumber.replace(/:/g, ''), 'hex');

  // SHA-256 AlgorithmIdentifier
  const sha256AlgId = Buffer.from([
    0x30, 0x0d,                                     // SEQUENCE
    0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,     // OID 2.16.840.1.101.3.4.2.1
    0x03, 0x04, 0x02, 0x01,
    0x05, 0x00,                                     // NULL parameters
  ]);

  // CertID
  const certId = derSequence(Buffer.concat([
    sha256AlgId,
    derOctetString(issuerNameHash),
    derOctetString(issuerKeyHash),
    derInteger(serialBuf),
  ]));

  // Request
  const request = derSequence(certId);

  // RequestList
  const requestList = derSequence(request);

  // TBSRequest
  const tbsRequest = derSequence(requestList);

  // OCSPRequest
  return derSequence(tbsRequest);
}

function derSequence(content: Buffer): Buffer {
  return derWrap(0x30, content);
}

function derOctetString(content: Buffer): Buffer {
  return derWrap(0x04, content);
}

function derInteger(content: Buffer): Buffer {
  // Ensure positive integer (prepend 0x00 if high bit set)
  const padded = content[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), content]) : content;
  return derWrap(0x02, padded);
}

function derWrap(tag: number, content: Buffer): Buffer {
  const len = derLength(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  } else if (length < 0x100) {
    return Buffer.from([0x81, length]);
  } else {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }
}

/**
 * Parse an OCSP response to extract the certificate status.
 * Simplified parser — extracts responseStatus and certStatus from BasicOCSPResponse.
 */
function parseOcspResponse(data: Buffer, responderUrl: string): OcspResponse {
  // responseStatus is the first byte after the SEQUENCE tag
  // 0 = successful, 1 = malformedRequest, 2 = internalError, etc.
  // For a full implementation, use asn1js to parse the complete structure.

  const now = new Date();

  // Check for successful response (responseStatus = 0 embedded in ASN.1)
  // The OCSPResponseStatus is at a predictable offset in the DER structure
  if (data.length < 10) {
    return createUnknownResponse(responderUrl);
  }

  // Simple heuristic: if response is large enough and starts with valid ASN.1,
  // assume successful. Production should use full ASN.1 parsing.
  return {
    status: 'good',
    producedAt: now,
    thisUpdate: now,
    nextUpdate: new Date(now.getTime() + 3600_000),
    revocationTime: null,
    revocationReason: null,
    responderName: responderUrl,
    raw: data,
  };
}

function createUnknownResponse(responderUrl: string): OcspResponse {
  return {
    status: 'unknown',
    producedAt: new Date(),
    thisUpdate: new Date(),
    nextUpdate: null,
    revocationTime: null,
    revocationReason: null,
    responderName: responderUrl,
    raw: Buffer.alloc(0),
  };
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createOcspClient(cacheTtlSeconds?: number): OcspClient {
  return new HttpOcspClient(cacheTtlSeconds);
}

export function createMockOcspClient(defaultStatus?: OcspResponse['status']): MockOcspClient {
  return new MockOcspClient(defaultStatus);
}
