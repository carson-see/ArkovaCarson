import { Request, Response, Router } from 'express';
import { agentsRouter } from './agents.js';

const router = Router();

function rejectCompatibilityFloorMutation(_req: Request, res: Response): void {
  res.setHeader('Retry-After', '300');
  res.status(503).json({
    error: {
      code: 'compatibility_floor_read_only',
      message: 'Agent lifecycle mutations are temporarily unavailable during compatibility maintenance.',
    },
  });
}

// This immutable compatibility artifact serves reads and drains durable
// webhook work while holding every generic lifecycle mutation before its
// handler can query or write. Authentication remains outside this router and
// therefore runs first at the /agents mount in router.ts.
router.post('/', rejectCompatibilityFloorMutation);
router.patch('/:agentId', rejectCompatibilityFloorMutation);
router.delete('/:agentId', rejectCompatibilityFloorMutation);
router.post('/:agentId/key', rejectCompatibilityFloorMutation);
router.use(agentsRouter);

export const agentsMaintenanceRouter = router;
