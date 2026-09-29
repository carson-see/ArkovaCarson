import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scopeSatisfies } from '../../api/apiScopes.js';
import { db } from '../../utils/db.js';

const ZonedDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
const Query = z.object({
  since: ZonedDate.optional(), until: ZonedDate.optional(), tag: z.string().trim().min(1).max(64).optional(),
  tag_scope: z.enum(['user', 'organization']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(2048).optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.tag) !== Boolean(value.tag_scope)) ctx.addIssue({ code: 'custom', message: value.tag ? 'tag_scope_required' : 'tag_required' });
});

type Cursor = { v: 1; snapshot: string; createdAt: string; publicId: string; filterHash: string };
const CursorSchema = z.object({ v: z.literal(1), snapshot: ZonedDate, createdAt: ZonedDate, publicId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), filterHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type AnchorListRow = { public_id: string; status: string; created_at: string; updated_at: string; filename: string; description: string | null };
type ListInput = { orgId: string; userId: string; since: string | null; until: string | null; tag: string | null; tagScope: 'user' | 'organization' | null; limit: number; cursor: Cursor | null };
export interface AnchorListDeps {
  revalidateCaller(input: { keyId: string; orgId: string; userId: string }): Promise<{ orgId: string; userId: string } | null>;
  list(input: ListInput): Promise<{ anchors: AnchorListRow[]; next_cursor: string | null }>;
}

function iso(value: string): string | null { const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function decodeCursor(value: string): Cursor | null {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    const snapshot = iso(parsed.snapshot);
    const createdAt = iso(parsed.createdAt);
    if (!snapshot || !createdAt || createdAt > snapshot) return null;
    return { ...parsed, snapshot, createdAt };
  } catch { return null; }
}
function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function filterHash(since: string | null, until: string | null, tag: string | null, tagScope: 'user' | 'organization' | null): string {
  return createHash('sha256').update(JSON.stringify({ since, until, tag, tagScope })).digest('hex');
}

export const defaultAnchorListDeps: AnchorListDeps = {
  async revalidateCaller(input) {
    const { data: key, error } = await db.from('api_keys').select('id,org_id,created_by,is_active,revoked_at,expires_at,scopes')
      .eq('id', input.keyId).eq('org_id', input.orgId).eq('created_by', input.userId).maybeSingle();
    if (error || !key || !key.is_active || key.revoked_at || (key.expires_at && new Date(key.expires_at) <= new Date())
      || !scopeSatisfies(Array.isArray(key.scopes) ? key.scopes : [], 'read:records')) return null;
    const { data: profile, error: profileError } = await db.from('profiles').select('org_id').eq('id', input.userId).maybeSingle();
    if (profileError || !profile) return null;
    if (profile.org_id !== input.orgId) {
      const { data: membership, error: membershipError } = await db.from('org_members').select('id').eq('user_id', input.userId).eq('org_id', input.orgId).maybeSingle();
      if (membershipError || !membership) return null;
    }
    return { orgId: input.orgId, userId: input.userId };
  },
  async list(input) {
    const snapshot = input.cursor?.snapshot ?? new Date().toISOString();
    const selection = 'public_id,status,created_at,updated_at,filename,description';
    let query = input.tag
      ? db.from('anchors').select(`${selection},anchor_private_tags!inner(scope,normalized_tag,owner_user_id,org_id)`)
      : db.from('anchors').select(selection);
    query = query.eq('org_id', input.orgId).is('deleted_at', null).is('metadata->>pipeline_source', null).not('public_id', 'is', null).lte('created_at', snapshot)
      .order('created_at', { ascending: false }).order('public_id', { ascending: false }).limit(input.limit + 1);
    if (input.since) query = query.gte('created_at', input.since);
    if (input.until) query = query.lt('created_at', input.until);
    if (input.cursor) query = query.or(`created_at.lt.${input.cursor.createdAt},and(created_at.eq.${input.cursor.createdAt},public_id.lt.${input.cursor.publicId})`);
    if (input.tag && input.tagScope) {
      query = query.eq('anchor_private_tags.scope', input.tagScope).eq('anchor_private_tags.normalized_tag', input.tag);
      query = input.tagScope === 'user'
        ? query.eq('anchor_private_tags.owner_user_id', input.userId).is('anchor_private_tags.org_id', null)
        : query.eq('anchor_private_tags.org_id', input.orgId);
    }
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as AnchorListRow[];
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      anchors: page.map(({ public_id, status, created_at, updated_at, filename, description }) => ({ public_id, status, created_at, updated_at, filename, description })),
      next_cursor: rows.length > input.limit && last ? encodeCursor({ v: 1, snapshot, createdAt: last.created_at, publicId: last.public_id, filterHash: filterHash(input.since, input.until, input.tag, input.tagScope) }) : null,
    };
  },
};

export function createAnchorListRouter(deps: AnchorListDeps = defaultAnchorListDeps): Router {
  const router = Router();
  router.get('/', async (req: Request, res: Response) => {
    if (!req.apiKey) return res.status(401).json({ error: 'authentication_required' });
    if (!scopeSatisfies(req.apiKey.scopes ?? [], 'read:records')) return res.status(403).json({ error: 'insufficient_scope', required: 'read:records' });
    if (!req.apiKey.orgId) return res.status(403).json({ error: 'organization_required' });
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      const custom = parsed.error.issues.find((issue) => issue.code === 'custom')?.message;
      const dateIssue = parsed.error.issues.some((issue) => issue.path[0] === 'since' || issue.path[0] === 'until');
      return res.status(400).json({ error: custom ?? (dateIssue ? 'invalid_date_interval' : 'invalid_anchor_list_query') });
    }
    const since = parsed.data.since ? iso(parsed.data.since) : null;
    const until = parsed.data.until ? iso(parsed.data.until) : null;
    if ((parsed.data.since && !since) || (parsed.data.until && !until) || (since && until && since >= until)) return res.status(400).json({ error: 'invalid_date_interval' });
    const tag = parsed.data.tag?.trim().toLocaleLowerCase() ?? null;
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) return res.status(400).json({ error: 'invalid_cursor' });
    const tagScope = parsed.data.tag_scope ?? null;
    if (cursor && cursor.filterHash !== filterHash(since, until, tag, tagScope)) return res.status(400).json({ error: 'cursor_filter_mismatch' });
    try {
      const caller = await deps.revalidateCaller({ keyId: req.apiKey.keyId, orgId: req.apiKey.orgId, userId: req.apiKey.userId });
      if (!caller) return res.status(403).json({ error: 'organization_access_denied' });
      return res.json(await deps.list({ ...caller, since, until, tag, tagScope, limit: parsed.data.limit, cursor }));
    }
    catch { return res.status(503).json({ error: 'anchor_list_unavailable' }); }
  });
  return router;
}

export const anchorListRouter = createAnchorListRouter();
