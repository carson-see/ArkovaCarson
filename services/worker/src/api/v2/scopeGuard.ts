import { Request, Response, NextFunction } from 'express';
import { ProblemError } from './problem.js';

export const VALID_SCOPES = [
  'read:records',
  'read:orgs',
  'read:search',
  'write:anchors',
  'admin:rules',
] as const;

export type ApiScope = typeof VALID_SCOPES[number];

export function requireScopeV2(scope: ApiScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.apiKey) {
      next(ProblemError.authenticationRequired());
      return;
    }

    if (!req.apiKey.scopes?.includes(scope)) {
      next(ProblemError.invalidScope(scope, req.apiKey.scopes ?? []));
      return;
    }

    next();
  };
}
