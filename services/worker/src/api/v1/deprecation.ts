import { Request, Response, NextFunction } from 'express';

export const V1_DEPRECATION_HEADER = 'Sun, 23 Apr 2027 00:00:00 GMT; link="<https://arkova.ai/docs/v2-migration>; rel=successor-version"';
export const V1_SUNSET_HEADER = 'Sun, 23 Apr 2027 00:00:00 GMT';

export function v1DeprecationHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Deprecation', V1_DEPRECATION_HEADER);
  res.setHeader('Sunset', V1_SUNSET_HEADER);
  next();
}
