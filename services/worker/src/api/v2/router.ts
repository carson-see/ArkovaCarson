import { Router } from 'express';
import { verificationApiGate } from '../../middleware/featureGate.js';
import { config } from '../../config.js';
import { ProblemError, v2ErrorHandler } from './problem.js';
import { requireScopeV2 } from './scopeGuard.js';
import { buildSearchHandler, searchRouter } from './search.js';
import { v2ApiKeyRateLimit } from './rateLimit.js';
import { apiKeyAuthV2 } from './auth.js';
import { agentToolsRouter } from './agentTools.js';
import { apiV2OpenApiHandler } from './openapi.js';

export const apiV2Router = Router();

apiV2Router.get('/openapi.json', apiV2OpenApiHandler);
apiV2Router.use(verificationApiGate());

if (!config.apiKeyHmacSecret) {
  throw new Error('API_KEY_HMAC_SECRET is required when v2 API is mounted');
}
apiV2Router.use(apiKeyAuthV2(config.apiKeyHmacSecret));
apiV2Router.use(v2ApiKeyRateLimit);

apiV2Router.use('/search', searchRouter);
apiV2Router.get('/organizations', requireScopeV2('read:search'), buildSearchHandler('org'));
apiV2Router.get('/records', requireScopeV2('read:search'), buildSearchHandler('record'));
apiV2Router.get('/fingerprints', requireScopeV2('read:search'), buildSearchHandler('fingerprint'));
apiV2Router.get('/documents', requireScopeV2('read:search'), buildSearchHandler('document'));
apiV2Router.use(agentToolsRouter);

apiV2Router.use((req, _res, next) => {
  next(ProblemError.notFound(`No v2 route matched ${req.method} ${req.originalUrl}.`));
});
apiV2Router.use(v2ErrorHandler);
