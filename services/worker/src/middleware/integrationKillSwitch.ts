/**
 * Integration kill-switches.
 *
 * Env-gated 503 responses for integration endpoints with known security
 * findings from the 2026-04-24 audit. Default ON (so prod is mitigated
 * without code changes); flip to "true" to re-enable once a fix ships.
 *
 * Each flag corresponds to a specific finding in the audit; see Jira
 * "Integration Hardening" epic.
 */
import type { Request, Response, NextFunction } from 'express';

type FlagName =
  | 'ENABLE_DRIVE_OAUTH'         // C1-C4: webhook URL mismatch, falls-open auth, dead disconnect
  | 'ENABLE_DRIVE_WEBHOOK'       // same stack
  | 'ENABLE_DOCUSIGN_OAUTH'      // pre-emptive while we audit token-storage path
  | 'ENABLE_DOCUSIGN_WEBHOOK'    // cross-org lookup with no org_id filter
  | 'ENABLE_ATS_WEBHOOK'         // multi-secret iteration = tenant isolation bypass
  | 'ENABLE_GRC_INTEGRATION';    // OAuth tokens stored cleartext

function isEnabled(flag: FlagName): boolean {
  // Default OFF for the audit-flagged integrations until per-flag fix lands.
  // Operator must explicitly set ENABLE_*=true to re-enable.
  return process.env[flag] === 'true';
}

export function killSwitch(flag: FlagName) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (isEnabled(flag)) return next();
    res.status(503).json({
      error: 'integration_disabled',
      message: 'This integration is temporarily disabled pending a security fix. See SCRUM Integration Hardening epic.',
      flag,
    });
  };
}
