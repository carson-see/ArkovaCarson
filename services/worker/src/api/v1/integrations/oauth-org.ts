/** Shared org lookups for OAuth; each router decides where its gates apply. */
import { logger } from '../../../utils/logger.js';
import type { TypeSafeDatabase } from '../../../types/database-overrides.js';
import type { DbFilterQuery, DbQueryResult } from './oauth-db.js';

type Tables = TypeSafeDatabase['public']['Tables'];
type VerificationRow = Pick<Tables['organizations']['Row'], 'id'> & Partial<Pick<Tables['organizations']['Row'], 'verification_status' | 'suspended'>>;
type EventInsert = Tables['integration_events']['Insert'];
interface AdminLookupDb {
  from(table: 'org_members'): { select(columns: string): DbFilterQuery<Pick<Tables['org_members']['Row'], 'role'>> };
}
interface VerificationLookupDb {
  from(table: 'organizations'): { select(columns: string): DbFilterQuery<VerificationRow> };
}
interface EventDb {
  from(table: 'integration_events'): { insert(value: EventInsert): PromiseLike<DbQueryResult<unknown>> };
}

export type VerifiedOrgGate =
  | { allowed: true }
  | { allowed: false; reason: 'org_unverified' | 'org_suspended' | 'org_not_found' | 'lookup_failed' };

export async function requireOAuthOrgAdmin(db: AdminLookupDb, userId: string, orgId: string, providerName: string): Promise<boolean> {
  const { data, error } = await db.from('org_members').select('role')
    .eq('user_id', userId).eq('org_id', orgId).maybeSingle();
  if (error) {
    logger.error({ error, orgId }, `${providerName} OAuth admin lookup failed`);
    return false;
  }
  return data?.role === 'admin' || data?.role === 'owner';
}

export async function requireOAuthVerifiedOrg(db: VerificationLookupDb, orgId: string, providerName: string): Promise<VerifiedOrgGate> {
  const { data, error } = await db.from('organizations').select('id, verification_status, suspended')
    .eq('id', orgId).maybeSingle();
  if (error) {
    logger.error({ error, orgId }, `${providerName} OAuth org-verification lookup failed`);
    return { allowed: false, reason: 'lookup_failed' };
  }
  if (!data) return { allowed: false, reason: 'org_not_found' };
  if (data.verification_status !== 'VERIFIED') return { allowed: false, reason: 'org_unverified' };
  // Match the shipped entitlement: only explicit true suspends legacy rows.
  if (data.suspended === true) return { allowed: false, reason: 'org_suspended' };
  return { allowed: true };
}

export interface OAuthIntegrationEvent {
  orgId: string;
  integrationId?: string | null;
  eventType: string;
  status: 'success' | 'warning' | 'error';
  details?: EventInsert['details'];
}

export async function recordOAuthIntegrationEvent(db: EventDb, provider: EventInsert['provider'], providerName: string, args: OAuthIntegrationEvent): Promise<void> {
  const { error } = await db.from('integration_events').insert({
    org_id: args.orgId,
    integration_id: args.integrationId ?? null,
    provider,
    event_type: args.eventType,
    status: args.status,
    details: args.details ?? {},
  });
  if (error) {
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, `${providerName} integration event insert failed`);
  }
}
