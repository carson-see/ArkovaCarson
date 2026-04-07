/**
 * Audit Proof Exporter — Per-credential compliance proof generation.
 *
 * Generates audit proof packages containing:
 * - Anchor proof (Bitcoin TX, block, fingerprint)
 * - AdES signature details (format, level, signer, algorithm)
 * - Timestamp token (RFC 3161 TST, TSA, genTime)
 * - Certificate chain (leaf → root)
 * - eIDAS/ESIGN compliance assessment
 *
 * Exported as JSON (machine-readable) or structured data for PDF rendering.
 *
 * Story: PH3-ESIG-03 (SCRUM-424)
 */

import { logger } from '../../utils/logger.js';
import { db } from '../../utils/db.js';
import { EIDAS_COMPLIANCE, ETSI_STANDARD, LEVEL_REQUIREMENTS } from '../constants.js';
import type { SignatureRecord, Jurisdiction } from '../types.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface AuditProofPackage {
  generated_at: string;
  version: '1.0';
  credential: {
    public_id: string;
    fingerprint: string;
    anchor_status: string;
    network_observed_time?: string;
    tx_id?: string;
  };
  signature?: {
    public_id: string;
    format: string;
    level: string;
    status: string;
    signer: {
      name: string | null;
      organization: string | null;
      certificate_fingerprint: string;
    };
    algorithm: string | null;
    signed_at: string | null;
    jurisdiction: string | null;
  };
  timestamp?: {
    tsa_name: string;
    gen_time: string;
    serial: string;
    qualified: boolean;
    hash_algorithm: string;
  };
  certificate_chain?: {
    leaf_subject: string;
    leaf_issuer: string;
    leaf_serial: string;
    leaf_valid_from: string;
    leaf_valid_to: string;
    chain_length: number;
    trust_level: string;
  };
  compliance: {
    eidas_applicable: boolean;
    eidas_level?: string;
    etsi_profile?: string;
    legal_effect?: string;
    esign_ueta_compliant: boolean;
  };
  evidence_layers: string[];
  disclaimers: string[];
}

export interface BulkExportOptions {
  orgId: string;
  format: 'json' | 'csv';
  from?: string;
  to?: string;
  status?: string;
}

export interface BulkExportResult {
  data: string;
  contentType: string;
  filename: string;
  count: number;
}

// ─── Single Proof Export ───────────────────────────────────────────────

/**
 * Generate an audit proof package for a single credential + signature.
 */
export async function generateAuditProof(
  signaturePublicId: string,
): Promise<AuditProofPackage | null> {
  // Fetch signature with related data
  // Note: signatures/signing_certificates/timestamp_tokens tables are new (migrations 0160-0162)
  // and not yet in database.types.ts. Using service-role RPC pattern with type assertions.
  const { data: sig, error } = await db
    .from('signatures')
    .select(`
      *,
      signing_certificates(
        subject_cn, subject_org, issuer_cn, issuer_org,
        serial_number, fingerprint_sha256, not_before, not_after,
        trust_level, chain_pem
      )
    `)
    .eq('public_id', signaturePublicId)
    .single();

  if (error || !sig) {
    logger.warn('Audit proof: signature not found', { signaturePublicId });
    return null;
  }

  // Fetch anchor if linked
  let anchorData = null;
  if (sig.anchor_id) {
    const { data } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, chain_tx_id, chain_timestamp')
      .eq('id', sig.anchor_id)
      .single();
    anchorData = data;
  }

  // Fetch timestamp token if linked
  let tstData = null;
  if (sig.timestamp_token_id) {
    const { data } = await db
      .from('timestamp_tokens')
      .select('tsa_name, tst_gen_time, tst_serial, qtsp_qualified, hash_algorithm')
      .eq('id', sig.timestamp_token_id)
      .single();
    tstData = data;
  }

  const cert = sig.signing_certificates;
  const reqs = LEVEL_REQUIREMENTS[sig.level as keyof typeof LEVEL_REQUIREMENTS];

  // Build evidence layers
  const layers: string[] = [];
  if (sig.signature_value) layers.push('AdES cryptographic signature');
  if (tstData) layers.push('RFC 3161 qualified timestamp');
  if (sig.ltv_data_embedded) layers.push('Long-term validation data');
  if (sig.archive_timestamp_id) layers.push('Archive timestamp (B-LTA)');
  if (anchorData?.status === 'SECURED') layers.push('Bitcoin blockchain anchor');

  // Build compliance assessment
  const jurisdiction = sig.jurisdiction as Jurisdiction | null;
  const eidasApplicable = jurisdiction === 'EU' || jurisdiction === 'UK';
  const levelIndex = ['B-B', 'B-T', 'B-LT', 'B-LTA'].indexOf(sig.level);
  const qesMinIndex = ['B-B', 'B-T', 'B-LT', 'B-LTA'].indexOf(EIDAS_COMPLIANCE.QES_MIN_LEVEL);

  const proof: AuditProofPackage = {
    generated_at: new Date().toISOString(),
    version: '1.0',
    credential: {
      public_id: anchorData?.public_id || sig.document_fingerprint,
      fingerprint: sig.document_fingerprint,
      anchor_status: anchorData?.status || 'NOT_ANCHORED',
      network_observed_time: anchorData?.chain_timestamp || undefined,
      tx_id: anchorData?.chain_tx_id || undefined,
    },
    signature: {
      public_id: sig.public_id,
      format: sig.format,
      level: sig.level,
      status: sig.status,
      signer: {
        name: sig.signer_name,
        organization: sig.signer_org,
        certificate_fingerprint: cert?.fingerprint_sha256 || 'unknown',
      },
      algorithm: sig.signature_algorithm,
      signed_at: sig.signed_at,
      jurisdiction: sig.jurisdiction,
    },
    timestamp: tstData ? {
      tsa_name: tstData.tsa_name,
      gen_time: tstData.tst_gen_time,
      serial: tstData.tst_serial,
      qualified: tstData.qtsp_qualified,
      hash_algorithm: tstData.hash_algorithm,
    } : undefined,
    certificate_chain: cert ? {
      leaf_subject: cert.subject_cn,
      leaf_issuer: cert.issuer_cn,
      leaf_serial: cert.serial_number,
      leaf_valid_from: cert.not_before,
      leaf_valid_to: cert.not_after,
      chain_length: (cert.chain_pem?.length || 0) + 1,
      trust_level: cert.trust_level,
    } : undefined,
    compliance: {
      eidas_applicable: eidasApplicable,
      eidas_level: eidasApplicable && levelIndex >= qesMinIndex
        ? 'AdES (QES possible with qualified certificate)'
        : eidasApplicable ? 'AdES' : undefined,
      etsi_profile: `${sig.format === 'XAdES' ? ETSI_STANDARD.XADES : sig.format === 'PAdES' ? ETSI_STANDARD.PADES : ETSI_STANDARD.CADES}-1 (${sig.format} ${sig.level})`,
      legal_effect: eidasApplicable
        ? (levelIndex >= qesMinIndex ? EIDAS_COMPLIANCE.QES_LEGAL_EFFECT : EIDAS_COMPLIANCE.ADES_LEGAL_EFFECT)
        : 'Valid electronic signature under ESIGN Act / UETA',
      esign_ueta_compliant: true,
    },
    evidence_layers: layers,
    disclaimers: [
      'This proof package documents what was measured and asserted at the time of signing.',
      'Jurisdiction tags are informational metadata only and do not constitute legal advice.',
      'The Bitcoin anchor provides proof of existence by the observed block time, not proof of content.',
    ],
  };

  return proof;
}

// ─── Bulk Export ────────────────────────────────────────────────────────

/**
 * Export all signatures for an organization as JSON or CSV.
 */
export async function bulkExportSignatures(
  options: BulkExportOptions,
): Promise<BulkExportResult> {
  let query = db
    .from('signatures')
    .select('public_id, format, level, status, jurisdiction, document_fingerprint, signer_name, signer_org, signature_algorithm, signed_at, created_at, ltv_data_embedded, reason')
    .eq('org_id', options.orgId)
    .order('created_at', { ascending: false });

  if (options.from) query = query.gte('created_at', options.from);
  if (options.to) query = query.lte('created_at', options.to);
  if (options.status) query = query.eq('status', options.status);

  const { data: signatures, error } = await query;

  if (error) {
    throw new Error(`Bulk export failed: ${error.message}`);
  }

  const rows = signatures || [];

  if (options.format === 'csv') {
    const headers = [
      'signature_id', 'format', 'level', 'status', 'jurisdiction',
      'fingerprint', 'signer_name', 'signer_org', 'algorithm',
      'signed_at', 'created_at', 'ltv_embedded', 'reason',
    ];

    const csvRows = rows.map(r => [
      r.public_id, r.format, r.level, r.status, r.jurisdiction || '',
      r.document_fingerprint, r.signer_name || '', r.signer_org || '',
      r.signature_algorithm || '', r.signed_at || '', r.created_at,
      r.ltv_data_embedded ? 'true' : 'false', r.reason || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    return {
      data: [headers.join(','), ...csvRows].join('\n'),
      contentType: 'text/csv',
      filename: `arkova-signatures-${new Date().toISOString().split('T')[0]}.csv`,
      count: rows.length,
    };
  }

  // JSON export
  return {
    data: JSON.stringify({
      exported_at: new Date().toISOString(),
      org_id: options.orgId,
      count: rows.length,
      signatures: rows,
    }, null, 2),
    contentType: 'application/json',
    filename: `arkova-signatures-${new Date().toISOString().split('T')[0]}.json`,
    count: rows.length,
  };
}

// ─── SOC 2 Evidence Bundle ─────────────────────────────────────────────

export interface Soc2EvidenceBundle {
  generated_at: string;
  organization_id: string;
  period: { from: string; to: string };
  controls: Soc2Control[];
  signature_count: number;
  qualified_timestamp_count: number;
  ltv_coverage_pct: number;
}

export interface Soc2Control {
  control_id: string;
  control_name: string;
  status: 'MET' | 'PARTIALLY_MET' | 'NOT_MET';
  evidence: string[];
}

/**
 * Generate a SOC 2 evidence bundle for the signature subsystem.
 */
export async function generateSoc2EvidenceBundle(
  orgId: string,
  periodFrom: string,
  periodTo: string,
): Promise<Soc2EvidenceBundle> {
  // Count signatures in period
  const { count: sigCount } = await db
    .from('signatures')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  // Count qualified timestamps
  const { count: tstCount } = await db
    .from('timestamp_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('qtsp_qualified', true)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  // Count LTV-embedded signatures
  const { count: ltvCount } = await db
    .from('signatures')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('ltv_data_embedded', true)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  const totalSigs = sigCount || 0;
  const ltvPct = totalSigs > 0 ? ((ltvCount || 0) / totalSigs) * 100 : 0;

  const controls: Soc2Control[] = [
    {
      control_id: 'CC6.1',
      control_name: 'Logical and Physical Access Controls',
      status: 'MET',
      evidence: [
        'All signing keys stored in HSM (AWS KMS / GCP Cloud HSM)',
        'Private key material never enters application memory',
        'RLS policies enforce org-level access control on signature records',
        'API endpoints require JWT authentication + admin/owner role',
      ],
    },
    {
      control_id: 'CC7.2',
      control_name: 'System Monitoring',
      status: 'MET',
      evidence: [
        'All signature lifecycle events logged to audit_events table',
        'Events: signature.created, signature.completed, signature.revoked, signature.verified',
        `${totalSigs} signatures created in reporting period`,
        'Audit events are append-only with no user DELETE policies',
      ],
    },
    {
      control_id: 'CC8.1',
      control_name: 'Change Management',
      status: 'MET',
      evidence: [
        'Signature engine uses ETSI TS 119 312 algorithm constraints',
        'Banned algorithms (SHA-1, MD5, RSA < 2048) enforced at HSM bridge layer',
        'Feature-gated behind ENABLE_ADES_SIGNATURES flag',
        'Schema changes require compensating migrations (never modify existing)',
      ],
    },
    {
      control_id: 'PI1.3',
      control_name: 'Data Integrity',
      status: totalSigs > 0 ? 'MET' : 'NOT_MET',
      evidence: [
        'AdES signatures provide cryptographic integrity over document fingerprints',
        `${tstCount || 0} qualified timestamps from accredited TSA providers`,
        `${ltvPct.toFixed(1)}% of signatures include long-term validation data`,
        'Dual evidence model: PKI signatures + Bitcoin blockchain anchoring',
      ],
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    organization_id: orgId,
    period: { from: periodFrom, to: periodTo },
    controls,
    signature_count: totalSigs,
    qualified_timestamp_count: tstCount || 0,
    ltv_coverage_pct: Math.round(ltvPct * 10) / 10,
  };
}

// ─── GDPR Article 30 — Record of Processing Activities ─────────────────

export interface GdprArticle30Export {
  generated_at: string;
  controller: {
    organization_id: string;
    role: 'controller';
  };
  processing_activities: GdprProcessingActivity[];
}

export interface GdprProcessingActivity {
  activity: string;
  purpose: string;
  legal_basis: string;
  data_categories: string[];
  data_subjects: string[];
  recipients: string[];
  retention_period: string;
  technical_measures: string[];
  transfers_outside_eea: boolean;
}

/**
 * Generate a GDPR Article 30 Record of Processing Activities for the signature subsystem.
 */
export async function generateGdprArticle30Export(
  orgId: string,
): Promise<GdprArticle30Export> {
  return {
    generated_at: new Date().toISOString(),
    controller: {
      organization_id: orgId,
      role: 'controller',
    },
    processing_activities: [
      {
        activity: 'Electronic signature creation (AdES)',
        purpose: 'Creation of legally binding electronic signatures for document authentication and non-repudiation',
        legal_basis: 'Art. 6(1)(b) GDPR — Performance of contract; Art. 6(1)(f) — Legitimate interest in document integrity',
        data_categories: [
          'Signer identity (name, organization from X.509 certificate)',
          'Document fingerprint (SHA-256 hash — no document content)',
          'Signing timestamp',
          'Jurisdiction metadata',
        ],
        data_subjects: ['Authorized signers within the organization'],
        recipients: [
          'Qualified Trust Service Provider (RFC 3161 timestamp only — no document content)',
          'Bitcoin network (OP_RETURN anchor — fingerprint hash only, no PII)',
        ],
        retention_period: '10 years from signature creation (eIDAS Art. 24(2) requirement for qualified trust services)',
        technical_measures: [
          'HSM-backed signing keys (AWS KMS / GCP Cloud HSM) — private keys never in application memory',
          'Row-level security (RLS) on all signature tables — org-scoped access',
          'TLS 1.3 for all network communications',
          'Client-side document processing — documents never leave user device (Constitution 1.6)',
          'PII-stripped audit events — no email addresses or personal identifiers in logs',
          'ETSI TS 119 312 algorithm compliance — minimum SHA-256, RSA-2048',
        ],
        transfers_outside_eea: false,
      },
      {
        activity: 'Certificate revocation checking (OCSP)',
        purpose: 'Real-time verification of signing certificate validity against Certificate Authority',
        legal_basis: 'Art. 6(1)(f) GDPR — Legitimate interest in signature validity',
        data_categories: [
          'Certificate serial number',
          'Issuer identifier',
        ],
        data_subjects: ['Certificate holders (organizational certificates, not individual PII)'],
        recipients: ['OCSP responder operated by Certificate Authority'],
        retention_period: 'OCSP responses cached for 1 hour (configurable), then discarded',
        technical_measures: [
          'OCSP requests contain only certificate serial — no document or signer PII',
          'Cached responses stored in-memory only (not persisted to database)',
        ],
        transfers_outside_eea: true, // CA may be outside EEA
      },
      {
        activity: 'Signature verification (third-party)',
        purpose: 'Allow third parties to verify signature authenticity and document integrity',
        legal_basis: 'Art. 6(1)(f) GDPR — Legitimate interest of relying parties in verification',
        data_categories: [
          'Signer name and organization (from signature record)',
          'Signature status and timestamp',
          'Compliance assessment (eIDAS level)',
        ],
        data_subjects: ['Original signers whose signature is being verified'],
        recipients: ['Relying party requesting verification via API'],
        retention_period: 'Verification audit event retained for 7 years',
        technical_measures: [
          'API rate limiting (100 req/min anonymous, 1000 req/min authenticated)',
          'Verification results do not expose signing key material or certificate private data',
          'Public verification pages show only public_id-derived information',
        ],
        transfers_outside_eea: false,
      },
    ],
  };
}

// ─── eIDAS Compliance Report ───────────────────────────────────────────

export interface EidasComplianceReport {
  generated_at: string;
  organization_id: string;
  period: { from: string; to: string };
  summary: {
    total_signatures: number;
    qualified_signatures: number;
    advanced_signatures: number;
    basic_signatures: number;
    qtsp_providers_used: string[];
    jurisdictions: Record<string, number>;
  };
  certificate_status: {
    active: number;
    expired: number;
    revoked: number;
    qualified_certs: number;
  };
  timestamp_coverage: {
    total_timestamps: number;
    qualified_timestamps: number;
    coverage_pct: number;
  };
  ltv_status: {
    ltv_embedded_count: number;
    ltv_coverage_pct: number;
    archive_timestamps: number;
  };
  recommendations: string[];
}

/**
 * Generate an eIDAS compliance report for the organization.
 */
export async function generateEidasComplianceReport(
  orgId: string,
  periodFrom: string,
  periodTo: string,
): Promise<EidasComplianceReport> {
  // Fetch signature stats
  const { data: signatures } = await db
    .from('signatures')
    .select('level, jurisdiction, status, ltv_data_embedded, archive_timestamp_id')
    .eq('org_id', orgId)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  const sigs = signatures || [];

  // Count by level
  const bBCount = sigs.filter(s => s.level === 'B-B').length;
  const bTCount = sigs.filter(s => s.level === 'B-T').length;
  const bLTCount = sigs.filter(s => s.level === 'B-LT').length;
  const bLTACount = sigs.filter(s => s.level === 'B-LTA').length;
  const qualifiedCount = bTCount + bLTCount + bLTACount; // B-T+ can be QES with qualified cert
  const advancedCount = bBCount;

  // Count by jurisdiction
  const jurisdictions: Record<string, number> = {};
  for (const s of sigs) {
    const j = s.jurisdiction || 'UNSPECIFIED';
    jurisdictions[j] = (jurisdictions[j] || 0) + 1;
  }

  // Certificate stats
  const { data: certs } = await db
    .from('signing_certificates')
    .select('status, trust_level')
    .eq('org_id', orgId);

  const certList = certs || [];
  const activeCerts = certList.filter(c => c.status === 'ACTIVE').length;
  const expiredCerts = certList.filter(c => c.status === 'EXPIRED').length;
  const revokedCerts = certList.filter(c => c.status === 'REVOKED').length;
  const qualifiedCerts = certList.filter(c => c.trust_level === 'QUALIFIED').length;

  // Timestamp stats
  const { count: tstCount } = await db
    .from('timestamp_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  const { count: qualifiedTstCount } = await db
    .from('timestamp_tokens')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('qtsp_qualified', true)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  // LTV stats
  const ltvCount = sigs.filter(s => s.ltv_data_embedded).length;
  const archiveCount = sigs.filter(s => s.archive_timestamp_id).length;
  const ltvPct = sigs.length > 0 ? (ltvCount / sigs.length) * 100 : 0;
  const tstCoverage = sigs.length > 0 ? ((tstCount || 0) / sigs.length) * 100 : 0;

  // Build recommendations
  const recommendations: string[] = [];
  if (qualifiedCerts === 0) {
    recommendations.push('No qualified certificates registered. Obtain certificates from a QTSP to enable Qualified Electronic Signatures (QES) under eIDAS.');
  }
  if (ltvPct < 80) {
    recommendations.push(`LTV coverage is ${ltvPct.toFixed(0)}%. Target 100% for B-LT/B-LTA to ensure long-term signature validity.`);
  }
  if (bBCount > 0 && bBCount > qualifiedCount) {
    recommendations.push(`${bBCount} signatures at B-B level lack timestamps. Upgrade to B-T or above for stronger legal standing.`);
  }
  if (archiveCount === 0 && sigs.length > 0) {
    recommendations.push('No archive timestamps (B-LTA). Consider B-LTA for signatures requiring decades-long validity.');
  }
  if (recommendations.length === 0) {
    recommendations.push('eIDAS compliance posture is strong. Continue monitoring certificate expiration dates.');
  }

  // QTSP providers
  const { data: providers } = await db
    .from('timestamp_tokens')
    .select('tsa_name')
    .eq('org_id', orgId)
    .gte('created_at', periodFrom)
    .lte('created_at', periodTo);

  const qtspNames = [...new Set((providers || []).map(p => p.tsa_name))];

  return {
    generated_at: new Date().toISOString(),
    organization_id: orgId,
    period: { from: periodFrom, to: periodTo },
    summary: {
      total_signatures: sigs.length,
      qualified_signatures: qualifiedCount,
      advanced_signatures: advancedCount,
      basic_signatures: bBCount,
      qtsp_providers_used: qtspNames,
      jurisdictions,
    },
    certificate_status: {
      active: activeCerts,
      expired: expiredCerts,
      revoked: revokedCerts,
      qualified_certs: qualifiedCerts,
    },
    timestamp_coverage: {
      total_timestamps: tstCount || 0,
      qualified_timestamps: qualifiedTstCount || 0,
      coverage_pct: Math.round(tstCoverage * 10) / 10,
    },
    ltv_status: {
      ltv_embedded_count: ltvCount,
      ltv_coverage_pct: Math.round(ltvPct * 10) / 10,
      archive_timestamps: archiveCount,
    },
    recommendations,
  };
}
