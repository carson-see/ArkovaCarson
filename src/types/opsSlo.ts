/**
 * OPS-03 SLO dashboard response contract (SCRUM-2401).
 *
 * This is the frontend's view of the shape returned by the worker's
 * `GET /api/admin/ops-slo-stats` handler (services/worker/src/api/admin-ops-slo.ts).
 * It is a hand-maintained MIRROR of the worker's response interfaces — the two
 * build roots (`src/` and `services/worker/src/`, each with its own tsconfig
 * `rootDir`) cannot share a module, so the contract is duplicated by design,
 * exactly like the generated `database.types.ts` and the per-hook response
 * shapes elsewhere (e.g. `useSystemHealth.ts`). Kept in a types-only file so
 * the unavoidable mirror is isolated (and CPD-excluded) without excluding the
 * hook's real fetch logic. Keep in lockstep with the worker handler.
 */

export interface AnchorSecuredRateSurface {
  available: boolean;
  securedCount: number | null;
  totalCount: number | null;
  ratePct: number | null;
  cacheUpdatedAt: string | null;
  breach: boolean;
  error: string | null;
}

export interface ConnectorQueueSurface {
  available: boolean;
  depth: number | null;
  anchored: number | null;
  failed: number | null;
  breach: boolean;
  error: string | null;
}

export interface CreditConservationSurface {
  available: boolean;
  orgsChecked: number | null;
  divergedCount: number | null;
  divergedOrgIds: string[];
  breach: boolean;
  error: string | null;
}

export interface WebhookDeliverySurface {
  available: boolean;
  successCount: number | null;
  totalCount: number | null;
  ratePct: number | null;
  windowHours: number;
  breach: boolean;
  error: string | null;
}

export interface ApiErrorsSurface {
  available: boolean;
  errorCount: number | null;
  totalCount: number | null;
  errorRatePct: number | null;
  windowHours: number;
  breach: boolean;
  error: string | null;
}

export interface OpsSloStats {
  anchorSecuredRate: AnchorSecuredRateSurface;
  connectorQueue: ConnectorQueueSurface;
  creditConservation: CreditConservationSurface;
  webhookDelivery: WebhookDeliverySurface;
  apiErrors: ApiErrorsSurface;
  overallBreach: boolean;
  checkedAt: string;
}
