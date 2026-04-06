/**
 * API Credit System — Prepaid Credit Packs (PAY-01 / SCRUM-442)
 *
 * Endpoints for purchasing and managing API credits:
 *   GET  /api/v1/credits         — Check credit balance
 *   POST /api/v1/credits/purchase — Purchase a credit pack (creates Stripe checkout)
 *
 * Credit packs: 1K ($10), 10K ($80), 100K ($500), 1M ($3,000)
 *
 * Constitution refs:
 *   - 1.4: Never expose Stripe secret keys
 *   - 1.2: All writes validated with Zod
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

export const creditsRouter = Router();

// ─── Credit Pack Definitions ─────────────────────────────────────────

export const CREDIT_PACKS = [
  { id: 'pack_1k', credits: 1_000, price_usd: 10, label: '1,000 credits' },
  { id: 'pack_10k', credits: 10_000, price_usd: 80, label: '10,000 credits' },
  { id: 'pack_100k', credits: 100_000, price_usd: 500, label: '100,000 credits' },
  { id: 'pack_1m', credits: 1_000_000, price_usd: 3000, label: '1,000,000 credits' },
] as const;

export type CreditPackId = typeof CREDIT_PACKS[number]['id'];

// ─── Schemas ─────────────────────────────────────────────────────────

const purchaseSchema = z.object({
  pack_id: z.enum(['pack_1k', 'pack_10k', 'pack_100k', 'pack_1m']),
});

// ─── GET /api/v1/credits — Check balance ─────────────────────────────

creditsRouter.get('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const orgId = (req as any).orgId as string | undefined;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data, error } = await db.rpc('check_unified_credits', {
      p_org_id: orgId ?? null,
      p_user_id: userId,
    });

    if (error) {
      logger.error({ error }, 'Failed to check credits');
      res.status(500).json({ error: 'Failed to check credit balance' });
      return;
    }

    // check_unified_credits returns TABLE — Supabase may return array or single row
    const row = Array.isArray(data) ? data[0] : data;
    const credits = row as { monthly_allocation: number; used_this_month: number; remaining: number } | null;

    res.json({
      balance: credits?.remaining ?? 0,
      monthly_allocation: credits?.monthly_allocation ?? 0,
      used_this_month: credits?.used_this_month ?? 0,
      packs: CREDIT_PACKS,
    });
  } catch (err) {
    logger.error({ error: err }, 'Credit balance check failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

// ─── POST /api/v1/credits/purchase — Buy a credit pack ───────────────

creditsRouter.post('/purchase', async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const orgId = (req as any).orgId as string | undefined;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = purchaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.issues,
      valid_packs: CREDIT_PACKS.map((p) => p.id),
    });
    return;
  }

  const pack = CREDIT_PACKS.find((p) => p.id === parsed.data.pack_id);
  if (!pack) {
    res.status(400).json({ error: 'Unknown credit pack' });
    return;
  }

  try {
    if (!config.stripeSecretKey && config.nodeEnv !== 'production') {
      // Direct credit grant for development/testing only — NEVER in production
      const { error: grantError } = await db.rpc('deduct_unified_credits', {
        p_org_id: orgId ?? null,
        p_user_id: userId,
        p_amount: -pack.credits, // negative deduction = grant
      });

      if (grantError) {
        res.status(500).json({ error: 'Failed to grant credits' });
        return;
      }

      res.json({
        status: 'completed',
        credits_added: pack.credits,
        pack: pack.id,
        mode: 'development',
      });
      return;
    }

    // Production: Create Stripe checkout session for credit pack
    const { createCheckoutSession } = await import('../../stripe/client.js');
    const session = await createCheckoutSession({
      userId,
      priceId: `price_credits_${pack.id}`, // Stripe price ID
      mode: 'payment', // One-time payment for credit packs
      metadata: {
        pack_id: pack.id,
        credits: String(pack.credits),
        org_id: orgId ?? '',
      },
    });

    res.json({
      status: 'pending',
      checkout_url: session.url,
      pack: pack.id,
      credits: pack.credits,
      price_usd: pack.price_usd,
    });
  } catch (err) {
    logger.error({ error: err }, 'Credit purchase failed');
    res.status(500).json({ error: 'Purchase failed' });
  }
});

// ─── GET /api/v1/credits/packs — List available packs ────────────────

creditsRouter.get('/packs', (_req: Request, res: Response) => {
  res.json({ packs: CREDIT_PACKS });
});
