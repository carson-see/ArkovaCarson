/**
 * Phase III — AdES Signature Engine Types
 *
 * Shared type definitions for the signature engine covering:
 * - Signature formats (XAdES, PAdES, CAdES)
 * - Signature levels (B-B through B-LTA per ETSI baselines)
 * - PKI types (certificates, chains, OCSP, CRL)
 * - Timestamp types (RFC 3161 TST)
 * - API request/response shapes
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

// ─── Signature Format & Level ──────────────────────────────────────────

export type SignatureFormat = 'XAdES' | 'PAdES' | 'CAdES';

export type SignatureLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';

export type SignatureStatus =
  | 'PENDING'
  | 'SIGNED'
  | 'TIMESTAMPED'
  | 'LTV_EMBEDDED'
  | 'COMPLETE'
  | 'FAILED'
  | 'REVOKED';

export type Jurisdiction = 'EU' | 'US' | 'UK' | 'CH' | 'INTL';

export type RevocationReason =
  | 'KEY_COMPROMISE'
  | 'AFFILIATION_CHANGED'
  | 'SUPERSEDED'
  | 'CESSATION_OF_OPERATION'
  | 'CERTIFICATE_HOLD';

// ─── Certificate Types ─────────────────────────────────────────────────

export type KmsProvider = 'aws_kms' | 'gcp_kms';

export type KeyAlgorithm = 'RSA-2048' | 'RSA-4096' | 'ECDSA-P256' | 'ECDSA-P384';

export type CertificateStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'SUSPENDED';

export type TrustLevel = 'BASIC' | 'ADVANCED' | 'QUALIFIED';

export interface SigningCertificate {
  id: string;
  orgId: string;
  subjectCn: string;
  subjectOrg: string | null;
  issuerCn: string;
  issuerOrg: string | null;
  serialNumber: string;
  fingerprintSha256: string;
  certificatePem: string;
  chainPem: string[] | null;
  kmsProvider: KmsProvider;
  kmsKeyId: string;
  keyAlgorithm: KeyAlgorithm;
  notBefore: Date;
  notAfter: Date;
  status: CertificateStatus;
  trustLevel: TrustLevel;
  qtspName: string | null;
  euTrustedListEntry: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  metadata: Record<string, unknown>;
}

// ─── Signature Types ───────────────────────────────────────────────────

export interface SignatureRecord {
  id: string;
  publicId: string;
  orgId: string;
  anchorId: string | null;
  attestationId: string | null;
  format: SignatureFormat;
  level: SignatureLevel;
  status: SignatureStatus;
  jurisdiction: Jurisdiction | null;
  documentFingerprint: string;
  signerCertificateId: string;
  signerName: string | null;
  signerOrg: string | null;
  signatureValue: string | null;
  signedAttributes: Record<string, unknown> | null;
  signatureAlgorithm: string | null;
  timestampTokenId: string | null;
  ltvDataEmbedded: boolean;
  archiveTimestampId: string | null;
  reason: string | null;
  location: string | null;
  contactInfo: string | null;
  createdAt: Date;
  signedAt: Date | null;
  completedAt: Date | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  createdBy: string;
  metadata: Record<string, unknown>;
}

// ─── Timestamp Types ───────────────────────────────────────────────────

export type TimestampTokenType = 'SIGNATURE' | 'ARCHIVE' | 'CONTENT';

export type TimestampVerificationStatus = 'UNVERIFIED' | 'VALID' | 'INVALID' | 'EXPIRED';

export interface TimestampToken {
  id: string;
  orgId: string;
  signatureId: string | null;
  messageImprint: string;
  hashAlgorithm: string;
  tstData: Buffer;
  tstSerial: string;
  tstGenTime: Date;
  tsaName: string;
  tsaUrl: string;
  tsaCertFingerprint: string;
  qtspQualified: boolean;
  tokenType: TimestampTokenType;
  costUsd: number | null;
  providerRef: string | null;
  verifiedAt: Date | null;
  verificationStatus: TimestampVerificationStatus;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

// ─── PKI Validation Types ──────────────────────────────────────────────

export interface CertificateChainValidationResult {
  valid: boolean;
  chain: string[];          // PEM certs from leaf to root
  trustAnchor: string;      // root CA subject CN
  errors: string[];
}

export interface OcspResponse {
  status: 'good' | 'revoked' | 'unknown';
  producedAt: Date;
  thisUpdate: Date;
  nextUpdate: Date | null;
  revocationTime: Date | null;
  revocationReason: string | null;
  responderName: string;
  raw: Buffer;
}

export interface CrlEntry {
  issuerCn: string;
  crlUrl: string;
  lastUpdate: Date;
  nextUpdate: Date;
  raw: Buffer;
}

// ─── HSM Signing Types ─────────────────────────────────────────────────

export interface HsmSignRequest {
  provider: KmsProvider;
  keyId: string;
  algorithm: KeyAlgorithm;
  data: Buffer;             // hash to sign
}

export interface HsmSignResponse {
  signature: Buffer;        // raw signature bytes
  algorithm: string;        // algorithm identifier OID
}

// ─── TSA Types ─────────────────────────────────────────────────────────

export interface TsaConfig {
  name: string;
  url: string;
  auth?: string;            // optional authentication header
  qualified: boolean;       // is this a qualified TSA per eIDAS?
  timeoutMs: number;
}

export interface TsaRequest {
  messageImprint: Buffer;   // SHA-256 hash to timestamp
  hashAlgorithm: string;    // OID of hash algorithm
  nonce?: Buffer;           // optional nonce for replay protection
  certReq: boolean;         // request TSA cert in response
}

export interface TsaResponse {
  status: number;           // PKIStatus (0 = granted)
  statusString: string | null;
  failInfo: string | null;
  tstData: Buffer;          // DER-encoded TimeStampToken
  tstSerial: string;
  genTime: Date;
  tsaCertFingerprint: string;
}

// ─── LTV Types ─────────────────────────────────────────────────────────

export interface LtvData {
  ocspResponses: OcspResponse[];
  crls: CrlEntry[];
  certificates: string[];    // additional certs (PEM) needed for validation
}

// ─── Signing Flow Types ────────────────────────────────────────────────

export interface SignRequest {
  anchorId?: string;
  attestationId?: string;
  fingerprint: string;       // sha256:<hex>
  format: SignatureFormat;
  level: SignatureLevel;
  signerCertificateId: string;
  jurisdiction?: Jurisdiction;
  reason?: string;
  location?: string;
  metadata?: Record<string, unknown>;
}

export interface SignResponse {
  signatureId: string;
  status: SignatureStatus;
  format: SignatureFormat;
  level: SignatureLevel;
  signer: {
    name: string | null;
    organization: string | null;
  };
  signedAt: string;
  timestamp?: {
    tsa: string;
    genTime: string;
    qualified: boolean;
  };
  ltvEmbedded: boolean;
  anchorProof?: {
    anchorId: string;
    status: string;
    txId?: string;
  };
  verificationUrl: string;
}

export interface VerifySignatureResponse {
  valid: boolean;
  signatureId: string;
  checks: Record<string, VerificationCheck>;
  compliance?: {
    eidasLevel: string;
    etsiProfile: string;
    legalEffect: string;
  };
  verifiedAt: string;
}

export interface VerificationCheck {
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

// ─── Engine Configuration ──────────────────────────────────────────────

export interface AdesEngineConfig {
  enabled: boolean;
  defaultLevel: SignatureLevel;
  primaryTsa: TsaConfig;
  secondaryTsa: TsaConfig | null;
  eutlUpdateIntervalHours: number;
  ocspCacheTtlSeconds: number;
  crlCacheTtlSeconds: number;
  kmsProvider: KmsProvider;
  kmsKeyId: string;
  kmsRegion: string;
}
