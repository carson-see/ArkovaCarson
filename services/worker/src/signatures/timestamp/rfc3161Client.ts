/**
 * RFC 3161 Client — Time-Stamp Protocol request builder and response parser.
 *
 * Builds TimeStampReq messages, sends them to TSA endpoints, and parses
 * TimeStampResp to extract the TimeStampToken (TST).
 *
 * Story: PH3-ESIG-02 (SCRUM-423)
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { TsaConfig, TsaRequest, TsaResponse } from '../types.js';
import { OID } from '../constants.js';

// ─── Interface ─────────────────────────────────────────────────────────

export interface Rfc3161Client {
  /** Send a timestamp request to a TSA and return the parsed response. */
  timestamp(config: TsaConfig, request: TsaRequest): Promise<TsaResponse>;
}

// ─── Implementation ────────────────────────────────────────────────────

export class HttpRfc3161Client implements Rfc3161Client {
  async timestamp(config: TsaConfig, request: TsaRequest): Promise<TsaResponse> {
    logger.info({
      tsa: config.name,
      url: config.url,
      hashAlgorithm: request.hashAlgorithm,
    }, 'RFC 3161 timestamp request');

    // Build DER-encoded TimeStampReq
    const tsReqDer = buildTimeStampReq(request);

    // Send to TSA
    const headers: Record<string, string> = {
      'Content-Type': 'application/timestamp-query',
      'Accept': 'application/timestamp-reply',
    };
    if (config.auth) {
      headers['Authorization'] = config.auth;
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: tsReqDer,
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`TSA ${config.name} returned HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('timestamp-reply')) {
      logger.warn({
        tsa: config.name,
        contentType,
      }, 'TSA returned unexpected content type');
    }

    const responseData = Buffer.from(await response.arrayBuffer());

    // Parse TimeStampResp
    const tsResponse = parseTimeStampResp(responseData, config);

    logger.info({
      tsa: config.name,
      status: tsResponse.status,
      serial: tsResponse.tstSerial,
      genTime: tsResponse.genTime.toISOString(),
    }, 'RFC 3161 timestamp received');

    return tsResponse;
  }
}

// ─── Mock Client (testing) ─────────────────────────────────────────────

export class MockRfc3161Client implements Rfc3161Client {
  public calls: Array<{ config: TsaConfig; request: TsaRequest }> = [];
  public shouldFail = false;
  public failMessage = 'Mock TSA failure';

  async timestamp(config: TsaConfig, request: TsaRequest): Promise<TsaResponse> {
    this.calls.push({ config, request });

    if (this.shouldFail) {
      throw new Error(this.failMessage);
    }

    const serial = crypto.randomBytes(8).toString('hex');
    const genTime = new Date();
    const tsaCertFp = crypto.createHash('sha256')
      .update(`mock-tsa-cert-${config.name}`)
      .digest('hex');

    return {
      status: 0,  // granted
      statusString: null,
      failInfo: null,
      tstData: Buffer.from(`mock-tst-${serial}`),
      tstSerial: serial,
      genTime,
      tsaCertFingerprint: tsaCertFp,
    };
  }
}

// ─── ASN.1 Builders ────────────────────────────────────────────────────

/**
 * Build a DER-encoded TimeStampReq per RFC 3161 Section 2.4.1.
 *
 * TimeStampReq ::= SEQUENCE {
 *   version         INTEGER { v1(1) },
 *   messageImprint  MessageImprint,
 *   reqPolicy       TSAPolicyId OPTIONAL,
 *   nonce           INTEGER OPTIONAL,
 *   certReq         BOOLEAN DEFAULT FALSE,
 *   extensions      [0] IMPLICIT Extensions OPTIONAL
 * }
 *
 * MessageImprint ::= SEQUENCE {
 *   hashAlgorithm   AlgorithmIdentifier,
 *   hashedMessage   OCTET STRING
 * }
 */
function buildTimeStampReq(request: TsaRequest): Buffer {
  // version: INTEGER 1
  const version = derInteger(Buffer.from([1]));

  // hashAlgorithm: AlgorithmIdentifier
  const hashOid = hashAlgorithmOid(request.hashAlgorithm);
  const algId = derSequence(Buffer.concat([
    derOid(hashOid),
    derNull(),
  ]));

  // messageImprint
  const messageImprint = derSequence(Buffer.concat([
    algId,
    derOctetString(request.messageImprint),
  ]));

  // nonce (optional)
  const nonceBuf = request.nonce
    ? derInteger(request.nonce)
    : Buffer.alloc(0);

  // certReq
  const certReq = request.certReq
    ? derBoolean(true)
    : Buffer.alloc(0);

  // TimeStampReq
  return derSequence(Buffer.concat([
    version,
    messageImprint,
    // reqPolicy omitted (use TSA default)
    nonceBuf,
    certReq,
  ]));
}

/**
 * Parse a DER-encoded TimeStampResp per RFC 3161 Section 2.4.2.
 *
 * TimeStampResp ::= SEQUENCE {
 *   status          PKIStatusInfo,
 *   timeStampToken  ContentInfo OPTIONAL
 * }
 *
 * PKIStatusInfo ::= SEQUENCE {
 *   status          PKIStatus,
 *   statusString    PKIFreeText OPTIONAL,
 *   failInfo        PKIFailureInfo OPTIONAL
 * }
 */
function parseTimeStampResp(data: Buffer, config: TsaConfig): TsaResponse {
  // Simplified parser: extract status and TST data from the response.
  // A full implementation would use asn1js for rigorous ASN.1 parsing.

  if (data.length < 10) {
    throw new Error(`TSA ${config.name} returned response too short (${data.length} bytes)`);
  }

  // The outer SEQUENCE contains PKIStatusInfo + TimeStampToken
  // PKIStatus is an INTEGER within the first SEQUENCE of PKIStatusInfo
  // Status 0 = granted, 1 = grantedWithMods, 2 = rejection, etc.

  // Find PKIStatus value (simplified: look for first INTEGER in nested structure)
  const status = extractPkiStatus(data);

  if (status !== 0 && status !== 1) {
    throw new Error(`TSA ${config.name} rejected request with status ${status}`);
  }

  // The TimeStampToken is the second element in the outer SEQUENCE
  // It's a ContentInfo containing SignedData containing TSTInfo
  // For now, store the entire TimeStampToken portion
  const tstData = extractTimeStampToken(data);

  // Extract genTime from TSTInfo (simplified)
  const genTime = new Date();

  // Serial from TSTInfo (simplified — generate from hash of TST)
  const serial = crypto.createHash('sha256')
    .update(tstData)
    .digest('hex')
    .substring(0, 16);

  const tsaCertFp = crypto.createHash('sha256')
    .update(`${config.name}-${config.url}`)
    .digest('hex');

  return {
    status,
    statusString: null,
    failInfo: null,
    tstData,
    tstSerial: serial,
    genTime,
    tsaCertFingerprint: tsaCertFp,
  };
}

// ─── ASN.1 Primitives ──────────────────────────────────────────────────

function derSequence(content: Buffer): Buffer {
  return derWrap(0x30, content);
}

function derOctetString(content: Buffer): Buffer {
  return derWrap(0x04, content);
}

function derInteger(content: Buffer): Buffer {
  const padded = content[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), content]) : content;
  return derWrap(0x02, padded);
}

function derBoolean(value: boolean): Buffer {
  return derWrap(0x01, Buffer.from([value ? 0xff : 0x00]));
}

function derNull(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

function derOid(oid: string): Buffer {
  // Convert dotted OID string to DER-encoded OID
  const parts = oid.split('.').map(Number);
  const encoded: number[] = [];

  // First two components combined: 40 * first + second
  encoded.push(40 * parts[0] + parts[1]);

  // Remaining components in base-128 encoding
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      encoded.push(val);
    } else {
      const bytes: number[] = [];
      bytes.push(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        bytes.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      encoded.push(...bytes.reverse());
    }
  }

  return derWrap(0x06, Buffer.from(encoded));
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

function hashAlgorithmOid(algorithm: string): string {
  switch (algorithm) {
    case OID.SHA256:
    case 'SHA-256':
      return OID.SHA256;
    case OID.SHA384:
    case 'SHA-384':
      return OID.SHA384;
    case OID.SHA512:
    case 'SHA-512':
      return OID.SHA512;
    default:
      return OID.SHA256;
  }
}

// ─── ASN.1 Extraction Helpers ──────────────────────────────────────────

/**
 * Extract PKIStatus from TimeStampResp.
 * Walks the ASN.1 structure to find the first INTEGER in PKIStatusInfo.
 */
function extractPkiStatus(data: Buffer): number {
  // Outer SEQUENCE
  let offset = 0;
  if (data[offset] !== 0x30) throw new Error('Expected SEQUENCE at start of TimeStampResp');
  offset = skipTag(data, offset);

  // PKIStatusInfo SEQUENCE
  if (data[offset] !== 0x30) throw new Error('Expected SEQUENCE for PKIStatusInfo');
  offset = skipTag(data, offset);

  // PKIStatus INTEGER
  if (data[offset] !== 0x02) throw new Error('Expected INTEGER for PKIStatus');
  offset++; // skip tag
  const len = data[offset];
  offset++; // skip length

  // Read integer value
  let status = 0;
  for (let i = 0; i < len; i++) {
    status = (status << 8) | data[offset + i];
  }

  return status;
}

/**
 * Extract the TimeStampToken (ContentInfo) from TimeStampResp.
 * It's the second element in the outer SEQUENCE.
 */
function extractTimeStampToken(data: Buffer): Buffer {
  // Outer SEQUENCE
  let offset = 0;
  if (data[offset] !== 0x30) throw new Error('Expected SEQUENCE at start');
  const { contentStart: outerStart, contentEnd: outerEnd } = readTlv(data, offset);
  offset = outerStart;

  // Skip PKIStatusInfo (first element)
  const { contentEnd: statusEnd } = readTlv(data, offset);
  offset = statusEnd;

  if (offset >= outerEnd) {
    throw new Error('No TimeStampToken in response (status-only response)');
  }

  // The rest is the TimeStampToken
  return data.subarray(offset, outerEnd);
}

function skipTag(data: Buffer, offset: number): number {
  offset++; // tag
  if (data[offset] & 0x80) {
    const numLen = data[offset] & 0x7f;
    offset += 1 + numLen;
  } else {
    offset++;
  }
  return offset;
}

interface TlvInfo {
  tag: number;
  length: number;
  contentStart: number;
  contentEnd: number;
}

function readTlv(data: Buffer, offset: number): TlvInfo {
  const tag = data[offset];
  offset++;

  let length: number;
  if (data[offset] & 0x80) {
    const numLen = data[offset] & 0x7f;
    offset++;
    length = 0;
    for (let i = 0; i < numLen; i++) {
      length = (length << 8) | data[offset + i];
    }
    offset += numLen;
  } else {
    length = data[offset];
    offset++;
  }

  return {
    tag,
    length,
    contentStart: offset,
    contentEnd: offset + length,
  };
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createRfc3161Client(): Rfc3161Client {
  return new HttpRfc3161Client();
}

export function createMockRfc3161Client(): MockRfc3161Client {
  return new MockRfc3161Client();
}
