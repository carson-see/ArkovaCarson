import { BANNED_RESPONSE_KEYS } from './response-schemas.js';

export function toPublicAttestation<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized: Record<string, unknown> = { ...row };
  delete sanitized.id;
  delete sanitized.attester_user_id;
  delete sanitized.attester_org_id;
  delete sanitized.anchor_id;
  for (const banned of BANNED_RESPONSE_KEYS) {
    delete sanitized[banned];
  }
  return sanitized as Partial<T>;
}
