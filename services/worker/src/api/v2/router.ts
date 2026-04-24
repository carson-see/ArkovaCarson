/**
 * Verification API v2 Router
 *
 * Mounts all /api/v2/* endpoints with:
 *   1. Feature gate (ENABLE_VERIFICATION_API)
 *   2. API key auth
 *   3. RFC 7807 error handling
 *   4. Scope-based access control
 */

import { Router } from 'express';
import { verificationApiGate } from '../../middleware/featureGate.js';
import { apiKeyAuth } from '../../middleware/apiKeyAuth.js';
import { config } from '../../config.js';
import { v2ErrorHandler } from './problem.js';
import { searchRouter } from './search.js';

export const apiV2Router = Router();

apiV2Router.use(verificationApiGate());
apiV2Router.use(apiKeyAuth(config.apiKeyHmacSecret ?? ''));

apiV2Router.use('/search', searchRouter);

apiV2Router.use(v2ErrorHandler);
