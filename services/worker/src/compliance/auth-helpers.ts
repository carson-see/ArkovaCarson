/**
 * Compliance Auth Helpers
 *
 * Shared authentication utilities for compliance API routes.
 */

import { Request, Response } from 'express';
import { db } from '../utils/db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

/**
 * Get the caller's org ID from their user ID.
 * Sends 401/403 response and returns null if auth fails.
 */
export async function getCallerOrgId(req: Request, res: Response): Promise<string | null> {
  if (!req.authUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  const { data: membership } = await dbAny
    .from('org_members')
    .select('org_id')
    .eq('user_id', req.authUserId)
    .single();

  if (!membership?.org_id) {
    res.status(403).json({ error: 'Must belong to an organization' });
    return null;
  }

  return membership.org_id as string;
}
