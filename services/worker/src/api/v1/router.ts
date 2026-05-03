/**
 * Verification API v1 Router (P4.5)
 *
 * Mounts all /api/v1/* endpoints with the middleware stack:
 *   1. Feature gate (ENABLE_VERIFICATION_API flag)
 *   2. CORS headers
 *   3. API key auth (optional for verify, required for keys)
 *   4. Rate limiting (per-IP for anon, per-key for authenticated)
 *   5. Usage tracking + quota enforcement
 *
 * Constitution 1.8: Response schema frozen once published.
 * Constitution 1.9: All endpoints gated behind feature flag.
 * Constitution 1.10: Rate limits enforced per tier.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { verificationApiGate } from '../../middleware/featureGate.js';
import { apiKeyAuth, requireScope } from '../../middleware/apiKeyAuth.js';
import { usageTracking } from '../../middleware/usageTracking.js';
import { verifyRouter } from './verify.js';
import { verifyProofRouter } from './verify-proof.js';
import { batchRouter } from './batch.js';
import { jobsRouter } from './jobs.js';
import { keysRouter } from './keys.js';
import { usageRouter } from './usage.js';
import { aiExtractRouter } from './ai-extract.js';
import { aiBatchExtractRouter } from './ai-extract-batch.js';
import { aiUsageRouter } from './ai-usage.js';
import { aiEmbedRouter } from './ai-embed.js';
import { aiSearchRouter } from './ai-search.js';
import { aiVerifySearchRouter } from './ai-verify-search.js';
import {
  aiExtractionGate,
  aiSemanticSearchGate,
  aiFraudGate,
  aiReportsGate,
  visualFraudDetectionGate,
} from '../../middleware/aiFeatureGate.js';
import { aiFeedbackRouter } from './ai-feedback.js';
import { aiIntegrityRouter } from './ai-integrity.js';
import { aiFraudVisualRouter } from './ai-fraud-visual.js';
import { aiReviewRouter } from './ai-review.js';
import { aiReportsRouter } from './ai-reports.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { rateLimit } from '../../utils/rateLimit.js';
import { x402PaymentGate } from '../../middleware/x402PaymentGate.js';
import { idempotencyMiddleware } from '../../middleware/idempotency.js';
import { nessieQueryRouter } from './nessie-query.js';
import { regulatoryAlertsRouter } from './regulatory-alerts.js';
import { aiTemplateRouter } from './ai-template.js';
import { anchorSubmitRouter } from './anchor-submit.js';
import { anchorBulkRouter } from './anchor-bulk.js';
import { anchorLifecycleRouter } from './anchor-lifecycle.js';
import { anchorEvidenceRouter } from './anchor-evidence.js';
import { anchorExtractionManifestRouter } from './anchor-extraction-manifest.js';
import { attestationsRouter } from './attestations.js';
import { entityVerifyRouter } from './entity-verify.js';
import { complianceCheckRouter } from './compliance-check.js';
import { regulatoryLookupRouter } from './regulatory-lookup.js';
import { cleVerifyRouter } from './cle-verify.js';
import { webhooksRouter } from './webhooks.js';
// atsWebhookRouter moved to index.ts for raw-body HMAC (SCRUM-1214/1215)
import { driveWebhookRouter } from './webhooks/drive.js';
import { API_V1_PREFIX, WEBHOOK_PATHS, relativeTo } from '../../constants/webhook-paths.js';
import { auditExportRouter } from './audit-export.js';
import { aiProvenanceRouter } from './ai-provenance.js';
import { aiAccountabilityReportRouter } from './ai-accountability-report.js';
import { grcRouter } from './grc.js';
import { grcFeatureGate } from '../../middleware/grcFeatureGate.js';
import { oracleRouter } from './oracle.js';
import { agentsRouter } from './agents.js';
import { signaturesRouter } from './signatures.js';
import { adesSignatureGate } from '../../middleware/adesFeatureGate.js';
import { auditBatchVerifyRouter } from './auditBatchVerify.js';
import { provenanceRouter } from './provenance.js';
import { complianceTrendsRouter } from './complianceTrends.js';
import { signatureComplianceRouter } from './signatureCompliance.js';
import { keyInventoryRouter } from './key-inventory.js';
import { complianceRulesRouter } from './compliance-rules.js';
import { complianceScoreRouter } from './compliance-score.js';
import { complianceGapRouter } from './compliance-gap.js';
import { complianceCrossRefRouter } from './compliance-cross-ref.js';
import { complianceHistoryRouter } from './compliance-history.js';
import { complianceBenchmarkRouter } from './compliance-benchmark.js';
import { complianceReportRouter } from './compliance-report.js';
import { complianceAuditRouter } from './compliance-audit.js';
import ferpaDisclosuresRouter from './ferpa-disclosures.js';
import directoryOptOutRouter from './directory-opt-out.js';
import { emergencyAccessRouter } from './emergency-access.js';
import { hipaaAuditRouter } from './hipaa-audit.js';
// Identity & org verification routers moved to index.ts (not behind feature gate)

const router = Router();

// ─── Feature gate — all /api/v1/* behind ENABLE_VERIFICATION_API ───
router.use(verificationApiGate());

// ─── CORS for API consumers (AUTH-04: no wildcard in production) ───
// In development, allow all origins for convenience.
// In production, CORS_ALLOWED_ORIGINS must be explicitly set.
const API_CORS_ORIGINS: string[] = config.corsAllowedOrigins
  ? config.corsAllowedOrigins.split(',').map((o) => o.trim()).filter((o) => o.length > 0)
  : config.nodeEnv === 'production'
    ? [] // Production: reject all cross-origin requests unless explicitly configured
    : ['*']; // Development: allow all origins

if (config.nodeEnv === 'production' && API_CORS_ORIGINS.length === 0) {
  logger.warn('CORS_ALLOWED_ORIGINS not set in production — cross-origin requests will be blocked');
}

router.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (API_CORS_ORIGINS.includes('*') || (origin && API_CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-Id, Idempotency-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Deprecation, Sunset, X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Quota-Used, X-Quota-Limit, X-Quota-Reset, Retry-After');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ─── API spec discoverability (Link header per RFC 8631) ───
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Link', '</api/docs/spec.json>; rel="service-desc"');
  next();
});

// ─── API key auth (optional — attaches req.apiKey if present) ───
// AUTH-02: Fail fast if HMAC secret is unset — empty string would make all key hashes reproducible
const hmacSecret = config.apiKeyHmacSecret;
if (!hmacSecret) {
  logger.warn('API_KEY_HMAC_SECRET not configured — API key auth will reject all keys');
}
router.use(apiKeyAuth(hmacSecret ?? ''));

// ─── Rate limiting (Constitution 1.10) ───
// Anonymous: 100 req/min per IP, API key holders: 1,000 req/min per key
const anonRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 100,
});

const keyedRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 1000,
  keyGenerator: (req) => req.apiKey?.keyId ?? req.ip ?? 'unknown',
});

router.use((req: Request, res: Response, next: NextFunction) => {
  if (req.apiKey) {
    keyedRateLimiter(req, res, next);
  } else {
    anonRateLimiter(req, res, next);
  }
});

// ─── Idempotency-Key support on POST endpoints (DX-4) ───
router.use(idempotencyMiddleware());

// ─── Usage tracking + quota enforcement ───
router.use(usageTracking());

// ─── Auth middleware for key management routes ───
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ') || authHeader.startsWith('Bearer ak_')) {
    res.status(401).json({ error: 'Supabase JWT authentication required for this endpoint' });
    return;
  }

  const token = authHeader.slice(7);
  const userId = await verifyAuthToken(token, config, logger);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
    return;
  }

  req.authUserId = userId;
  req.hmacSecret = hmacSecret;
  next();
}

// ─── Batch rate limiter (Constitution 1.10: 10 req/min) ───
// `scope: 'batch'` keeps this bucket separate from anonRateLimiter and
// keyedRateLimiter so a hot batch caller doesn't eat into their general
// 1000/min budget (and vice versa). Without `scope`, all three would
// share the same per-IP bucket after the F5 fix below.
const batchRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 10,
  scope: 'batch',
  keyGenerator: (req) => req.apiKey?.keyId ?? req.ip ?? 'unknown',
});

// ─── Mount routes ───
// Agentic verification search — MUST be before /verify to avoid route shadowing (P8-S19)
router.use('/verify/search', aiSemanticSearchGate(), aiVerifySearchRouter);

// Batch verification — API key required, stricter rate limit
router.use('/verify/batch', requireScope('verify:batch'), batchRateLimiter, batchRouter);

// ─── Credential Provenance Timeline — COMP-02 ───
// MUST be before /verify to avoid route shadowing (same pattern as P8-S19)
router.use('/verify', provenanceRouter);

// Merkle proof endpoint — public, no payment required (BTC-003)
router.use('/verify', verifyProofRouter);

// Public verification — anonymous GET allowed (Constitution 1.10: 100 req/min).
// Anonymous GET bypasses x402 gate to enable zero-friction developer onboarding.
// POST and authenticated requests still go through x402 payment gate.
const verifyPaymentGate = x402PaymentGate('/api/v1/verify');
router.use('/verify', requireScope('verify'), (req: Request, res: Response, next: NextFunction) => {
  // Allow anonymous GET for public credential lookup (rate-limited upstream at 100/min)
  if (!req.apiKey && req.method === 'GET') {
    next();
    return;
  }
  // All other requests go through x402 payment gate
  verifyPaymentGate(req, res, next);
}, verifyRouter);
// Job status polling — API key required
router.use('/jobs', requireScope('verify:batch'), jobsRouter);

// Usage stats — API key required
router.use('/usage', requireScope('usage:read'), usageRouter);

// Key management — requires Supabase JWT auth
router.use('/keys', requireAuth, requireScope('keys:manage'), keysRouter);

// Credit management — requires Supabase JWT auth + rate limit (PAY-01)
import { creditsRouter } from './credits.js';
const creditsRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => `credits:${req.authUserId ?? req.ip ?? 'unknown'}`,
});
router.use('/credits', requireAuth, creditsRateLimiter, creditsRouter);

// ─── AI rate limiter (30 req/min per user — AI ops are expensive) ───
const aiRateLimiter = rateLimit({
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => `ai:${req.authUserId ?? req.ip ?? 'unknown'}`,
});

// AI endpoints — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S4)
router.use('/ai/extract-batch', aiExtractionGate(), requireAuth, aiRateLimiter, aiBatchExtractRouter);
router.use('/ai/extract', aiExtractionGate(), requireAuth, aiRateLimiter, aiExtractRouter);
router.use('/ai/usage', requireAuth, aiUsageRouter);

// AI embedding — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S11)
router.use('/ai/embed', aiExtractionGate(), requireAuth, aiRateLimiter, aiEmbedRouter);

// AI semantic search — behind ENABLE_SEMANTIC_SEARCH flag + JWT auth (P8-S12)
router.use('/ai/search', aiSemanticSearchGate(), requireAuth, aiRateLimiter, aiSearchRouter);

// AI extraction feedback — behind ENABLE_AI_EXTRACTION flag + JWT auth (P8-S6)
router.use('/ai/feedback', aiExtractionGate(), requireAuth, aiRateLimiter, aiFeedbackRouter);

// AI integrity scores — behind ENABLE_AI_FRAUD flag + JWT auth (P8-S8)
router.use('/ai/integrity', aiFraudGate(), requireAuth, aiRateLimiter, aiIntegrityRouter);

// AI review queue — behind ENABLE_AI_FRAUD flag + JWT auth (P8-S9)
router.use('/ai/review', aiFraudGate(), requireAuth, aiRateLimiter, aiReviewRouter);

// AI visual fraud detection — gated by BOTH ENABLE_AI_FRAUD and the more
// restrictive ENABLE_VISUAL_FRAUD_DETECTION flag. The visual path ships
// document image bytes off-device (CLAUDE.md §1.6 carve-out); the second
// gate blocks tenants that haven't opted into the carve-out per the
// Confluence policy page even when the broader AI-fraud flag is on.
router.use(
  '/ai/fraud/visual',
  aiFraudGate(),
  visualFraudDetectionGate(),
  requireAuth,
  aiRateLimiter,
  aiFraudVisualRouter,
);

// AI reports — behind ENABLE_AI_REPORTS flag + JWT auth (P8-S16)
router.use('/ai/reports', aiReportsGate(), requireAuth, aiRateLimiter, aiReportsRouter);

// VAI-01: AI provenance query — queryable Source → AI → Anchor chain
router.use('/ai/provenance', requireAuth, aiRateLimiter, aiProvenanceRouter);

// VAI-03: AI accountability report — one-click provenance export (PDF/JSON)
router.use('/ai-accountability-report', requireAuth, aiRateLimiter, aiAccountabilityReportRouter);

// AI template reconstruction & tagging — behind ENABLE_AI_EXTRACTION flag + JWT auth
router.use('/ai', aiExtractionGate(), requireAuth, aiRateLimiter, aiTemplateRouter);

// ─── Audit export — compliance PDF/CSV for GRC platforms (CML-03) ───
router.use('/audit-export', requireAuth, auditExportRouter);

// ─── GRC platform integrations — Vanta, Drata, Anecdotes (CML-05) ───
import { killSwitch } from '../../middleware/integrationKillSwitch.js';
router.use('/grc', killSwitch('ENABLE_GRC_INTEGRATIONS'), grcFeatureGate(), requireAuth, grcRouter);

// ATS webhooks mounted in index.ts for raw-body HMAC (SCRUM-1214/1215).
// Path: /api/v1/webhooks/ats/:provider/:integrationId. Kill-switch is applied
// at the index.ts mount.

// ─── Google Drive push notifications — channel-token verified (SCRUM-1099) ───
// Drive POSTs are headers-only; auth is via X-Goog-Channel-ID lookup +
// X-Goog-Channel-Token constant-time compare. No HMAC because Drive does
// not sign payloads. Path comes from the canonical WEBHOOK_PATHS entry so
// drive-oauth's `changes.watch` registration cannot drift.
router.use(
  relativeTo(WEBHOOK_PATHS.GOOGLE_DRIVE, API_V1_PREFIX),
  killSwitch('ENABLE_DRIVE_WEBHOOK'),
  driveWebhookRouter,
);

// ─── Webhook management — test + delivery logs (WEBHOOK-3, WEBHOOK-4) ───
// INT-09: CRUD routes are mutating/sensitive — apply batch tier rate limit
// (10 req/min per key) per Constitution 1.10 and the webhook docs contract.
router.use('/webhooks', batchRateLimiter, webhooksRouter);

// ─── Agent Identity & Delegation — Phase II Agentic Layer (PH2-AGENT-05) ───
// JWT auth required — agents are org-managed resources
router.use('/agents', requireAuth, agentsRouter);

// ─── Record Authenticity Oracle — Phase II Agentic Layer (PH2-AGENT-04) ───
// API key required — tracks agent identity for audit trail
router.use('/oracle', requireScope('verify'), oracleRouter);

// ─── Anchor lifecycle + evidence + extraction manifest — API-RICH-03/05, SCRUM-1173 ───
// Lifecycle (SCRUM-896) and evidence package (SCRUM-1173 / HAKI-REQ-04) are
// both public per SCRUM-896 — anonymous gets a public-safe projection; API
// key with org scope adds actor_public_id. Same anon-allow shape as /verify.
const anchorAnonAllow = (req: Request, res: Response, next: NextFunction) => {
  if (!req.apiKey && req.method === 'GET') {
    next();
    return;
  }
  requireScope('verify')(req, res, next);
};
router.use('/anchor', anchorAnonAllow, anchorLifecycleRouter);
router.use('/anchor', anchorAnonAllow, anchorEvidenceRouter);
router.use('/anchor', requireScope('verify'), anchorExtractionManifestRouter);

// ─── Anchor submission — Agent SDK (Phase 1.5 Priority 4) ───
// SCRUM-1273: mutating anchor writes require the explicit anchor:write scope.
router.use('/anchor', requireScope('anchor:write'), anchorSubmitRouter);
// SCRUM-1171 (HAKI-REQ-02): bulk + retroactive anchoring with original-document metadata
router.use('/anchor/bulk', requireScope('anchor:write'), anchorBulkRouter);

// ─── Attestations — Phase II ───
// Create, verify, list, revoke attestations. Batch route middleware lives
// inside attestationsRouter so these paths cannot be middleware-only shadows.
router.use('/attestations', attestationsRouter);

// ─── Phase 1.5 Paid API endpoints ───
// Entity verification — search across all records for an entity
router.use('/verify/entity', x402PaymentGate('/api/v1/verify/entity'), entityVerifyRouter);

// Compliance check — check entity against regulatory records
router.use('/compliance/check', x402PaymentGate('/api/v1/compliance/check'), complianceCheckRouter);

// Regulatory lookup — search public regulatory records
router.use('/regulatory/lookup', x402PaymentGate('/api/v1/regulatory/lookup'), regulatoryLookupRouter);

// CLE (Continuing Legal Education) — verify compliance, list credits, submit completions
router.use('/cle', x402PaymentGate('/api/v1/cle'), cleVerifyRouter);

// Identity & org verification moved to index.ts (outside feature gate)

// ─── AdES Signatures — Phase III (PH3-ESIG-01) ───
// Feature-gated + JWT auth required — signatures are org-managed resources
router.use('/sign', adesSignatureGate(), requireAuth, signaturesRouter);
router.use('/signatures', adesSignatureGate(), requireAuth, signaturesRouter);
router.use('/verify-signature', adesSignatureGate(), signaturesRouter);
// Compliance endpoints — audit proofs, bulk export, SOC 2 evidence (PH3-ESIG-03)
router.use('/', adesSignatureGate(), requireAuth, signatureComplianceRouter);
// ─── Key Inventory — COMP-05 (SOC 2 CC6.1 audit evidence) ───
// Feature-gated + JWT auth + rate limited — admin/compliance_officer only
router.use('/', adesSignatureGate(), requireAuth, aiRateLimiter, keyInventoryRouter);

// ─── Compliance Trends — COMP-07 ───
// Feature-gated + JWT auth + rate limited
router.use('/compliance/trends', adesSignatureGate(), requireAuth, aiRateLimiter, complianceTrendsRouter);

// ─── Audit Batch Verification — COMP-06 (ISA 530 sampling) ───
// JWT auth required, batch rate limit (5 req/min)
router.use('/audit/batch-verify', requireAuth, batchRateLimiter, auditBatchVerifyRouter);

// ─── Nessie RAG query (PH1-INT-02) ───
// x402 payment gate + AI rate limiting
router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), aiRateLimiter, nessieQueryRouter);

// ─── Regulatory change monitoring alerts (NMT-REG) ───
router.use('/regulatory/alerts', aiRateLimiter, regulatoryAlertsRouter);

// ─── Nessie Compliance Engine (NCE-06+) ───
// Jurisdiction rules — public read (no auth required)
router.use('/compliance/rules', complianceRulesRouter);
// Compliance score — JWT auth required (NCE-07)
router.use('/compliance/score', requireAuth, aiRateLimiter, complianceScoreRouter);
// Gap analysis — JWT auth required (NCE-08)
router.use('/compliance/gap-analysis', requireAuth, aiRateLimiter, complianceGapRouter);
// Cross-reference — JWT auth required (NCE-15)
router.use('/compliance/cross-reference', requireAuth, aiRateLimiter, complianceCrossRefRouter);
// Score history — JWT auth required (NCE-16)
router.use('/compliance/history', requireAuth, aiRateLimiter, complianceHistoryRouter);
// Industry benchmarking — JWT auth required (NCE-17)
router.use('/compliance/benchmark', requireAuth, aiRateLimiter, complianceBenchmarkRouter);
// Audit-ready report — JWT auth required (NCE-18)
router.use('/compliance/report', requireAuth, batchRateLimiter, complianceReportRouter);
// "Audit My Organization" — org-level compliance audit (NCA-03)
router.use('/compliance/audit', requireAuth, batchRateLimiter, complianceAuditRouter);

// ─── FERPA Compliance (REG-01, REG-02) — rate limited per Constitution 1.10 ───
router.use('/ferpa', requireAuth, aiRateLimiter, ferpaDisclosuresRouter);
router.use('/directory-opt-out', requireAuth, batchRateLimiter, directoryOptOutRouter);

// ─── HIPAA Compliance (REG-07, REG-10) — rate limited per Constitution 1.10 ───
router.use('/hipaa/audit', requireAuth, aiRateLimiter, hipaaAuditRouter);
router.use('/emergency-access', requireAuth, batchRateLimiter, emergencyAccessRouter);

export { router as apiV1Router };
