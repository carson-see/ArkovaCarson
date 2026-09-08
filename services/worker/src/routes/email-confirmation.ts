/** SCRUM-4035: mailbox proof is the only operation available to a pending identity. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

export const confirmationStateSchema = z.object({
  required: z.boolean().optional(), error: z.string().optional(),
  userId: z.string().optional(), email: z.string().optional(), attemptId: z.string().optional(),
  sent: z.boolean().optional(), retryAfterSeconds: z.number().nonnegative().optional(),
});
type ConfirmationState = z.infer<typeof confirmationStateSchema>;
export interface ConfirmationDependencies {
  identify(request: Request): Promise<string | null>;
  manage(action: string, args?: Record<string, string>): Promise<ConfirmationState>;
  generate(email: string): Promise<{ userId: string; email: string; tokenHash: string }>;
  prove(tokenHash: string): Promise<{ userId: string; email: string; refreshToken: string }>;
  refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string } | null>;
  deliver(email: string, tokenHash: string, userId: string): Promise<boolean>;
}

const completeSchema = z.object({ token: z.string().min(20).max(1024) });
const INVALID_LINK = { error: 'This confirmation link has expired or was already used. Request a new email.', code: 'invalid_confirmation_link' };
const RETRY = { error: 'We could not confirm your email. Request a new email and try again.', code: 'confirmation_retry_required' };
function fail(res: Response, status: number, body = RETRY): void { res.status(status).json(body); }
function digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function normalize(email: string): string { return email.trim().toLowerCase(); }

export function createEmailConfirmationRouter(deps: ConfirmationDependencies): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const identity = async (req: Request, res: Response) => {
    const userId = await deps.identify(req);
    if (!userId) res.status(401).json({ error: 'Authentication required' });
    return userId;
  };

  router.get('/', async (req, res) => {
    try {
      const userId = await identity(req, res);
      if (!userId) return;
      const state = await deps.manage('status', { p_user_id: userId });
      if (state.error) { fail(res, 503); return; }
      res.json(state);
    } catch { fail(res, 503); }
  });

  router.post('/send', async (req, res) => {
    try {
      const userId = await identity(req, res);
      if (!userId) return;
      // The DB locks the identity and reserves the cooldown before token generation.
      const claim = await deps.manage('claim', { p_user_id: userId });
      if (claim.error === 'cooldown') {
        res.setHeader('Retry-After', String(claim.retryAfterSeconds));
        res.status(429).json({ error: 'Please wait before requesting another email.', code: 'confirmation_cooldown', retryAfterSeconds: claim.retryAfterSeconds });
        return;
      }
      if (claim.error) { fail(res, 503); return; }
      if (claim.required === false) { res.json({ required: false }); return; }
      if (!claim.email || !claim.attemptId) { fail(res, 503); return; }
      const generated = await deps.generate(claim.email);
      if (generated.userId !== userId || normalize(generated.email) !== claim.email || !generated.tokenHash) {
        fail(res, 503); return;
      }
      const args = { p_user_id: userId, p_email: claim.email, p_attempt_id: claim.attemptId, p_challenge_digest: digest(generated.tokenHash) };
      const registered = await deps.manage('register', args);
      if (registered.error || !registered.required) { fail(res, 503); return; }
      if (!await deps.deliver(claim.email, generated.tokenHash, userId)) { fail(res, 503); return; }
      const sent = await deps.manage('sent', args);
      if (sent.error || !sent.sent) { fail(res, 503); return; }
      // Never return the link, provider hash, attempt lease, or refresh token here.
      res.json({ required: true, sent: true, retryAfterSeconds: sent.retryAfterSeconds });
    } catch { fail(res, 503); }
  });

  router.post('/complete', async (req, res) => {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) { fail(res, 400, INVALID_LINK); return; }
    const { token } = parsed.data;
    try {
      const challengeDigest = digest(token);
      // Reject unknown/expired/replayed challenges before consuming upstream proof.
      const issued = await deps.manage('lookup', { p_challenge_digest: challengeDigest });
      if (issued.error || !issued.userId || !issued.email) { fail(res, 400, INVALID_LINK); return; }
      let proof;
      try { proof = await deps.prove(token); }
      catch { fail(res, 400, INVALID_LINK); return; }
      if (proof.userId !== issued.userId || normalize(proof.email) !== issued.email) { fail(res, 400, INVALID_LINK); return; }
      // SQL compares the current auth.users email and consumes the challenge atomically.
      // Neither a browser session nor a caller-supplied user ID decides the target.
      const completed = await deps.manage('complete', {
        p_user_id: proof.userId, p_email: normalize(proof.email), p_challenge_digest: challengeDigest,
      });
      if (completed.error || completed.required !== false) { fail(res, 400, INVALID_LINK); return; }
      let session = null;
      try { session = await deps.refresh(proof.refreshToken); }
      catch { /* Completed DB state survives: an existing session refresh/sign-in recovers. */ }
      res.json({ complete: true, session });
    } catch { fail(res, 503); }
  });
  return router;
}
