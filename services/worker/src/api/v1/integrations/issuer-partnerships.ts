/**
 * Issuer Partnerships API — SCRUM-2082 CSI-04D.
 *
 * Admin endpoints that back the "Connected Issuers" UI page.
 *
 *   GET    /api/v1/integrations/issuer-partnerships
 *   POST   /api/v1/integrations/issuer-partnerships
 *   DELETE /api/v1/integrations/issuer-partnerships/:rowId
 *
 * Scope:
 *   - List: row metadata for the caller's org_admin (NEVER tokens/secrets)
 *   - Connect: store encrypted credentials for credly | accredible | udemy
 *   - Disconnect: soft-revoke via `revoked_at = now()`
 *
 * Auth model:
 *   - Caller must be authenticated (req.user set by upstream auth middleware)
 *   - Caller must be `owner` or `admin` on the target org_id (verified via
 *     org_members row; service_role queries used so RLS doesn't shadow the
 *     admin check)
 *
 * Constitution refs:
 *   - 1.4: KMS-backed token encryption; cleartext never logged or returned
 *   - 1.7: tests must not call real KMS or Postgres — inject fakes
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import {
  createDefaultKmsClient,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';
import {
  storeIssuerCredentials,
  storeApiKeyCredentials,
  type CredentialProvider,
  type MemberIntegrationRowDeps,
} from '../../../integrations/credential-sources/token-store.js';

// ---------------------------------------------------------------------------
// Local DB typing
//
// `member_integrations` is not present in the generated `database.types.ts`
// (DocuSign + this feature both write it via the same pattern). Rather than
// scatter `as unknown as never` casts — which silence the type checker and
// hide real mistakes — we declare a narrow, hand-written DB facade that
// describes exactly the tables + operations these endpoints touch. This
// mirrors the established approach in `docusign-member-oauth.ts`.
// ---------------------------------------------------------------------------

/** A supabase-js result envelope. */
type DbResult<T> = { data: T | null; error: unknown };

/** Row shape read back from `org_members` for the admin check. */
interface OrgMemberRoleRow {
  role: string;
}

/** Row shape read back from `member_integrations` by the list endpoint. */
interface MemberIntegrationListRow {
  id: string;
  org_id: string;
  provider: CredentialProvider;
  account_id: string;
  account_label: string | null;
  connected_at: string;
  revoked_at: string | null;
  kek_version: number;
}

/** Row shape read back when resolving a single integration for revoke. */
interface MemberIntegrationRevokeRow {
  id: string;
  org_id: string;
  provider: string;
  revoked_at: string | null;
}

/** Row shape read back for the rowStore upsert/fetch helpers. */
interface MemberIntegrationIdRow {
  id: string;
}

interface MemberIntegrationEncryptedRow {
  encrypted_tokens: Buffer | null;
  token_kms_key_id: string | null;
  kek_version: number;
}

/**
 * Minimal fluent query-builder facade — the subset of the supabase-js builder
 * these endpoints rely on. The builder is itself awaitable (PromiseLike),
 * resolving to a {@link DbResult}. `select<Row>()` re-parameterises the row
 * type so each call site stays type-safe with no per-column casts.
 */
interface DbQuery<TRow> extends PromiseLike<DbResult<TRow[]>> {
  select<Row = TRow>(columns?: string): DbQuery<Row>;
  insert(value: Record<string, unknown>): DbQuery<TRow>;
  update(value: Record<string, unknown>): DbQuery<TRow>;
  eq(column: string, value: unknown): DbQuery<TRow>;
  is(column: string, value: null): DbQuery<TRow>;
  in(column: string, values: ReadonlyArray<unknown>): DbQuery<TRow>;
  order(column: string, opts: { ascending: boolean }): DbQuery<TRow>;
  limit(count: number): DbQuery<TRow>;
}

/**
 * Narrow DB facade — only the tables these endpoints touch. Each `from()`
 * overload starts an untyped builder; call sites pin the row type via
 * `.select<Row>()` (reads) so results are typed without casts.
 */
export interface IssuerPartnershipsDb {
  from(table: 'org_members'): DbQuery<OrgMemberRoleRow>;
  from(table: 'member_integrations'): DbQuery<MemberIntegrationIdRow>;
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ConnectCredlyBody = z.object({
  provider: z.literal('credly'),
  org_id: z.string().uuid(),
  account_id: z.string().min(1).max(256),
  account_label: z.string().min(1).max(256).optional(),
  credentials: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    scope: z.string().optional(),
  }),
});

const ConnectApiKeyBody = z.object({
  provider: z.enum(['accredible', 'udemy']),
  org_id: z.string().uuid(),
  account_id: z.string().min(1).max(256),
  account_label: z.string().min(1).max(256).optional(),
  credentials: z.object({
    api_key: z.string().min(1),
    key_label: z.string().optional(),
  }),
});

const ConnectBody = z.discriminatedUnion('provider', [
  ConnectCredlyBody,
  ConnectApiKeyBody,
]);

// ---------------------------------------------------------------------------
// Listing / authorisation helpers
// ---------------------------------------------------------------------------

/** Row shape returned by the list endpoint — never includes secrets. */
export interface IssuerPartnershipSummary {
  id: string;
  org_id: string;
  provider: CredentialProvider;
  account_id: string;
  account_label: string | null;
  connected_at: string;
  revoked_at: string | null;
  kek_version: number;
  /** Reserved for CSI-05 (Sprint 2) — populated by the auto-import cron. */
  last_sync_at: string | null;
  /** Reserved for CSI-05 — credential count populated by the cron. */
  credential_count: number | null;
}

const CREDENTIAL_PROVIDERS: ReadonlyArray<CredentialProvider> = [
  'credly',
  'accredible',
  'udemy',
];

/** RFC 4122 UUID matcher for the :rowId path param. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verify the caller is org_admin / owner on the target org. Returns true
 * when authorised. Uses the service_role db client (not the per-request RLS
 * client) so we read membership without depending on whatever RLS sees.
 */
export async function isOrgAdmin(
  db: IssuerPartnershipsDb,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('org_members')
    .select<OrgMemberRoleRow>('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role;
  return role === 'admin' || role === 'owner';
}

// ---------------------------------------------------------------------------
// Router factory (deps-injected so tests inject fakes; prod uses defaults)
// ---------------------------------------------------------------------------

export interface IssuerPartnershipsRouterDeps {
  db?: IssuerPartnershipsDb;
  kms?: KmsClient;
  rowStore?: MemberIntegrationRowDeps;
}

/**
 * Adapt the real service_role supabase-js client to the narrow
 * {@link IssuerPartnershipsDb} facade. This is the single seam where the
 * untyped-for-`member_integrations` client meets our hand-written types; the
 * cast is intentional and localised (mirrors `docusign-member-oauth.ts`).
 */
function asIssuerPartnershipsDb(
  db: typeof defaultDb,
): IssuerPartnershipsDb {
  return db as unknown as IssuerPartnershipsDb;
}

/**
 * Default rowStore that talks to Postgres via the service_role db client.
 * Tests inject an in-memory rowStore instead.
 */
function createDefaultRowStore(
  db: IssuerPartnershipsDb,
): MemberIntegrationRowDeps {
  return {
    async upsertEncryptedRow(input) {
      // Try update first (existing active row), then insert if none.
      const { data: existing, error: selErr } = await db
        .from('member_integrations')
        .select<MemberIntegrationIdRow>('id')
        .eq('user_id', input.userId)
        .eq('org_id', input.orgId)
        .eq('provider', input.provider)
        .eq('account_id', input.accountId)
        .is('revoked_at', null)
        .limit(1);
      if (selErr) throw selErr;
      const existingId = existing?.[0]?.id;

      if (existingId) {
        const { error } = await db
          .from('member_integrations')
          .update({
            encrypted_tokens: input.ciphertext,
            token_kms_key_id: input.kmsKeyName,
            kek_version: input.kekVersion,
          })
          .eq('id', existingId);
        if (error) throw error;
        return { id: existingId };
      }

      const { data: inserted, error: insErr } = await db
        .from('member_integrations')
        .insert({
          user_id: input.userId,
          org_id: input.orgId,
          provider: input.provider,
          account_id: input.accountId,
          encrypted_tokens: input.ciphertext,
          token_kms_key_id: input.kmsKeyName,
          kek_version: input.kekVersion,
        })
        .select<MemberIntegrationIdRow>('id')
        .limit(1);
      if (insErr) throw insErr;
      const id = inserted?.[0]?.id;
      if (!id) throw new Error('member_integrations insert returned no id');
      return { id };
    },
    async fetchEncryptedRow(input) {
      const { data, error } = await db
        .from('member_integrations')
        .select<MemberIntegrationEncryptedRow>(
          'encrypted_tokens, token_kms_key_id, kek_version',
        )
        .eq('user_id', input.userId)
        .eq('org_id', input.orgId)
        .eq('provider', input.provider)
        .eq('account_id', input.accountId)
        .is('revoked_at', null)
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      if (!row?.encrypted_tokens || !row.token_kms_key_id) return null;
      return {
        ciphertext: Buffer.from(row.encrypted_tokens),
        kmsKeyName: row.token_kms_key_id,
        kekVersion: row.kek_version,
      };
    },
  };
}

export function createIssuerPartnershipsRouter(
  deps: IssuerPartnershipsRouterDeps = {},
): Router {
  const router = Router();
  const db: IssuerPartnershipsDb = deps.db ?? asIssuerPartnershipsDb(defaultDb);

  // ---- GET /api/v1/integrations/issuer-partnerships -----------------------
  router.get('/', async (req: Request, res: Response) => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthorized' } });
      return;
    }

    const orgId = req.query.org_id;
    if (typeof orgId !== 'string' || orgId.length === 0) {
      res
        .status(400)
        .json({ error: { code: 'org_id_required' } });
      return;
    }

    try {
      const ok = await isOrgAdmin(db, userId, orgId);
      if (!ok) {
        res.status(403).json({ error: { code: 'forbidden' } });
        return;
      }
      const { data, error } = await db
        .from('member_integrations')
        .select<MemberIntegrationListRow>(
          'id, org_id, provider, account_id, account_label, connected_at, revoked_at, kek_version',
        )
        .eq('org_id', orgId)
        .in('provider', [...CREDENTIAL_PROVIDERS])
        .order('connected_at', { ascending: false });
      if (error) throw error;

      const rows = data ?? [];
      const summaries: IssuerPartnershipSummary[] = rows.map((r) => ({
        ...r,
        // Reserved for CSI-05 (Sprint 2). Returned as null until the cron
        // is wired so the UI can render "Never" / "—" deterministically.
        last_sync_at: null,
        credential_count: null,
      }));
      res.status(200).json({ data: summaries });
    } catch (e) {
      logger.error({ error: e }, 'issuer-partnerships list failed');
      res.status(500).json({ error: { code: 'internal' } });
    }
  });

  // ---- POST /api/v1/integrations/issuer-partnerships ----------------------
  router.post('/', async (req: Request, res: Response) => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthorized' } });
      return;
    }

    const parsed = ConnectBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: { code: 'invalid_body', issues: parsed.error.issues } });
      return;
    }
    const body = parsed.data;

    try {
      const ok = await isOrgAdmin(db, userId, body.org_id);
      if (!ok) {
        res.status(403).json({ error: { code: 'forbidden' } });
        return;
      }

      const kms = deps.kms ?? (await createDefaultKmsClient());
      const rowStore = deps.rowStore ?? createDefaultRowStore(db);

      let result: { id: string };
      if (body.provider === 'credly') {
        result = await storeIssuerCredentials(
          {
            userId,
            orgId: body.org_id,
            provider: 'credly',
            accountId: body.account_id,
            credentials: body.credentials,
          },
          { kms, rowStore },
        );
      } else {
        result = await storeApiKeyCredentials(
          {
            userId,
            orgId: body.org_id,
            provider: body.provider,
            accountId: body.account_id,
            credentials: body.credentials,
          },
          { kms, rowStore },
        );
      }

      // Best-effort: store the friendly label on the freshly-upserted row.
      if (body.account_label) {
        try {
          await db
            .from('member_integrations')
            .update({ account_label: body.account_label })
            .eq('id', result.id);
        } catch (e) {
          logger.warn(
            { error: e },
            'issuer-partnerships: account_label update failed',
          );
        }
      }

      res.status(201).json({ data: { id: result.id, provider: body.provider } });
    } catch (e) {
      logger.error({ error: e }, 'issuer-partnerships connect failed');
      res.status(500).json({ error: { code: 'internal' } });
    }
  });

  // ---- DELETE /api/v1/integrations/issuer-partnerships/:rowId -------------
  router.delete('/:rowId', async (req: Request, res: Response) => {
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ error: { code: 'unauthorized' } });
      return;
    }
    const rowId = req.params.rowId;
    if (typeof rowId !== 'string' || !UUID_RE.test(rowId)) {
      res.status(400).json({ error: { code: 'invalid_row_id' } });
      return;
    }

    try {
      // Resolve the row's org_id so we can run the admin check against it.
      const { data, error: selErr } = await db
        .from('member_integrations')
        .select<MemberIntegrationRevokeRow>('id, org_id, provider, revoked_at')
        .eq('id', rowId)
        .limit(1);
      if (selErr) throw selErr;
      const row = data?.[0];
      if (!row) {
        res.status(404).json({ error: { code: 'not_found' } });
        return;
      }
      const ok = await isOrgAdmin(db, userId, row.org_id);
      if (!ok) {
        res.status(403).json({ error: { code: 'forbidden' } });
        return;
      }

      if (row.revoked_at) {
        res.status(200).json({ data: { id: rowId, revoked: true } });
        return;
      }

      const { error: updErr } = await db
        .from('member_integrations')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', rowId);
      if (updErr) throw updErr;

      res.status(200).json({ data: { id: rowId, revoked: true } });
    } catch (e) {
      logger.error({ error: e }, 'issuer-partnerships disconnect failed');
      res.status(500).json({ error: { code: 'internal' } });
    }
  });

  return router;
}
