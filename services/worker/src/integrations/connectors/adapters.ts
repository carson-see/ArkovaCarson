/**
 * Connector → Canonical Event Adapters (INT-10 / INT-12 / INT-13)
 *
 * Each adapter takes a vendor-shaped payload and returns the canonical event
 * used by the Rules Engine (ARK-106). Pure functions — no I/O, no DB — so
 * they are trivially testable and also reusable from the MCP server.
 *
 * Live credentialed traffic is still gated by feature flags (see
 * `schemas.ts`); these adapters work against fixture payloads today and
 * against live webhooks once the legal/vendor gates clear.
 */
import {
  AdobeAgreementSigned,
  CheckrReportCompleted,
  type ConnectorCanonicalEventT,
  DocusignEnvelopeCompleted,
  GoogleDriveChange,
  MicrosoftGraphChange,
  VeremarkCheckCompleted,
} from './schemas.js';

export interface AdapterContext {
  /** Resolved from the webhook subscription → org lookup. */
  org_id: string;
}

export function adaptDocusign(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = DocusignEnvelopeCompleted.parse(payload);
  const firstDoc = parsed.envelopeDocuments?.[0];
  return {
    trigger_type: 'ESIGN_COMPLETED',
    org_id: ctx.org_id,
    vendor: 'docusign',
    external_file_id: parsed.envelopeId,
    filename: firstDoc?.name ?? null,
    folder_path: null,
    sender_email: parsed.sender?.email ?? null,
    subject: null,
  };
}

export function adaptAdobeSign(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = AdobeAgreementSigned.parse(payload);
  return {
    trigger_type: 'ESIGN_COMPLETED',
    org_id: ctx.org_id,
    vendor: 'adobe_sign',
    external_file_id: parsed.agreement.id,
    filename: parsed.agreement.name ?? null,
    folder_path: null,
    sender_email: parsed.agreement.senderInfo?.email ?? null,
    subject: null,
  };
}

export function adaptGoogleDrive(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = GoogleDriveChange.parse(payload);
  return {
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    org_id: ctx.org_id,
    vendor: 'google_drive',
    external_file_id: parsed.fileId,
    filename: parsed.name ?? null,
    folder_path: parsed.parents?.length ? `/${parsed.parents.join('/')}` : null,
    sender_email: null,
    subject: null,
  };
}

export function adaptMicrosoftGraph(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = MicrosoftGraphChange.parse(payload);
  // Graph resource shapes that indicate SharePoint:
  //   "sites/<siteId>/drive/items/<itemId>"   (leading-segment)
  //   "/sites/<siteId>/drive/items/<itemId>"  (leading-slash form)
  //   "sites('<siteId>')/drive/items/<itemId>" (OData bracket form)
  // Anything else (me/drive/..., /users/.../drive/...) → onedrive.
  const resource = parsed.resource.toLowerCase();
  const vendor =
    resource.startsWith('sites/') ||
    resource.startsWith("sites('") ||
    resource.includes('/sites/')
      ? 'sharepoint'
      : 'onedrive';
  return {
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    org_id: ctx.org_id,
    vendor,
    external_file_id: parsed.resourceData.id,
    filename: parsed.resourceData.name ?? null,
    folder_path: parsed.resourceData.parentReference?.path ?? null,
    sender_email: null,
    subject: null,
  };
}

export function adaptVeremark(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = VeremarkCheckCompleted.parse(payload);
  return {
    trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
    org_id: ctx.org_id,
    vendor: 'veremark',
    external_file_id: parsed.report?.reportId ?? parsed.checkId,
    filename: null,
    folder_path: null,
    sender_email: parsed.candidate?.email ?? null,
    subject: null,
  };
}

export function adaptCheckr(
  payload: unknown,
  ctx: AdapterContext,
): ConnectorCanonicalEventT {
  const parsed = CheckrReportCompleted.parse(payload);
  return {
    trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
    org_id: ctx.org_id,
    vendor: 'checkr',
    external_file_id: parsed.data.object.id,
    filename: null,
    folder_path: null,
    sender_email: null,
    subject: null,
  };
}
