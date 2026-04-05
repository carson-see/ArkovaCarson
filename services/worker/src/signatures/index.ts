/**
 * Phase III — AdES Signature Engine
 *
 * Barrel export for the signature engine module.
 * All external consumers should import from this file.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

// Types
export type {
  SignatureFormat,
  SignatureLevel,
  SignatureStatus,
  Jurisdiction,
  RevocationReason,
  KmsProvider,
  KeyAlgorithm,
  CertificateStatus,
  TrustLevel,
  SigningCertificate,
  SignatureRecord,
  TimestampTokenType,
  TimestampVerificationStatus,
  TimestampToken,
  SignRequest,
  SignResponse,
  VerifySignatureResponse,
  VerificationCheck,
  HsmSignRequest,
  HsmSignResponse,
  TsaConfig,
  TsaRequest,
  TsaResponse,
  OcspResponse,
  CrlEntry,
  LtvData,
  AdesEngineConfig,
} from './types.js';

// Constants
export {
  OID,
  ETSI_PROFILE,
  BANNED_ALGORITHMS,
  MIN_RSA_KEY_SIZE,
  ACCEPTED_HASH_ALGORITHMS,
  ACCEPTED_SIGNATURE_ALGORITHMS,
  KEY_ALGORITHM_TO_KMS,
  LEVEL_REQUIREMENTS,
  EIDAS_COMPLIANCE,
  ETSI_STANDARD,
  XMLNS,
  DEFAULTS,
} from './constants.js';

// AdES Engine
export { createAdesEngine } from './adesEngine.js';
export type { AdesEngine, AdesSignResult } from './adesEngine.js';

// PKI
export { createHsmBridge, createMockHsmBridge } from './pki/hsmBridge.js';
export type { HsmBridge } from './pki/hsmBridge.js';

export { createCertificateManager } from './pki/certificateManager.js';
export type { CertificateManager, CertificateInfo, AlgorithmComplianceResult } from './pki/certificateManager.js';

export { createOcspClient, createMockOcspClient } from './pki/ocspClient.js';
export type { OcspClient } from './pki/ocspClient.js';

export { createCrlManager, createMockCrlManager } from './pki/crlManager.js';
export type { CrlManager } from './pki/crlManager.js';

export { createTrustStore, createMockTrustStore } from './pki/trustStore.js';
export type { TrustStore } from './pki/trustStore.js';

// Timestamp
export { createRfc3161Client, createMockRfc3161Client } from './timestamp/rfc3161Client.js';
export type { Rfc3161Client } from './timestamp/rfc3161Client.js';

export { createQtspProvider } from './timestamp/qtspProvider.js';
export type { QtspProvider, TsaHealthStatus } from './timestamp/qtspProvider.js';

// LTV
export { createLtvBuilder, createLtvValidator } from './ltv/ltvBuilder.js';
export type { LtvBuilder, LtvValidator, LtvValidationResult } from './ltv/ltvBuilder.js';

// Timestamp Validator
export { createTimestampValidator, createMockTimestampValidator } from './timestamp/timestampValidator.js';
export type { TimestampValidator, TimestampValidationResult } from './timestamp/timestampValidator.js';

// Format Builders
export { buildXadesSignature } from './xades/xadesBuilder.js';
export type { XadesSignatureParams, XadesSignatureResult } from './xades/xadesBuilder.js';

export { buildCadesSignature } from './cades/cadesBuilder.js';
export type { CadesSignatureParams, CadesSignatureResult } from './cades/cadesBuilder.js';

export { buildPadesSignature } from './pades/padesBuilder.js';
export type { PadesSignatureParams, PadesSignatureResult, PadesDss } from './pades/padesBuilder.js';

// Engine Factory
export { getAdesEngine, resetAdesEngine } from './engineFactory.js';

// Compliance
export {
  generateAuditProof,
  bulkExportSignatures,
  generateSoc2EvidenceBundle,
} from './compliance/auditProofExporter.js';
export type {
  AuditProofPackage,
  BulkExportOptions,
  BulkExportResult,
  Soc2EvidenceBundle,
  Soc2Control,
} from './compliance/auditProofExporter.js';
