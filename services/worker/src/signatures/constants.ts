/**
 * Phase III — AdES Signature Engine Constants
 *
 * OIDs, algorithm identifiers, ETSI profile URIs, and banned algorithm lists
 * per ETSI TS 119 312 (cryptographic suites for electronic signatures).
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

// ─── ASN.1 OIDs ────────────────────────────────────────────────────────

export const OID = {
  // Hash algorithms
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',

  // Signature algorithms
  SHA256_WITH_RSA: '1.2.840.113549.1.1.11',
  SHA384_WITH_RSA: '1.2.840.113549.1.1.12',
  SHA512_WITH_RSA: '1.2.840.113549.1.1.13',
  RSASSA_PSS: '1.2.840.113549.1.1.10',
  ECDSA_WITH_SHA256: '1.2.840.10045.4.3.2',
  ECDSA_WITH_SHA384: '1.2.840.10045.4.3.3',
  ECDSA_WITH_SHA512: '1.2.840.10045.4.3.4',

  // Key types
  RSA_ENCRYPTION: '1.2.840.113549.1.1.1',
  EC_PUBLIC_KEY: '1.2.840.10045.2.1',

  // Named curves
  SECP256R1: '1.2.840.10045.3.1.7',   // P-256
  SECP384R1: '1.3.132.0.34',          // P-384

  // CMS/PKCS#7
  SIGNED_DATA: '1.2.840.113549.1.7.2',
  DATA: '1.2.840.113549.1.7.1',
  CONTENT_TYPE: '1.2.840.113549.1.9.3',
  MESSAGE_DIGEST: '1.2.840.113549.1.9.4',
  SIGNING_TIME: '1.2.840.113549.1.9.5',
  SIGNING_CERTIFICATE_V2: '1.2.840.113549.1.9.16.2.47',

  // RFC 3161 Timestamp
  TST_INFO: '1.2.840.113549.1.9.16.1.4',
  TIMESTAMP_TOKEN: '1.2.840.113549.1.9.16.2.14',
  SIGNATURE_TIMESTAMP: '1.2.840.113549.1.9.16.2.14',

  // XAdES
  XADES_SIGNED_PROPERTIES: '1.2.840.113549.1.9.16.2.15',

  // OCSP
  OCSP_BASIC: '1.3.6.1.5.5.7.48.1.1',
  OCSP_NONCE: '1.3.6.1.5.5.7.48.1.2',

  // Authority Info Access
  AIA: '1.3.6.1.5.5.7.1.1',
  OCSP_METHOD: '1.3.6.1.5.5.7.48.1',
  CA_ISSUERS: '1.3.6.1.5.5.7.48.2',

  // CRL Distribution Points
  CRL_DISTRIBUTION_POINTS: '2.5.29.31',

  // Subject Key Identifier
  SUBJECT_KEY_IDENTIFIER: '2.5.29.14',
  AUTHORITY_KEY_IDENTIFIER: '2.5.29.35',
} as const;

// ─── ETSI Profile URIs ─────────────────────────────────────────────────

export const ETSI_PROFILE = {
  // XAdES profiles (ETSI EN 319 132-1)
  XADES_B_B: 'http://uri.etsi.org/01903/v1.3.2#',
  XADES_B_T: 'http://uri.etsi.org/01903/v1.3.2#SignatureTimeStamp',
  XADES_B_LT: 'http://uri.etsi.org/01903/v1.3.2#RefsOnlyTimeStamp',
  XADES_B_LTA: 'http://uri.etsi.org/01903/v1.3.2#ArchiveTimeStamp',

  // PAdES profiles (ETSI EN 319 142-1)
  PADES_B_B: 'http://uri.etsi.org/19142/profile/PAdES-baseline-B',
  PADES_B_T: 'http://uri.etsi.org/19142/profile/PAdES-baseline-T',
  PADES_B_LT: 'http://uri.etsi.org/19142/profile/PAdES-baseline-LT',
  PADES_B_LTA: 'http://uri.etsi.org/19142/profile/PAdES-baseline-LTA',

  // CAdES profiles (ETSI EN 319 122-1)
  CADES_B_B: 'http://uri.etsi.org/19122/profile/CAdES-baseline-B',
  CADES_B_T: 'http://uri.etsi.org/19122/profile/CAdES-baseline-T',
  CADES_B_LT: 'http://uri.etsi.org/19122/profile/CAdES-baseline-LT',
  CADES_B_LTA: 'http://uri.etsi.org/19122/profile/CAdES-baseline-LTA',
} as const;

// ─── Algorithm Constraints (ETSI TS 119 312) ───────────────────────────

/** Algorithms banned for any purpose per ETSI TS 119 312. */
export const BANNED_ALGORITHMS = new Set([
  'MD5',
  'SHA-1',
  'SHA1',
  'md5',
  'sha-1',
  'sha1',
  '1.3.14.3.2.26',       // SHA-1 OID
  '1.2.840.113549.2.5',  // MD5 OID
  '1.2.840.113549.1.1.5', // SHA-1 with RSA
  '1.2.840.113549.1.1.4', // MD5 with RSA
  '1.2.840.10045.4.1',    // ECDSA with SHA-1
]);

/** Minimum RSA key size (bits) per ETSI TS 119 312. */
export const MIN_RSA_KEY_SIZE = 2048;

/** Accepted hash algorithms for signing. */
export const ACCEPTED_HASH_ALGORITHMS = new Set([
  'SHA-256',
  'SHA-384',
  'SHA-512',
]);

/** Accepted signature algorithms (OID -> human name). */
export const ACCEPTED_SIGNATURE_ALGORITHMS: Record<string, string> = {
  [OID.SHA256_WITH_RSA]: 'sha256WithRSAEncryption',
  [OID.SHA384_WITH_RSA]: 'sha384WithRSAEncryption',
  [OID.SHA512_WITH_RSA]: 'sha512WithRSAEncryption',
  [OID.RSASSA_PSS]: 'RSASSA-PSS',
  [OID.ECDSA_WITH_SHA256]: 'ecdsa-with-SHA256',
  [OID.ECDSA_WITH_SHA384]: 'ecdsa-with-SHA384',
  [OID.ECDSA_WITH_SHA512]: 'ecdsa-with-SHA512',
};

// ─── Key Algorithm to KMS Mapping ──────────────────────────────────────

export const KEY_ALGORITHM_TO_KMS = {
  'RSA-2048': {
    aws: 'RSASSA_PKCS1_V1_5_SHA_256',
    gcp: 'RSA_SIGN_PKCS1_2048_SHA256',
  },
  'RSA-4096': {
    aws: 'RSASSA_PKCS1_V1_5_SHA_256',
    gcp: 'RSA_SIGN_PKCS1_4096_SHA256',
  },
  'ECDSA-P256': {
    aws: 'ECDSA_SHA_256',
    gcp: 'EC_SIGN_P256_SHA256',
  },
  'ECDSA-P384': {
    aws: 'ECDSA_SHA_384',
    gcp: 'EC_SIGN_P384_SHA384',
  },
} as const;

// ─── Signature Level Requirements ──────────────────────────────────────

/** What each signature level requires beyond the previous level. */
export const LEVEL_REQUIREMENTS = {
  'B-B': {
    signedAttributes: true,
    signerCertificate: true,
    timestamp: false,
    ltvData: false,
    archiveTimestamp: false,
  },
  'B-T': {
    signedAttributes: true,
    signerCertificate: true,
    timestamp: true,
    ltvData: false,
    archiveTimestamp: false,
  },
  'B-LT': {
    signedAttributes: true,
    signerCertificate: true,
    timestamp: true,
    ltvData: true,
    archiveTimestamp: false,
  },
  'B-LTA': {
    signedAttributes: true,
    signerCertificate: true,
    timestamp: true,
    ltvData: true,
    archiveTimestamp: true,
  },
} as const;

// ─── eIDAS Compliance Mapping ──────────────────────────────────────────

export const EIDAS_COMPLIANCE = {
  /** Minimum level for qualified electronic signature. */
  QES_MIN_LEVEL: 'B-T' as const,
  /** QES requires qualified certificate from QTSP. */
  QES_TRUST_LEVEL: 'QUALIFIED' as const,
  /** Legal effect per eIDAS Art. 25(2). */
  QES_LEGAL_EFFECT: 'Equivalent to handwritten signature under eIDAS Art. 25(2)',
  /** AdES legal effect per eIDAS Art. 25(1). */
  ADES_LEGAL_EFFECT: 'Admissible as evidence in legal proceedings under eIDAS Art. 25(1)',
} as const;

// ─── ETSI Standard References ──────────────────────────────────────────

export const ETSI_STANDARD = {
  XADES: 'ETSI EN 319 132',
  PADES: 'ETSI EN 319 142',
  CADES: 'ETSI EN 319 122',
  TSP_POLICY: 'ETSI EN 319 401',
  CA_POLICY: 'ETSI EN 319 411-1',
  QCA_POLICY: 'ETSI EN 319 411-2',
  TSA_POLICY: 'ETSI EN 319 421',
  TSA_PROTOCOL: 'ETSI EN 319 422',
  CRYPTO_SUITES: 'ETSI TS 119 312',
} as const;

// ─── XAdES XML Namespaces ──────────────────────────────────────────────

export const XMLNS = {
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XADES: 'http://uri.etsi.org/01903/v1.3.2#',
  XADES141: 'http://uri.etsi.org/01903/v1.4.1#',
} as const;

// ─── Default Timeouts ──────────────────────────────────────────────────

export const DEFAULTS = {
  TSA_TIMEOUT_MS: 5000,
  TSA_HEALTH_INTERVAL_MS: 60000,
  EUTL_UPDATE_INTERVAL_HOURS: 24,
  OCSP_CACHE_TTL_SECONDS: 3600,
  CRL_CACHE_TTL_SECONDS: 86400,
  CIRCUIT_BREAKER_THRESHOLD: 3,
  CIRCUIT_BREAKER_RESET_MS: 30000,
} as const;
