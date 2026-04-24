import { Request, Response, NextFunction } from 'express';
import { ProblemError } from './problem.js';
import { API_V2_SCOPES, type ApiV2Scope } from '../apiScopes.js';

export const VALID_SCOPES = API_V2_SCOPES;
export type ApiScope = ApiV2Scope;

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
