/**
 * Demo Event Injector (SCRUM-1144)
 *
 * Lets an Arkova demo operator push canonical sample events into the same
 * `organization_rule_events` queue that live connectors use, so a custom rule
 * can be demoed end-to-end without DocuSign / Drive / Veremark accounts.
 *
 * Hard rules:
 *   - Org-admin only — non-admins get 403 even when the feature flag is on.
 *   - Disabled in `production` unless `ENABLE_DEMO_INJECTOR=true` is set.
 *   - Caller cannot spoof `org_id` — it's always the caller's org from the
 *     authenticated profile.
 *   - Every injection writes an `audit_events` row so an auditor can prove
 *     a "rule fired" came from a demo and not a live connector.
 */
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerProfile, isCallerOrgAdmin } from './_org-auth.js';

const TRIGGER_TYPES = [
  'ESIGN_COMPLETED',
  'WORKSPACE_FILE_MODIFIED',
  'CONNECTOR_DOCUMENT_RECEIVED',
  'MANUAL_UPLOAD',
  'EMAIL_INTAKE',
] as const;

type DemoTriggerType = (typeof TRIGGER_TYPES)[number];

const InjectInput = z.object({
  trigger_type: z.enum(TRIGGER_TYPES),
  vendor: z.string().trim().min(1).max(50).optional(),
  filename: z.string().trim().min(1).max(500).optional(),
  folder_path: z.string().trim().min(1).max(2000).optional(),
  sender_email: z.string().email().toLowerCase().optional(),
  subject: z.string().trim().min(1).max(500).optional(),
});

interface SamplePayload {
  vendor: string | null;
  filename: string | null;
  folder_path: string | null;
  sender_email: string | null;
  subject: string | null;
}

const SAMPLES: Record<DemoTriggerType, SamplePayload> = {
  ESIGN_COMPLETED: {
    vendor: 'docusign',
    filename: 'demo-msa-signed.pdf',
    folder_path: null,
    sender_email: 'demo-signer@example.com',
    subject: null,
  },
  WORKSPACE_FILE_MODIFIED: {
    vendor: 'google_drive',
    filename: 'demo-policy-update.docx',
    folder_path: '/Demo/HR Policies',
    sender_email: null,
    subject: null,
  },
  CONNECTOR_DOCUMENT_RECEIVED: {
    vendor: 'veremark',
    filename: null,
    folder_path: null,
    sender_email: 'demo-candidate@example.com',
    subject: null,
  },
  MANUAL_UPLOAD: {
    vendor: null,
    filename: 'demo-manual-upload.pdf',
    folder_path: null,
    sender_email: null,
    subject: null,
  },
  EMAIL_INTAKE: {
    vendor: null,
    filename: 'demo-attachment.pdf',
    folder_path: null,
    sender_email: 'demo-intake@example.com',
    subject: 'Demo: Signed contract for review',
  },
};

export function isDemoInjectorEnabled(): boolean {
  if (process.env.ENABLE_DEMO_INJECTOR === 'true') return true;
  // Anything that isn't explicitly production is "demo/staging" by default —
  // local dev, test runners, preview envs all auto-enable. Production must
  // opt in by flipping the env var.
  return process.env.NODE_ENV !== 'production';
}

async function emitAudit(args: {
  actorId: string;
  orgId: string;
  ruleEventId: string;
  triggerType: DemoTriggerType;
}): Promise<void> {
  try {
    const { error } = await db.from('audit_events').insert({
      event_type: 'DEMO_RULE_EVENT_INJECTED',
      event_category: 'ORG',
      actor_id: args.actorId,
      org_id: args.orgId,
      target_type: 'organization_rule_event',
      target_id: args.ruleEventId,
      details: JSON.stringify({ trigger_type: args.triggerType, source: 'demo_injector' }).slice(0, 10000),
    });
    if (error) {
      logger.warn({ error, ruleEventId: args.ruleEventId }, 'demo injector: audit emit failed');
    }
  } catch (err) {
    logger.warn({ error: err, ruleEventId: args.ruleEventId }, 'demo injector: audit emit threw');
  }
}

export async function handleInjectDemoEvent(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!isDemoInjectorEnabled()) {
    res.status(403).json({
      error: {
        code: 'demo_injector_disabled',
        message: 'Demo event injector is disabled in this environment',
      },
    });
    return;
  }

  const profile = await getCallerProfile(userId);
  const orgId = profile?.org_id ?? null;
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }
  // Pass the already-loaded profile so the admin check does not re-query
  // `profiles` for the platform-admin fallback (saves one round-trip).
  if (!(await isCallerOrgAdmin(userId, orgId, profile))) {
    res.status(403).json({
      error: { code: 'forbidden', message: 'Only organization admins can inject demo events' },
    });
    return;
  }

  const parsed = InjectInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: 'Invalid body', details: parsed.error.flatten() },
    });
    return;
  }

  const sample = SAMPLES[parsed.data.trigger_type];
  const merged: SamplePayload = {
    vendor: parsed.data.vendor ?? sample.vendor,
    filename: parsed.data.filename ?? sample.filename,
    folder_path: parsed.data.folder_path ?? sample.folder_path,
    sender_email: parsed.data.sender_email ?? sample.sender_email,
    subject: parsed.data.subject ?? sample.subject,
  };

  const externalFileId = `demo-${crypto.randomUUID()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('enqueue_rule_event', {
    p_org_id: orgId, // never trusts request body — ties to authenticated profile
    p_trigger_type: parsed.data.trigger_type,
    p_vendor: merged.vendor,
    p_external_file_id: externalFileId,
    p_filename: merged.filename,
    p_folder_path: merged.folder_path,
    p_sender_email: merged.sender_email,
    p_subject: merged.subject,
    p_payload: {
      source: 'demo_injector',
      demo: true,
      injected_by_user_id: userId,
      injected_at: new Date().toISOString(),
    },
  });
  if (error || !data) {
    logger.error({ error, orgId, triggerType: parsed.data.trigger_type }, 'demo injector: enqueue_rule_event failed');
    res.status(500).json({
      error: {
        code: 'rule_event_enqueue_failed',
        message: 'Failed to enqueue demo event',
      },
    });
    return;
  }

  const ruleEventId = String(data);
  res.status(202).json({
    ok: true,
    rule_event_id: ruleEventId,
    trigger_type: parsed.data.trigger_type,
    demo: true,
  });
  // Fire-and-forget: audit must not gate response latency, and a failed audit
  // emit is logged but does not roll back the (already-acked) injection.
  void emitAudit({
    actorId: userId,
    orgId,
    ruleEventId,
    triggerType: parsed.data.trigger_type,
  });
}
