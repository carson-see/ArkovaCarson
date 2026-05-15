/**
 * Express Request type augmentation.
 *
 * Centralizes custom properties attached by auth and payment middleware
 * so downstream handlers can access them without `(req as any)` casts.
 *
 * Properties already declared elsewhere (kept in their middleware files):
 *   - `apiKey`  → src/middleware/apiKeyAuth.ts (ApiKeyMeta)
 *   - `orgId`   → src/middleware/requireOrgId.ts
 *   - `authUserId` / `hmacSecret` → src/api/v1/keys.ts
 *
 * Properties declared here:
 *   - `userId`            — set by requireAuth (src/routes/middleware.ts)
 *   - `paymentResolution` — set by paymentTierRouter (src/middleware/paymentTierRouter.ts)
 *   - `rawBody`           — set by raw-body parser for webhook HMAC verification
 */

import type { PaymentResolution } from '../middleware/paymentTierRouter.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authenticated user ID, set by requireAuth middleware. */
      userId?: string;
      /** Payment resolution result, set by paymentTierRouter middleware. */
      paymentResolution?: PaymentResolution;
      /** Raw request body buffer, set by raw-body parser for HMAC verification. */
      rawBody?: Buffer | string;
      /** Request ID, set by request-id middleware (e.g. express-request-id). */
      id?: string;
    }
  }
}

export {};
