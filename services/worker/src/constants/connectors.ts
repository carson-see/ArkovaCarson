/**
 * Connector vendor identifiers (SCRUM-1099 / SCRUM-1100)
 *
 * Single source of truth for the `vendor` string emitted into rule events
 * and persisted on `organization_rule_events.vendor`. Used by:
 *   - services/worker/src/integrations/connectors/googleDrive.ts (already exports
 *     GOOGLE_DRIVE_VENDOR for backwards compatibility — the constant here is
 *     the canonical one).
 *   - services/worker/src/rules/evaluator.ts (Drive folder binding guard).
 *   - any future ESIGN_COMPLETED / SHAREPOINT / ONEDRIVE bindings.
 *
 * Mismatched literals are fail-closed by `evaluateRules`, so a typo here is a
 * functional bug, not a security one — but constants kill the typo class
 * outright at type-check time.
 */

export const GOOGLE_DRIVE_VENDOR = 'google_drive' as const;
export const SHAREPOINT_VENDOR = 'sharepoint' as const;
export const ONEDRIVE_VENDOR = 'onedrive' as const;

export type WorkspaceVendor =
  | typeof GOOGLE_DRIVE_VENDOR
  | typeof SHAREPOINT_VENDOR
  | typeof ONEDRIVE_VENDOR;

export const DOCUSIGN_VENDOR = 'docusign' as const;
export const ADOBE_SIGN_VENDOR = 'adobe_sign' as const;

export type EsignVendor = typeof DOCUSIGN_VENDOR | typeof ADOBE_SIGN_VENDOR;
