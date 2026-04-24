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
import { handlePipelineStats } from '../api/admin-pipeline-stats.js';
import { handleSystemHealth } from '../api/admin-health.js';
import { handleAdminOrganizations, handleAdminUsers, handleAdminUserDetail, handleAdminRecords, handleAdminSubscriptions } from '../api/admin-lists.js';
import { handlePromoteAdmin, handleChangeRole, handleSetOrg } from '../api/admin-actions.js';
import { handleListPendingResolution, handleResolveQueue } from '../api/queue-resolution.js';
import { handleSupersedeAnchor, handleAnchorLineage } from '../api/anchor-lineage.js';
import { handleTreasuryHealth } from '../api/treasury.js';
import { handleListRules, handleGetRule, handleCreateRule, handleUpdateRule, handleDeleteRule } from '../api/rules-crud.js';
import { handleMarkNotificationsRead, handleUnreadNotificationCount } from '../api/notifications.js';
import { getQueryStats } from '../utils/queryMonitor.js';
import { getConnectionInfo } from '../utils/db.js';
import { getRateLimitStoreSize } from '../utils/rateLimit.js';

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

// ─── Pipeline Stats (SCRUM-457) ───
adminRouter.get('/admin/pipeline-stats', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    await handlePipelineStats(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Pipeline stats request failed');
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

// ─── ARK-101 (SCRUM-1011): Anchor queue resolution ───
// Authz: `list_pending_resolution_anchors` returns only caller's org rows;
// `resolve_anchor_queue` enforces ORG_ADMIN role inside the RPC.
adminRouter.get('/queue/pending', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleListPendingResolution(req, res);
  } catch (error) {
    logger.error({ error }, 'Queue pending request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/queue/resolve', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleResolveQueue(req, res, userId);
  } catch (error) {
    logger.error({ error }, 'Queue resolve request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ARK-104 (SCRUM-1014): Anchor lineage + supersede ───
adminRouter.get('/anchor/:id/lineage', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleAnchorLineage(req, res);
  } catch (error) {
    logger.error({ error }, 'Anchor lineage request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/anchor/:id/supersede', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleSupersedeAnchor(req, res);
  } catch (error) {
    logger.error({ error }, 'Anchor supersede request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ARK-103 (SCRUM-1013): Treasury health — platform admin only ───
// Matches /treasury/status access policy: no carve-out for org admins.
// USD aggregates are still treasury state; only Arkova operators see them.
adminRouter.get('/treasury/health', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleTreasuryHealth(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Treasury health request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── ARK-105/108 (SCRUM-1017/1020): Rules Engine CRUD ───
adminRouter.get('/rules', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleListRules(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Rules list request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.get('/rules/:id', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleGetRule(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Rules detail request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/rules', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleCreateRule(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Rules create request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.patch('/rules/:id', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleUpdateRule(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Rules update request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.delete('/rules/:id', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleDeleteRule(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Rules delete request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── User notifications: queue/job/version-review badges ───
adminRouter.get('/notifications/unread-count', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleUnreadNotificationCount(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Notification count request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminRouter.post('/notifications/mark-read', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    await handleMarkNotificationsRead(userId, req, res);
  } catch (error) {
    logger.error({ error }, 'Notification mark-read request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── QA-PERF-6: Query Performance Stats ───
adminRouter.get('/admin/query-stats', async (req, res) => {
  const userId = await extractAuthUserId(req);
  if (!userId) { res.status(401).json({ error: 'Authentication required' }); return; }
  try {
    res.json({
      queryStats: getQueryStats(),
      connection: getConnectionInfo(),
      rateLimitStoreSize: getRateLimitStoreSize(),
    });
  } catch (error) {
    logger.error({ error }, 'Query stats request failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
