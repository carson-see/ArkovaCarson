import { createHmac, createHash, timingSafeEqual, X509Certificate } from 'crypto';

export type ESignatureProvider =
  | 'docusign'
  | 'adobe_sign'
  | 'dropbox_sign'
  | 'signnow'
  | 'pandadoc'
  | 'notarize';

export interface ESignatureSigner {
  role: string;
  email: string;
  fullName: string;
  signedAt: string;
  ipAddress?: string;
  authMethod: string;
  location?: string;
  consentTimestamp?: string;
}

export interface CertificateChainEntry {
  subject: string;
  issuer: string;
  sha256Fingerprint: string;
  notBefore: string;
  notAfter: string;
  pem?: string;
}

export interface CertificateValidationOptions {
  trustedRootFingerprints?: Partial<Record<ESignatureProvider, string[]>>;
  validationTime?: Date;
}

export interface CertificateValidationResult {
  valid: boolean;
  reason?: string;
}

export interface ESignatureAuditTrail {
  provider: ESignatureProvider;
  envelopeId: string;
  documentHash: string;
  signers: ESignatureSigner[];
  completionDate: string;
  certificateValid: boolean;
  certificateChain?: CertificateChainEntry[];
  tampered: boolean;
  rawAuditPdfHash: string;
  warnings: string[];
}

export interface ParseAuditTrailOptions extends CertificateValidationOptions {
  signedDocumentFingerprint?: string;
  certificateChain?: CertificateChainEntry[];
}

type HeaderMap = Record<string, string | string[] | undefined>;

const HEX_64_RE = /^[a-f0-9]{64}$/i;

const PROVIDER_PATTERNS: Record<ESignatureProvider, {
  envelope: RegExp[];
  documentHash: RegExp[];
  completion: RegExp[];
}> = {
  docusign: {
    envelope: [/Envelope\s+ID:\s*([^\n\r]+)/i, /Envelope\s+Id:\s*([^\n\r]+)/i],
    documentHash: [/Document\s+SHA-?256:\s*([a-f0-9]{64})/i, /PDF\s+Hash:\s*([a-f0-9]{64})/i],
    completion: [/Completed:\s*([^\n\r]+)/i, /Completion\s+Date:\s*([^\n\r]+)/i],
  },
  adobe_sign: {
    envelope: [/Agreement\s+ID:\s*([^\n\r]+)/i, /Transaction\s+ID:\s*([^\n\r]+)/i],
    documentHash: [/SHA-?256\s+Digest:\s*([a-f0-9]{64})/i, /Document\s+Hash:\s*([a-f0-9]{64})/i],
    completion: [/Completed\s+At:\s*([^\n\r]+)/i, /Completed:\s*([^\n\r]+)/i],
  },
  dropbox_sign: {
    envelope: [/Signature\s+Request\s+ID:\s*([^\n\r]+)/i, /HelloSign\s+Request\s+ID:\s*([^\n\r]+)/i],
    documentHash: [/PDF\s+Hash:\s*([a-f0-9]{64})/i, /File\s+SHA-?256\s+Hash:\s*([a-f0-9]{64})/i],
    completion: [/Completed:\s*([^\n\r]+)/i, /Completed\s+At:\s*([^\n\r]+)/i],
  },
  signnow: {
    envelope: [/Document\s+ID:\s*([^\n\r]+)/i, /Invite\s+ID:\s*([^\n\r]+)/i],
    documentHash: [/Document\s+Hash:\s*([a-f0-9]{64})/i, /SHA-?256:\s*([a-f0-9]{64})/i],
    completion: [/Completed:\s*([^\n\r]+)/i, /Completed\s+At:\s*([^\n\r]+)/i],
  },
  pandadoc: {
    envelope: [/Document\s+ID:\s*([^\n\r]+)/i, /PandaDoc\s+ID:\s*([^\n\r]+)/i],
    documentHash: [/Document\s+SHA-?256:\s*([a-f0-9]{64})/i, /Document\s+Hash:\s*([a-f0-9]{64})/i],
    completion: [/Completed:\s*([^\n\r]+)/i, /Completed\s+At:\s*([^\n\r]+)/i],
  },
  notarize: {
    envelope: [/Transaction\s+ID:\s*([^\n\r]+)/i, /Proof\s+Transaction\s+ID:\s*([^\n\r]+)/i],
    documentHash: [/Tamper-Sealed\s+Document\s+Hash:\s*([a-f0-9]{64})/i, /Document\s+Hash:\s*([a-f0-9]{64})/i],
    completion: [/Completed:\s*([^\n\r]+)/i, /Completed\s+At:\s*([^\n\r]+)/i],
  },
};

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function parseESignatureAuditTrail(
  provider: ESignatureProvider,
  rawAuditTrail: string | Record<string, unknown>,
  options: ParseAuditTrailOptions = {},
): ESignatureAuditTrail {
  const rawText = typeof rawAuditTrail === 'string' ? rawAuditTrail : stableJsonStringify(rawAuditTrail);
  const normalizedObject = typeof rawAuditTrail === 'string' ? null : rawAuditTrail;
  const warnings: string[] = [];

  const envelopeId = readObjectString(normalizedObject, ['envelopeId', 'agreementId', 'signatureRequestId', 'documentId', 'transactionId'])
    ?? matchFirst(rawText, PROVIDER_PATTERNS[provider].envelope)
    ?? 'unknown';
  const documentHash = normalizeFingerprint(
    readObjectString(normalizedObject, ['documentHash', 'documentSha256', 'pdfHash', 'fileHash'])
      ?? matchFirst(rawText, PROVIDER_PATTERNS[provider].documentHash)
      ?? '',
  );
  const completionDate = normalizeDateString(
    readObjectString(normalizedObject, ['completionDate', 'completedAt', 'completed_at'])
      ?? matchFirst(rawText, PROVIDER_PATTERNS[provider].completion)
      ?? '',
  );
  const signers = parseSigners(rawText, normalizedObject);
  const chain = options.certificateChain ?? readCertificateChain(normalizedObject);
  const certificateResult = validateProviderCertificateChain(provider, chain ?? [], {
    trustedRootFingerprints: options.trustedRootFingerprints,
    validationTime: completionDate ? new Date(completionDate) : options.validationTime,
  });

  if (!documentHash) {
    warnings.push('missing_document_hash');
  }
  if (signers.length === 0) {
    warnings.push('missing_signer_events');
  }
  if (!completionDate) {
    warnings.push('missing_completion_date');
  }

  const signedDocumentFingerprint = normalizeFingerprint(options.signedDocumentFingerprint ?? '');
  const tampered = Boolean(signedDocumentFingerprint && documentHash && signedDocumentFingerprint !== documentHash);
  if (tampered) {
    warnings.push('signed_document_hash_mismatch');
  }
  if (chain && !certificateResult.valid) {
    warnings.push(`certificate_${certificateResult.reason ?? 'invalid'}`);
  }

  return {
    provider,
    envelopeId: envelopeId.trim(),
    documentHash,
    signers,
    completionDate,
    certificateValid: certificateResult.valid,
    certificateChain: chain,
    tampered,
    rawAuditPdfHash: sha256Hex(rawText),
    warnings,
  };
}

export function validateProviderCertificateChain(
  provider: ESignatureProvider,
  chain: CertificateChainEntry[],
  options: CertificateValidationOptions = {},
): CertificateValidationResult {
  if (chain.length === 0) {
    return { valid: false, reason: 'missing_certificate_chain' };
  }

  const validationTime = options.validationTime ?? new Date();
  const normalizedChain = chain.map((entry) => ({
    ...entry,
    sha256Fingerprint: normalizeFingerprint(entry.sha256Fingerprint),
  }));

  for (const entry of normalizedChain) {
    if (!HEX_64_RE.test(entry.sha256Fingerprint)) {
      return { valid: false, reason: 'invalid_fingerprint' };
    }
    if (validationTime < new Date(entry.notBefore) || validationTime > new Date(entry.notAfter)) {
      return { valid: false, reason: 'certificate_expired_or_not_yet_valid' };
    }
  }

  for (let index = 0; index < normalizedChain.length - 1; index += 1) {
    const cert = normalizedChain[index];
    const issuer = normalizedChain[index + 1];
    if (cert.issuer !== issuer.subject) {
      return { valid: false, reason: 'broken_chain' };
    }
  }

  const root = normalizedChain[normalizedChain.length - 1];
  const trustedRoots = (options.trustedRootFingerprints?.[provider] ?? [])
    .map(normalizeFingerprint);
  if (!trustedRoots.includes(root.sha256Fingerprint)) {
    return { valid: false, reason: 'untrusted_root' };
  }

  const pemResult = verifyPemChainIfPresent(normalizedChain);
  if (!pemResult.valid) {
    return pemResult;
  }

  return { valid: true };
}

export function verifyDocuSignConnectSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  return timingSafeStringEquals(expected, signatureHeader.trim());
}

export function verifyAdobeSignWebhookSignature(input: {
  rawBody: Buffer | string;
  headers: HeaderMap;
  expectedClientId?: string;
  sharedSecret?: string;
}): boolean {
  const clientId = headerValue(input.headers, 'x-adobesign-clientid');
  if (input.expectedClientId && clientId !== input.expectedClientId) {
    return false;
  }

  const signature = headerValue(input.headers, 'x-adobesign-signature') ?? headerValue(input.headers, 'x-adobe-signature');
  if (input.sharedSecret && signature) {
    const base64 = createHmac('sha256', input.sharedSecret).update(input.rawBody).digest('base64');
    const hex = createHmac('sha256', input.sharedSecret).update(input.rawBody).digest('hex');
    return timingSafeStringEquals(base64, signature.trim()) || timingSafeStringEquals(hex, signature.trim());
  }

  return Boolean(input.expectedClientId && clientId === input.expectedClientId);
}

function parseSigners(rawText: string, objectValue: Record<string, unknown> | null): ESignatureSigner[] {
  const objectSigners = Array.isArray(objectValue?.signers) ? objectValue.signers : null;
  if (objectSigners) {
    return objectSigners
      .filter((signer): signer is Record<string, unknown> => isRecord(signer))
      .map((signer) => normalizeSigner({
        role: readObjectString(signer, ['role', 'recipientRole']) ?? undefined,
        fullName: readObjectString(signer, ['fullName', 'name']) ?? undefined,
        email: readObjectString(signer, ['email', 'emailAddress']) ?? undefined,
        signedAt: readObjectString(signer, ['signedAt', 'completedAt']) ?? undefined,
        ipAddress: readObjectString(signer, ['ipAddress', 'ip']) ?? undefined,
        authMethod: readObjectString(signer, ['authMethod', 'authenticationMethod']) ?? undefined,
        location: readObjectString(signer, ['location']) ?? undefined,
        consentTimestamp: readObjectString(signer, ['consentTimestamp', 'consentedAt']) ?? undefined,
      }))
      .filter((signer) => signer.email && signer.fullName && signer.signedAt);
  }

  return rawText
    .split(/\r?\n/)
    .filter((line) => /^(Signer|Participant|Recipient):/i.test(line.trim()))
    .map((line) => normalizeSigner(parseKeyValueLine(line)))
    .filter((signer) => signer.email && signer.fullName && signer.signedAt);
}

function parseKeyValueLine(line: string): Partial<ESignatureSigner> {
  const [, body = ''] = line.split(/:(.*)/s);
  const values: Record<string, string> = {};
  for (const part of body.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    if (!rawKey || rest.length === 0) continue;
    values[rawKey.trim().toLowerCase()] = rest.join('=').trim();
  }
  return {
    role: values.role,
    fullName: values.name ?? values.fullname,
    email: values.email,
    signedAt: values.signedat,
    ipAddress: values.ip ?? values.ipaddress,
    authMethod: values.auth ?? values.authmethod,
    location: values.location,
    consentTimestamp: values.consent ?? values.consenttimestamp,
  };
}

function normalizeSigner(input: Partial<ESignatureSigner>): ESignatureSigner {
  return {
    role: input.role?.trim() || 'signer',
    email: input.email?.trim() || '',
    fullName: input.fullName?.trim() || '',
    signedAt: normalizeDateString(input.signedAt ?? ''),
    ipAddress: input.ipAddress?.trim() || undefined,
    authMethod: input.authMethod?.trim() || 'unspecified',
    location: input.location?.trim() || undefined,
    consentTimestamp: input.consentTimestamp ? normalizeDateString(input.consentTimestamp) : undefined,
  };
}

function readCertificateChain(objectValue: Record<string, unknown> | null): CertificateChainEntry[] | undefined {
  if (!Array.isArray(objectValue?.certificateChain)) return undefined;
  const chain: CertificateChainEntry[] = objectValue.certificateChain
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => {
      const pem = readObjectString(entry, ['pem']) ?? undefined;
      return {
        subject: readObjectString(entry, ['subject']) ?? '',
        issuer: readObjectString(entry, ['issuer']) ?? '',
        sha256Fingerprint: readObjectString(entry, ['sha256Fingerprint', 'fingerprint']) ?? '',
        notBefore: readObjectString(entry, ['notBefore']) ?? '',
        notAfter: readObjectString(entry, ['notAfter']) ?? '',
        ...(pem ? { pem } : {}),
      };
    });
  return chain.length > 0 ? chain : undefined;
}

function verifyPemChainIfPresent(chain: CertificateChainEntry[]): CertificateValidationResult {
  if (!chain.some((entry) => entry.pem)) {
    return { valid: true };
  }
  if (!chain.every((entry) => entry.pem)) {
    return { valid: false, reason: 'incomplete_pem_chain' };
  }

  try {
    const x509Chain = chain.map((entry) => new X509Certificate(entry.pem ?? ''));
    for (let index = 0; index < x509Chain.length - 1; index += 1) {
      if (!x509Chain[index].verify(x509Chain[index + 1].publicKey)) {
        return { valid: false, reason: 'invalid_pem_signature' };
      }
    }
    const root = x509Chain[x509Chain.length - 1];
    if (!root.verify(root.publicKey)) {
      return { valid: false, reason: 'invalid_root_signature' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'invalid_pem_chain' };
  }
}

function matchFirst(rawText: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function readObjectString(objectValue: Record<string, unknown> | null, keys: string[]): string | null {
  if (!objectValue) return null;
  for (const key of keys) {
    const value = objectValue[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function normalizeDateString(value: string): string {
  if (!value.trim()) return '';
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function headerValue(headers: HeaderMap, wanted: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function timingSafeStringEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}
