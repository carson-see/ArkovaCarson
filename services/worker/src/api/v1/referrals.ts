/**
 * GET /api/v1/referrals — SCRUM-5024
 *
 * A partner's own referral code plus the organizations that code introduced.
 * Read-only: there is no create/rotate/revoke surface here. Minting is an
 * ORG_ADMIN action in the app (`/settings/referrals`), and a v1 write endpoint
 * would freeze a contract for a feature whose commercial terms are still open.
 *
 * AUTH. `requireScope('read:orgs')` is mounted in `router.ts`, but it is NOT
 * authentication: it calls `next()` the moment `req.apiKey` is unset
 * (`middleware/apiKeyAuth.ts`), so an anonymous caller passes straight through
 * it. The 401 therefore lives in the handler, and the organization is taken
 * from `req.apiKey.orgId` — never from a query parameter, a body field, or
 * `req.apiKey.userId`.
 *
 * DISCLOSURE. Public ids only. The response carries no `id`, `org_id`,
 * `user_id`, `referral_code_id` or any other internal uuid, in any casing.
 * `organization_public_id` is omitted — not null — for an organization that
 * predates the public-id backfill, matching the frozen-schema rule that a null
 * optional field is left out (CLAUDE.md §6).
 *
 * WHAT THIS RESPONSE MEANS. It states who was introduced and when. It asserts
 * nothing about revenue, commission, payout eligibility or partner standing;
 * no field here feeds billing.
 */

import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

const router = Router();

export interface ReferredOrganization {
  /** Present only when the referred organization has a public id. */
  organization_public_id?: string;
  display_name: string;
  referred_at: string;
  verification_status: string;
}

export interface ReferralsResponse {
  /** The caller's own ACTIVE referral code, or null when none has been minted. */
  referral_code: string | null;
  /** The link a partner shares. Null exactly when `referral_code` is null. */
  share_url: string | null;
  referred: ReferredOrganization[];
  total: number;
}

interface ReferralRow {
  organization_public_id: string | null;
  display_name: string | null;
  referred_at: string | null;
  verification_status: string | null;
}

/** Require API key auth. Returns false and writes a 401 when missing. */
function requireApiKey(
  req: Request,
  res: Response,
): req is Request & { apiKey: NonNullable<Request['apiKey']> } {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required to read referrals',
    });
    return false;
  }
  return true;
}

function buildShareUrl(code: string): string {
  // `frontendUrl` is validated config, not caller input.
  return `${config.frontendUrl.replace(/\/+$/, '')}/signup?ref=${encodeURIComponent(code)}`;
}

router.get('/', async (req: Request, res: Response) => {
  if (!requireApiKey(req, res)) return;
  const { orgId } = req.apiKey;

  try {
    // The org's own ACTIVE code. A missing code is an ordinary state (nobody
    // has minted one yet) and answers 200 with `referral_code: null` — not a
    // 404, which would be indistinguishable from "this endpoint is gone".
    const { data: codeRow, error: codeError } = await db
      .from('referral_codes')
      .select('code')
      .eq('org_id', orgId)
      .eq('active', true)
      .maybeSingle();

    if (codeError) {
      logger.error(
        { error: codeError, orgIdPrefix: orgId?.slice(0, 8) },
        'Failed to read referral code',
      );
      res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve referrals' });
      return;
    }

    const { data: referralRows, error: referralError } = await db.rpc('get_org_referrals', {
      p_org_id: orgId,
    });

    if (referralError) {
      // Never degrade to an empty list: `referred: []` on a failed read is a
      // partner being told they referred nobody. Fail loudly instead.
      logger.error(
        { error: referralError, orgIdPrefix: orgId?.slice(0, 8) },
        'Failed to read organization referrals',
      );
      res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve referrals' });
      return;
    }

    // `referralRows` is empty-vs-error already resolved above: PostgREST returns
    // `[]` for a zero-row table function when there is no error, never null. No
    // `?? []` here — an unexpected null falls through to the catch below and is
    // a 500, not a silently reported empty referral list (BUILDER-CONTRACT #1).
    const rows = referralRows as ReferralRow[];
    const referred: ReferredOrganization[] = rows.map((row) => ({
      ...(row.organization_public_id ? { organization_public_id: row.organization_public_id } : {}),
      display_name: row.display_name ?? '',
      referred_at: row.referred_at ?? '',
      verification_status: row.verification_status ?? 'UNVERIFIED',
    }));

    const code = (codeRow as { code?: string } | null)?.code ?? null;

    const body: ReferralsResponse = {
      referral_code: code,
      share_url: code ? buildShareUrl(code) : null,
      referred,
      total: referred.length,
    };
    res.json(body);
  } catch (err) {
    logger.error(
      { err, orgIdPrefix: orgId?.slice(0, 8) },
      'Referrals endpoint threw',
    );
    res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve referrals' });
  }
});

export { router as referralsRouter };
