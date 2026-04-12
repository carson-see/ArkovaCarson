/**
 * Candidate Verification Tab (INT-07)
 *
 * Custom tab component for Bullhorn candidate records that provides:
 * - List of all candidate credentials with verification status
 * - One-click anchor for unverified documents
 * - Status sync to custom fields on candidate record
 * - Summary view with verification percentage
 */

import type {
  BullhornConfig,
  BullhornCredential,
  CandidateVerificationSummary,
} from './types';
import { BullhornConnector } from './connector';

const ARKOVA_DEFAULT_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

export class CandidateVerificationTab {
  private readonly connector: BullhornConnector;
  private readonly arkovaApiKey: string;
  private readonly arkovaBaseUrl: string;
  private readonly config: BullhornConfig;

  constructor(config: BullhornConfig) {
    this.connector = new BullhornConnector(config);
    this.arkovaApiKey = config.arkovaApiKey;
    this.arkovaBaseUrl = (config.arkovaBaseUrl ?? ARKOVA_DEFAULT_URL).replace(/\/+$/, '');
    this.config = config;
  }

  /**
   * Get the full credential verification summary for a candidate.
   * Lists all file attachments and checks their Arkova verification status.
   */
  async getVerificationSummary(candidateId: number): Promise<CandidateVerificationSummary> {
    // Get candidate info
    const candidate = await this.connector.getCandidate(candidateId);

    // Get all file attachments
    const files = await this.connector.listCandidateFiles(candidateId);

    // Map files to credentials and check Arkova status
    const credentials: BullhornCredential[] = files.map((f) => ({
      id: f.id,
      candidateId,
      type: f.type,
      name: f.name,
      contentType: f.contentType,
      dateAdded: new Date(f.dateAdded).toISOString(),
      arkovaStatus: 'NOT_ANCHORED' as const,
    }));

    // Check stored Arkova public_ids in custom fields
    // Convention: customText3 stores JSON array of { fileId, publicId }
    const stored = parseStoredVerifications(candidate.customText3);
    for (const cred of credentials) {
      const match = stored.find((s) => s.fileId === cred.id);
      if (match) {
        cred.arkovaPublicId = match.publicId;
        cred.arkovaStatus = 'PENDING'; // Will be verified below
      }
    }

    // Batch verify all stored public IDs
    const publicIds = credentials
      .map((c) => c.arkovaPublicId)
      .filter((id): id is string => !!id);

    if (publicIds.length > 0) {
      try {
        const response = await fetch(`${this.arkovaBaseUrl}/api/v1/verify/batch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.arkovaApiKey,
          },
          body: JSON.stringify({ public_ids: publicIds.slice(0, 20) }),
        });

        if (response.ok) {
          const data = (await response.json()) as { results: Array<{ verified: boolean; status: string }> };
          for (let i = 0; i < data.results.length; i++) {
            const cred = credentials.find((c) => c.arkovaPublicId === publicIds[i]);
            if (cred) {
              const r = data.results[i];
              cred.arkovaStatus = r.status as BullhornCredential['arkovaStatus'];
            }
          }
        }
      } catch {
        // If batch verify fails, leave statuses as PENDING
      }
    }

    // Compute summary
    const verifiedCount = credentials.filter((c) => c.arkovaStatus === 'ACTIVE' || c.arkovaStatus === 'SECURED').length;
    const pendingCount = credentials.filter((c) => c.arkovaStatus === 'PENDING').length;
    const revokedCount = credentials.filter((c) => c.arkovaStatus === 'REVOKED').length;
    const notAnchoredCount = credentials.filter((c) => c.arkovaStatus === 'NOT_ANCHORED').length;

    return {
      candidateId,
      candidateName: `${candidate.firstName} ${candidate.lastName}`,
      totalCredentials: credentials.length,
      verifiedCount,
      pendingCount,
      revokedCount,
      notAnchoredCount,
      verificationPercentage:
        credentials.length > 0 ? Math.round((verifiedCount / credentials.length) * 100) : 0,
      credentials,
      lastChecked: new Date().toISOString(),
    };
  }

  /**
   * Anchor a candidate's file to Bitcoin.
   *
   * Downloads the file, computes SHA-256 client-side, submits fingerprint.
   * Returns the Arkova public_id.
   */
  async anchorCredential(
    candidateId: number,
    fileId: number,
    options?: { credentialType?: string; description?: string },
  ): Promise<{
    publicId: string;
    fingerprint: string;
    status: string;
  }> {
    // Download file content from Bullhorn
    const content = await this.connector.downloadFile(candidateId, fileId);

    // Compute SHA-256 fingerprint client-side
    const fingerprint = await computeFingerprint(content);

    // Submit to Arkova
    const body: Record<string, string> = { fingerprint };
    if (options?.credentialType) body.credential_type = options.credentialType;
    if (options?.description) body.description = options.description;

    const response = await fetch(`${this.arkovaBaseUrl}/api/v1/anchor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.arkovaApiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error((err as any)?.message ?? `Anchor failed: HTTP ${response.status}`);
    }

    const result = (await response.json()) as { public_id: string; fingerprint: string; status: string };
    return {
      publicId: result.public_id,
      fingerprint: result.fingerprint,
      status: result.status,
    };
  }

  /**
   * Sync verification status to candidate's custom fields in Bullhorn.
   */
  async syncStatusToCandidate(
    candidateId: number,
    summary: CandidateVerificationSummary,
  ): Promise<void> {
    const statusLabel =
      summary.verifiedCount === summary.totalCredentials
        ? 'Fully Verified'
        : summary.verifiedCount > 0
          ? 'Partially Verified'
          : summary.revokedCount > 0
            ? 'Has Revocations'
            : 'Not Verified';

    const fields: Record<string, string | number> = {};

    if (this.config.verificationStatusFieldId) {
      fields[this.config.verificationStatusFieldId] = statusLabel;
    } else {
      fields.customText1 = statusLabel;
    }

    if (this.config.verificationCountFieldId) {
      fields[this.config.verificationCountFieldId] = summary.verifiedCount;
    } else {
      fields.customInt1 = summary.verifiedCount;
    }

    fields.customInt2 = summary.verificationPercentage;
    fields.customText2 = summary.lastChecked;

    await this.connector.updateCandidateFields(candidateId, fields);
  }

  /** Expose connector for advanced Bullhorn API usage */
  get bullhorn(): BullhornConnector {
    return this.connector;
  }
}

/** Parse stored verification mappings from custom field */
function parseStoredVerifications(
  json?: string,
): Array<{ fileId: number; publicId: string }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is { fileId: number; publicId: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as any).fileId === 'number' &&
        typeof (item as any).publicId === 'string',
    );
  } catch {
    return [];
  }
}

/** Compute SHA-256 fingerprint via Web Crypto API */
async function computeFingerprint(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
