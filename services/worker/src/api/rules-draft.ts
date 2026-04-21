/**
 * Natural-Language Rule Draft Endpoint (ARK-110 — SCRUM-1022)
 *
 * POST /api/rules/draft
 *   body: { natural_language: string }
 *   returns: { draft_rule: CreateOrgRuleInput, confidence: 0..1, warnings: string[] }
 *
 * The admin reviews the draft in the wizard (ARK-108), tweaks if needed,
 * and clicks Save. Drafts are NEVER saved automatically. Generated rules
 * ALWAYS have `enabled=false`; flipping on requires a separate admin action
 * (which emits ORG_RULE_ENABLED audit per SEC-02).
 *
 * Guardrails:
 *   - Input sanitized by SEC-02 (sanitizeRuleDraftInput): NFC, control-char
 *     strip, zero-width strip, length cap, emoji-flood reject
 *   - Generator CANNOT produce `enabled=true`, FORWARD_TO_URL action, or
 *     inline secrets — Zod + secondary validation reject the draft
 *   - Per-user rate limit (separate from per-org) — 10 drafts/min per user
 *   - Audit event RULE_DRAFT_REQUESTED with sanitized input + confidence
 *   - Gemini call is pluggable — supply a `RuleDraftProvider` instance.
 *     Tests stub it; production wires Gemini via IAIProvider.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sanitizeRuleDraftInput } from '../rules/sanitizer.js';
import {
  CreateOrgRuleInput,
  assertNoInlineSecrets,
  validateRuleConfigs,
  type CreateOrgRuleInputT,
} from '../rules/schemas.js';

export const DraftRequestInput = z.object({
  natural_language: z.string().min(1).max(1000),
});

/**
 * What a draft provider returns before we post-validate. Keeping this narrow
 * means Gemini hallucinations (extra fields, nested surprises) get dropped
 * when we Zod-parse against CreateOrgRuleInput.
 */
export interface DraftProviderOutput {
  /** Fields that will be Zod-checked against CreateOrgRuleInput. */
  candidate: Partial<CreateOrgRuleInputT> & { name?: string };
  /** Self-assessed confidence in [0, 1]. Below 0.7 surfaces a warning. */
  confidence: number;
  /** Provider-side warnings (unknown words, ambiguity, ...). */
  warnings?: string[];
}

export interface RuleDraftProvider {
  propose(input: {
    prompt: string;
    orgId: string;
  }): Promise<DraftProviderOutput>;
}

export interface DraftBlockedAction {
  reason: string;
}

/**
 * Block any draft with an action that requires out-of-band provisioning.
 * FORWARD_TO_URL needs a pre-allowlisted target + HMAC secret; Gemini can't
 * know those, so drafting one would always be wrong.
 */
const BLOCKED_ACTION_TYPES = new Set(['FORWARD_TO_URL']);

function forceSafeDefaults(candidate: Partial<CreateOrgRuleInputT>, orgId: string): Partial<CreateOrgRuleInputT> {
  return {
    ...candidate,
    org_id: orgId,              // always the caller's org, never provider output
    enabled: false,             // always disabled on save
  };
}

/**
 * Pure part of the endpoint — takes a sanitized prompt + a provider + org
 * context and returns either a validated draft or a rejection. Exposed so
 * the tests can exercise the guardrails without Express plumbing.
 */
export async function buildDraftRule(args: {
  sanitizedInput: string;
  orgId: string;
  provider: RuleDraftProvider;
}): Promise<
  | { ok: true; draft_rule: CreateOrgRuleInputT; confidence: number; warnings: string[] }
  | { ok: false; status: number; code: string; message: string }
> {
  let providerOut: DraftProviderOutput;
  try {
    providerOut = await args.provider.propose({
      prompt: args.sanitizedInput,
      orgId: args.orgId,
    });
  } catch (err) {
    logger.error({ error: err }, 'rules-draft: provider call failed');
    return {
      ok: false,
      status: 503,
      code: 'provider_unavailable',
      message: 'Draft unavailable — please use the wizard manually.',
    };
  }

  const patched = forceSafeDefaults(providerOut.candidate ?? {}, args.orgId);

  // Block unreviewable action types outright.
  if (patched.action_type && BLOCKED_ACTION_TYPES.has(patched.action_type)) {
    return {
      ok: false,
      status: 422,
      code: 'blocked_action',
      message:
        "I can't draft a FORWARD_TO_URL rule — add the target URL to your allowlist first, then use the wizard.",
    };
  }

  const parsed = CreateOrgRuleInput.safeParse(patched);
  if (!parsed.success) {
    return {
      ok: false,
      status: 422,
      code: 'schema_mismatch',
      message: "I didn't understand that — try rephrasing or use the wizard.",
    };
  }

  // Secondary validation layers (same as POST /rules). If Gemini tried to
  // inline a secret or ship a mismatched trigger_config, reject.
  try {
    validateRuleConfigs(parsed.data);
    assertNoInlineSecrets(parsed.data.trigger_config);
    assertNoInlineSecrets(parsed.data.action_config);
  } catch (err) {
    return {
      ok: false,
      status: 422,
      code: 'invalid_config',
      message: err instanceof Error ? err.message : 'Invalid draft config',
    };
  }

  const warnings = [...(providerOut.warnings ?? [])];
  if (providerOut.confidence < 0.7) {
    warnings.push("Low confidence — please review each field carefully before saving.");
  }

  return {
    ok: true,
    draft_rule: parsed.data,
    confidence: Math.max(0, Math.min(1, providerOut.confidence)),
    warnings,
  };
}

/**
 * Emit the RULE_DRAFT_REQUESTED audit event. Non-fatal — same pattern as
 * SEC-02 rule CRUD audit. Sanitized input is stored (raw input never).
 */
async function emitDraftAudit(params: {
  actorId: string;
  orgId: string;
  sanitizedInput: string;
  confidence: number | null;
  outcome: 'accepted' | 'rejected';
}): Promise<void> {
  try {
    await db.from('audit_events').insert({
      event_type: 'RULE_DRAFT_REQUESTED',
      event_category: 'AI',
      actor_id: params.actorId,
      org_id: params.orgId,
      target_type: 'rule_draft',
      target_id: null,
      details: JSON.stringify({
        sanitized_input: params.sanitizedInput,
        confidence: params.confidence,
        outcome: params.outcome,
      }),
    });
  } catch (err) {
    logger.warn({ error: err }, 'rules-draft audit emit failed');
  }
}

/** Express handler factory — caller injects the provider. */
export function makeHandleDraftRule(provider: RuleDraftProvider) {
  return async function handleDraftRule(
    userId: string,
    orgId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const parsed = DraftRequestInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'natural_language is required (1–1000 chars)',
        },
      });
      return;
    }

    const sanitizer = sanitizeRuleDraftInput(parsed.data.natural_language);
    if (sanitizer.rejection) {
      void emitDraftAudit({
        actorId: userId,
        orgId,
        sanitizedInput: sanitizer.clean,
        confidence: null,
        outcome: 'rejected',
      });
      res.status(422).json({
        error: {
          code: sanitizer.rejection,
          message: `Input rejected: ${sanitizer.rejection.replace(/_/g, ' ')}`,
        },
      });
      return;
    }

    const result = await buildDraftRule({
      sanitizedInput: sanitizer.clean,
      orgId,
      provider,
    });

    if (!result.ok) {
      void emitDraftAudit({
        actorId: userId,
        orgId,
        sanitizedInput: sanitizer.clean,
        confidence: null,
        outcome: 'rejected',
      });
      res.status(result.status).json({
        error: { code: result.code, message: result.message },
      });
      return;
    }

    void emitDraftAudit({
      actorId: userId,
      orgId,
      sanitizedInput: sanitizer.clean,
      confidence: result.confidence,
      outcome: 'accepted',
    });

    res.json({
      draft_rule: result.draft_rule,
      confidence: result.confidence,
      warnings: [...sanitizer.warnings, ...result.warnings],
    });
  };
}
