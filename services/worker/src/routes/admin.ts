/**
 * Admin Routes
 *
 * Treasury status, platform stats, system health, and detail lists.
 * All endpoints require platform admin authentication.
 * Extracted from index.ts as part of ARCH-1 refactor.
 */

import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { rateLimiters } from '../utils/rateLimit.js';
import { corsMiddleware, extractAuthUserId } from './middleware.js';
// DEBT-3: Static imports — circular dependency resolved by router extraction
import { handleTreasuryStatus } from '../api/treasury.js';
import { handlePlatformStats } from '../api/admin-stats.js';
import { handleSystemHealth } from '../api/admin-health.js';
import { handleAdminOrganizations, handleAdminUsers, handleAdminUserDetail, handleAdminRecords, handleAdminSubscriptions } from '../api/admin-lists.js';
import { handlePromoteAdmin, handleChangeRole, handleSetOrg } from '../api/admin-actions.js';

export const adminRouter = Router();

adminRouter.use(corsMiddleware);
adminRouter.use(rateLimiters.checkout);

// ─── Treasury Status (feedback_treasury_access: Arkova-internal only) ───
adminRouter.get('/treasury/status', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    await handleTreasuryStatus(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Treasury status request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Platform Stats ───
adminRouter.get('/admin/platform-stats', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    await handlePlatformStats(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Platform stats request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── System Health ───
adminRouter.get('/admin/system-health', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    await handleSystemHealth(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'System health request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Admin Detail Lists (SN1) ───
adminRouter.get('/admin/organizations', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAdminOrganizations(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Admin organizations request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/admin/users', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAdminUsers(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Admin users request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/admin/users/:id', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAdminUserDetail(userId, req.params.id, req, res);
  } catch (error) {
    logger.error({ error }, 'Admin user detail request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/admin/records', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAdminRecords(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Admin records request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/admin/subscriptions', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAdminSubscriptions(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Admin subscriptions request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Admin Actions (POST) ───

adminRouter.post('/admin/users/:id/promote-admin', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handlePromoteAdmin(userId, req.params.id, req, res);
  } catch (error) {
    logger.error({ error }, 'Promote admin request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/admin/users/:id/change-role', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleChangeRole(userId, req.params.id, req, res);
  } catch (error) {
    logger.error({ error }, 'Change role request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/admin/users/:id/set-org', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleSetOrg(userId, req.params.id, req, res);
  } catch (error) {
    logger.error({ error }, 'Set org request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
