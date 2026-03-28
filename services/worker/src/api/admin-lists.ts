/**
 * Admin Lists API — Arkova Internal Only (SN1)
 *
 * GET /api/admin/users         — Paginated user list
 * GET /api/admin/records       — Paginated records list
 * GET /api/admin/subscriptions — Paginated subscriptions list
 *
 * All endpoints gated behind platform admin email whitelist.
 * These provide click-through detail for the Platform Overview dashboard.
 */

import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

/** Default page size — shared with frontend useAdminList hook */
export const ADMIN_PAGE_SIZE = 25;

/**
 * Escape ilike wildcard characters AND PostgREST filter syntax characters.
 * CRIT-3: PostgREST .or() uses commas, dots, and parens as delimiters.
 * Unescaped input can break out of the ilike value and inject filter conditions.
 */
function escapeIlike(input: string): string {
  // First escape SQL ilike wildcards
  let escaped = input.replace(/[%_\\]/g, '\\$&');
  // Then strip PostgREST filter syntax chars that could break .or() parsing
  escaped = escaped.replace(/[,.()"']/g, '');
  return escaped;
}

/** Parse pagination params with defaults */
function parsePagination(req: Request): { page: number; limit: number; search: string } {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || ADMIN_PAGE_SIZE));
  const rawSearch = (req.query.search as string || '').trim();
  // Sanitize search: escape ilike wildcards + limit length
  const search = escapeIlike(rawSearch).slice(0, 200);
  return { page, limit, search };
}

// ─── GET /api/admin/users ────────────────────────────────────

export async function handleAdminUsers(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { page, limit, search } = parsePagination(req);
  const offset = (page - 1) * limit;
  const roleFilter = (req.query.role as string) || '';

  try {
    let query = db
      .from('profiles')
      .select('id, email, full_name, role, org_id, is_platform_admin, created_at, updated_at, deleted_at', { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
    }
    if (roleFilter) {
      query = query.eq('role', roleFilter as 'INDIVIDUAL' | 'ORG_ADMIN' | 'ORG_MEMBER');
    }

    const { data: users, count, error } = await query;

    if (error) {
      logger.error({ error }, 'Admin users query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    // Enrich with org names
    const orgIds = [...new Set((users ?? []).map((u) => u.org_id).filter((id): id is string => id != null))];
    let orgMap: Record<string, string> = {};
    if (orgIds.length > 0) {
      const { data: orgs } = await db
        .from('organizations')
        .select('id, display_name')
        .in('id', orgIds);
      if (orgs) {
        orgMap = Object.fromEntries(orgs.map((o) => [o.id, o.display_name]));
      }
    }

    res.json({
      users: (users ?? []).map((u) => ({
        ...u,
        org_name: u.org_id ? (orgMap[u.org_id] ?? null) : null,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error({ error }, 'Admin users request failed');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

// ─── GET /api/admin/users/:id ─────────────────────────────────

export async function handleAdminUserDetail(
  userId: string,
  targetUserId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  try {
    // Fetch user profile
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('id, email, full_name, role, org_id, is_platform_admin, created_at, updated_at')
      .eq('id', targetUserId)
      .is('deleted_at', null)
      .single();

    if (profileError || !profile) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Fetch org name if applicable
    let orgName: string | null = null;
    if (profile.org_id) {
      const { data: org } = await db
        .from('organizations')
        .select('display_name')
        .eq('id', profile.org_id)
        .single();
      orgName = org?.display_name ?? null;
    }

    // Fetch user's records (most recent 25)
    const { data: records } = await db
      .from('anchors')
      .select('id, public_id, filename, credential_type, status, chain_tx_id, created_at')
      .eq('user_id', targetUserId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(25);

    // Fetch user's subscription
    const { data: subscription } = await db
      .from('subscriptions')
      .select('id, status, current_period_end, plans(name)')
      .eq('user_id', targetUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({
      user: {
        ...profile,
        org_name: orgName,
      },
      records: records ?? [],
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        plan_name: (subscription.plans as { name: string } | null)?.name ?? null,
        current_period_end: subscription.current_period_end,
      } : null,
    });
  } catch (error) {
    logger.error({ error, targetUserId }, 'Admin user detail request failed');
    res.status(500).json({ error: 'Failed to fetch user detail' });
  }
}

// ─── GET /api/admin/records ──────────────────────────────────

export async function handleAdminRecords(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { page, limit, search } = parsePagination(req);
  const offset = (page - 1) * limit;
  const statusFilter = (req.query.status as string) || '';
  const typeFilter = (req.query.type as string) || '';

  try {
    let query = db
      .from('anchors')
      .select('id, public_id, filename, credential_type, status, chain_tx_id, fingerprint, user_id, org_id, created_at, metadata', { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`filename.ilike.%${search}%,public_id.ilike.%${search}%,fingerprint.ilike.%${search}%`);
    }
    if (statusFilter) {
      // Status filter from user input — Supabase returns 0 rows for invalid values (safe)
      query = query.eq('status', statusFilter as 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED');
    }
    if (typeFilter) {
      query = query.eq('credential_type', typeFilter as 'DEGREE' | 'LICENSE' | 'CERTIFICATE' | 'TRANSCRIPT' | 'PROFESSIONAL' | 'OTHER');
    }

    const { data: records, count, error } = await query;

    if (error) {
      logger.error({ error }, 'Admin records query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    // Enrich with user emails
    const userIds = [...new Set((records ?? []).map((r) => r.user_id).filter(Boolean))];
    let userMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await db
        .from('profiles')
        .select('id, email')
        .in('id', userIds);
      if (profiles) {
        userMap = Object.fromEntries(profiles.map((p) => [p.id, p.email]));
      }
    }

    res.json({
      records: (records ?? []).map((r) => ({
        ...r,
        user_email: r.user_id ? (userMap[r.user_id] ?? null) : null,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error({ error }, 'Admin records request failed');
    res.status(500).json({ error: 'Failed to fetch records' });
  }
}

// ─── GET /api/admin/subscriptions ────────────────────────────

export async function handleAdminSubscriptions(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { page, limit } = parsePagination(req);
  const offset = (page - 1) * limit;
  const statusFilter = (req.query.status as string) || '';

  try {
    let query = db
      .from('subscriptions')
      .select('id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end, created_at, plans(name, price_cents)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    const { data: subscriptions, count, error } = await query;

    if (error) {
      logger.error({ error }, 'Admin subscriptions query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    // Enrich with user emails
    const userIds = [...new Set((subscriptions ?? []).map((s) => s.user_id).filter(Boolean))];
    let userMap: Record<string, { email: string; full_name: string | null }> = {};
    if (userIds.length > 0) {
      const { data: profiles } = await db
        .from('profiles')
        .select('id, email, full_name')
        .in('id', userIds);
      if (profiles) {
        userMap = Object.fromEntries(profiles.map((p) => [p.id, { email: p.email, full_name: p.full_name }]));
      }
    }

    res.json({
      subscriptions: (subscriptions ?? []).map((s) => ({
        ...s,
        user_email: s.user_id ? (userMap[s.user_id]?.email ?? null) : null,
        user_name: s.user_id ? (userMap[s.user_id]?.full_name ?? null) : null,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error({ error }, 'Admin subscriptions request failed');
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
}

// ─── GET /api/admin/organizations ────────────────────────────

export async function handleAdminOrganizations(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const { page, limit, search } = parsePagination(req);
  const offset = (page - 1) * limit;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = db as any;

    let query = dbAny
      .from('organizations')
      .select('id, legal_name, display_name, domain, org_prefix, verification_status, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`display_name.ilike.%${search}%,legal_name.ilike.%${search}%,domain.ilike.%${search}%`);
    }

    const { data: orgs, count, error } = await query;

    if (error) {
      logger.error({ error }, 'Admin organizations query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    // Enrich with member count + anchor count
    const orgIds = (orgs ?? []).map((o: { id: string }) => o.id);
    const memberCounts: Record<string, number> = {};
    const anchorCounts: Record<string, number> = {};

    if (orgIds.length > 0) {
      // Member counts
      const { data: members } = await db
        .from('profiles')
        .select('org_id')
        .in('org_id', orgIds)
        .is('deleted_at', null);
      if (members) {
        for (const m of members) {
          if (m.org_id) memberCounts[m.org_id] = (memberCounts[m.org_id] ?? 0) + 1;
        }
      }

      // Anchor counts
      const { data: anchors } = await db
        .from('anchors')
        .select('org_id')
        .in('org_id', orgIds)
        .is('deleted_at', null);
      if (anchors) {
        for (const a of anchors) {
          if (a.org_id) anchorCounts[a.org_id] = (anchorCounts[a.org_id] ?? 0) + 1;
        }
      }
    }

    res.json({
      organizations: (orgs ?? []).map((o: { id: string }) => ({
        ...o,
        member_count: memberCounts[o.id] ?? 0,
        anchor_count: anchorCounts[o.id] ?? 0,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error({ error }, 'Admin organizations request failed');
    res.status(500).json({ error: 'Failed to fetch organizations' });
  }
}
