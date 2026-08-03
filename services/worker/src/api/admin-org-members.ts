/**
 * Admin Org Members API — Arkova Internal Only
 *
 * GET  /api/admin/organizations/:id/members  — List an org's roster
 * GET  /api/admin/users/search?email=…        — Find a platform user by email
 * POST /api/admin/organizations/:id/members   — Add an existing user to the org
 *
 * WHY THIS EXISTS
 * ---------------
 * The org profile UI (OrgProfilePage / AddExistingMemberModal) queries Supabase
 * directly from the browser under RLS. The `org_members` SELECT policies only
 * return rows for orgs the caller belongs to (`org_members_select_org`) or the
 * caller's own row (`org_members_select_own`); `profiles` SELECT is similarly
 * scoped. There is NO platform-admin bypass in RLS, so a platform admin viewing
 * an org they are not a member of saw "0 members" and "No user found with that
 * email" even though the data was correct.
 *
 * These endpoints mirror the existing service_role admin pattern (admin-lists.ts
 * / admin-actions.ts): the worker `db` client uses service_role and bypasses RLS,
 * and EVERY endpoint is gated with isPlatformAdmin(userId). No RLS/schema change.
 *
 * The roster reads `org_members` first, then fetches profile details. This keeps
 * multi-org memberships visible: add-member inserts `org_members` and only
 * backfills `profiles.org_id` when it is currently null, so `profiles.org_id`
 * alone is not a complete membership source.
 *
 * Add-member writes go through the service_role client directly (insert into
 * org_members + backfill profiles + audit row). We deliberately do NOT call the
 * `add_org_member` RPC: it resolves the caller via `auth.uid()`, which is NULL
 * under the worker's service_role client, so it would raise on every call (the
 * SCRUM-2213 trap — see services/worker/src/api/agents.md).
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { chunkForInFilter } from '../utils/postgrest-filter.js';

const FORBIDDEN = { error: 'Forbidden — platform admin access required' };

/** RFC-4122-ish UUID guard (accepts any version). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Profile `user_role` (INDIVIDUAL / ORG_ADMIN) → org_members `org_member_role`
 * (owner / admin / member). The UI add-member modal only exposes Member / Admin,
 * which map to INDIVIDUAL / ORG_ADMIN. Owner is reserved for org creation and is
 * never assignable through this flow.
 */
const PROFILE_ROLE_TO_MEMBER_ROLE: Record<'INDIVIDUAL' | 'ORG_ADMIN', 'member' | 'admin'> = {
  INDIVIDUAL: 'member',
  ORG_ADMIN: 'admin',
};

function memberRoleToProfileRole(role: unknown): 'ORG_ADMIN' | 'INDIVIDUAL' {
  return role === 'owner' || role === 'admin' ? 'ORG_ADMIN' : 'INDIVIDUAL';
}

interface OrgMemberRow {
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

// ─── GET /api/admin/organizations/:id/members ────────────────────────────────

export async function handleAdminOrgMembers(
  userId: string,
  orgId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  if (!isUuid(orgId)) {
    res.status(400).json({ error: 'Invalid organization id' });
    return;
  }

  try {
    const { data: memberRows, error: memberError } = await db
      .from('org_members')
      .select('user_id, role, joined_at')
      .eq('org_id', orgId)
      .order('joined_at', { ascending: true })
      .limit(500);

    if (memberError) {
      logger.error({ error: memberError, orgId }, 'Admin org members membership query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    const memberships = (memberRows ?? []) as OrgMemberRow[];
    const userIds = memberships.map((m) => m.user_id);
    if (userIds.length === 0) {
      res.json({ members: [] });
      return;
    }

    // The roster select above is `.limit(500)`, and all 500 ids went into one
    // `.in('id', userIds)` — roughly 18.5 KB of encoded query string against an
    // 8 KiB budget. PostgREST answered 400 from about 220 members up, and since
    // the error IS handled here the symptom was the member list 500ing for
    // exactly the largest orgs.
    const profilesById = new Map<string, ProfileRow>();
    for (const { values, start } of chunkForInFilter(userIds)) {
      const { data: profileRows, error: profileError } = await db
        .from('profiles')
        .select('id, email, full_name, avatar_url')
        .in('id', values)
        .is('deleted_at', null);

      if (profileError) {
        logger.error(
          { error: profileError, orgId, chunkStart: start, chunkSize: values.length },
          'Admin org members profile query failed',
        );
        res.status(500).json({ error: 'Query failed' });
        return;
      }

      for (const p of profileRows ?? []) profilesById.set(p.id, p as ProfileRow);
    }
    const members = memberships.flatMap((membership) => {
      const profile = profilesById.get(membership.user_id);
      if (!profile) return [];
      return [{
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        avatarUrl: profile.avatar_url ?? null,
        role: memberRoleToProfileRole(membership.role),
        joinedAt: membership.joined_at,
        status: 'active' as const,
      }];
    });

    res.json({ members });
  } catch (error) {
    logger.error({ error, orgId }, 'Admin org members request failed');
    res.status(500).json({ error: 'Failed to fetch members' });
  }
}

// ─── GET /api/admin/users/search?email=… ─────────────────────────────────────

export async function handleAdminUserSearch(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  const email = ((req.query.email as string) ?? '').trim().toLowerCase();
  if (!email) {
    res.status(400).json({ error: 'email query parameter is required' });
    return;
  }

  try {
    // Exact-match lookup by email (the add-member flow keys on a known address),
    // mirroring AddExistingMemberModal's `.eq('email', …)` but via service_role.
    const { data: profiles, error } = await db
      .from('profiles')
      .select('id, email, full_name')
      .eq('email', email)
      .is('deleted_at', null)
      .limit(1);

    if (error) {
      logger.error({ error }, 'Admin user search query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    const match = profiles?.[0];
    res.json({
      user: match
        ? { id: match.id, email: match.email, full_name: match.full_name }
        : null,
    });
  } catch (error) {
    logger.error({ error }, 'Admin user search request failed');
    res.status(500).json({ error: 'Failed to search users' });
  }
}

// ─── POST /api/admin/organizations/:id/members ───────────────────────────────

export async function handleAdminAddOrgMember(
  userId: string,
  orgId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(userId))) {
    res.status(403).json(FORBIDDEN);
    return;
  }

  if (!isUuid(orgId)) {
    res.status(400).json({ error: 'Invalid organization id' });
    return;
  }

  const { user_id: targetUserId, role } = (req.body ?? {}) as {
    user_id?: unknown;
    role?: unknown;
  };

  if (!isUuid(targetUserId)) {
    res.status(400).json({ error: 'user_id must be a UUID string' });
    return;
  }
  if (role !== 'INDIVIDUAL' && role !== 'ORG_ADMIN') {
    res.status(400).json({ error: 'role must be INDIVIDUAL or ORG_ADMIN' });
    return;
  }
  const memberRole = PROFILE_ROLE_TO_MEMBER_ROLE[role];

  try {
    // 1. Target user must exist (and not be soft-deleted).
    const { data: target, error: targetError } = await db
      .from('profiles')
      .select('id, email, full_name, org_id')
      .eq('id', targetUserId)
      .is('deleted_at', null)
      .maybeSingle();

    if (targetError) {
      logger.error({ error: targetError, targetUserId }, 'Add member: profile lookup failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // 2. Reject duplicate membership (org_members has a UNIQUE(user_id, org_id),
    //    but we check first so the UI gets a clean 409 instead of a 500).
    const { data: existing, error: existingError } = await db
      .from('org_members')
      .select('id')
      .eq('user_id', targetUserId)
      .eq('org_id', orgId)
      .maybeSingle();

    if (existingError) {
      logger.error({ error: existingError, targetUserId, orgId }, 'Add member: membership check failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }
    if (existing) {
      res.status(409).json({ error: 'User is already a member of this organization' });
      return;
    }

    // 3. Insert the membership row (service_role bypasses the is_org_admin_of
    //    INSERT policy — the platform-admin gate above is the authority here).
    const { error: insertError } = await db.from('org_members').insert({
      user_id: targetUserId,
      org_id: orgId,
      role: memberRole,
      invited_by: userId,
    });

    if (insertError) {
      logger.error({ error: insertError, targetUserId, orgId }, 'Add member: insert failed');
      res.status(500).json({ error: 'Failed to add member' });
      return;
    }

    // 4. Backfill profiles.org_id only when unset — never reassign a user who
    //    already belongs elsewhere (matches add_org_member's `org_id IS NULL`).
    if (!target.org_id) {
      const { error: profileError } = await db
        .from('profiles')
        .update({ org_id: orgId, role })
        .eq('id', targetUserId)
        .is('org_id', null);
      if (profileError) {
        // Non-fatal: membership exists; log and continue so the UI still succeeds.
        logger.warn({ error: profileError, targetUserId, orgId }, 'Add member: profile org backfill failed');
      }
    }

    // 5. Audit row (append-only; service_role-only per audit_events policy).
    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'MEMBER_ADDED',
      event_category: 'ORGANIZATION',
      actor_id: userId,
      org_id: orgId,
      target_type: 'user',
      target_id: targetUserId,
      details: JSON.stringify({ role: memberRole, added_by: userId, via: 'platform_admin' }),
    });
    if (auditError) {
      logger.warn({ error: auditError, targetUserId, orgId }, 'Add member: audit emit failed');
    }

    logger.info({ targetUserId, orgId, role: memberRole, addedBy: userId }, 'Platform admin added org member');
    res.json({
      success: true,
      member: {
        id: target.id,
        email: target.email,
        fullName: target.full_name,
        role,
      },
    });
  } catch (error) {
    logger.error({ error, targetUserId, orgId }, 'Add member request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}
