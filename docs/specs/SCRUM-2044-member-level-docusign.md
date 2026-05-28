# SCRUM-2044 — Member-Level DocuSign Integration (Design Spec)

_Sprint 2 deliverable: spec only. Implementation deferred to Sprint 3+._

## Problem

Today, DocuSign integration is org-level only — one DocuSign account per
organization. This means:

1. Personal DocuSign accounts cannot be linked to an org for document routing.
2. If an org member receives a completed envelope on their personal account,
   Arkova has no way to ingest it.
3. Orgs where multiple members each have DocuSign accounts cannot capture all
   completed-envelope events.

## Goal

Allow org members to link their personal DocuSign accounts alongside (or
instead of) the org-level connection. Completed-envelope webhooks from
member-level accounts route to both the member's personal queue and the
org-level rules engine.

## Design

### Schema Changes

#### New table: `member_integrations`

```sql
CREATE TABLE public.member_integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider = 'docusign'),
  account_id      text NOT NULL,
  account_label   text,
  base_uri        text,
  encrypted_tokens bytea,
  token_kms_key_id text,
  token_secret_name text,
  scope           text,
  hmac_keys       jsonb,
  connected_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_integrations_unique_active
    UNIQUE NULLS NOT DISTINCT (user_id, org_id, provider, account_id)
    WHERE (revoked_at IS NULL)
);

ALTER TABLE public.member_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_integrations FORCE ROW LEVEL SECURITY;
```

RLS policies:
- Members can SELECT their own rows (`user_id = auth.uid()`).
- Org admins can SELECT all rows in their org.
- INSERT/UPDATE/DELETE via service_role only (OAuth callback writes).

#### Changes to `org_integrations`

None. Org-level integrations remain untouched. The webhook handler routes to
both tables.

### Webhook Handler Changes

The `findIntegration()` function in `docusign.ts` currently queries only
`org_integrations`. With member-level support:

1. **First**: query `org_integrations` by `account_id` (existing behavior).
2. **If no org-level match**: query `member_integrations` by `account_id`.
3. **If member-level match found**: route the event to both:
   - The org-level rules engine (via `enqueue_rule_event`)
   - A new member-level notification queue (TBD: could be the same job queue
     with a `routing: 'member'` flag, or a separate Supabase Realtime channel)

If both an org-level and member-level integration exist for the same
`account_id`, the org-level integration takes precedence (the member-level
row is treated as a personal overlay, not a replacement).

### OAuth Flow

New endpoints:
- `POST /api/v1/integrations/docusign/member/oauth/start` — initiates
  member-level OAuth. Requires authenticated user + org membership (any role).
- `GET /api/v1/integrations/docusign/member/oauth/callback` — handles the
  redirect. Stores tokens in `member_integrations`.
- `POST /api/v1/integrations/docusign/member/disconnect` — revokes the
  member's personal connection.

State parameter includes `{ userId, orgId, scope: 'member' }` to
disambiguate from org-level flow on callback.

### Connect Listener Provisioning

Each member-level connection provisions its own Connect listener on the
member's DocuSign account (same `provisionConnectListener()` logic). The
webhook URL is the same `/webhooks/docusign` endpoint — routing is handled by
`account_id` lookup, not by URL path.

HMAC keys for member-level integrations follow the same dual-key rotation
model (SCRUM-2043): `hmac_keys` JSONB on `member_integrations`.

### Dual-Routing Architecture

```
DocuSign Connect webhook
  │
  ├─ findIntegration(accountId)
  │   ├─ org_integrations match? → org-level routing (existing)
  │   └─ member_integrations match? → dual routing:
  │       ├─ Org rules engine (ESIGN_COMPLETED with routing='member')
  │       └─ Member notification (Realtime broadcast or notification queue)
  │
  └─ HMAC verification uses keys from whichever table matched
```

### HMAC Key Resolution (Updated)

With member-level integrations, `resolveHmacKeys()` receives keys from
whichever integration row matched:
- Org-level match → `org_integrations.hmac_keys` → env var fallback
- Member-level match → `member_integrations.hmac_keys` → env var fallback

### Nonce Deduplication

The existing `docusign_webhook_nonces` table works for both org-level and
member-level events (keyed on `envelope_id` + `event_id`). No schema change
needed.

### Reconciliation (SCRUM-2042 Extension)

The reconciliation cron must be extended to also check `member_integrations`
for active DocuSign connections. Token keep-alive applies to member-level
tokens too.

### Audit Trail

All member-level connection/disconnection events must be written to
`audit_events` with `event_category: 'SECURITY'`:
- `integration.docusign_member_connected`
- `integration.docusign_member_disconnected`
- `actor_id` = the member's `user_id`
- `org_id` = the org context

### Security Considerations

1. **Cross-tenant isolation**: A member-level integration is scoped to
   `(user_id, org_id)`. If the same user belongs to multiple orgs, they can
   have separate DocuSign connections per org.
2. **Ambiguous account_id**: If the same DocuSign `account_id` appears in
   both `org_integrations` and `member_integrations`, org-level wins. If it
   appears in `member_integrations` for multiple orgs, the handler must reject
   (same fail-closed logic as the current ambiguous lookup).
3. **Token isolation**: Member-level refresh tokens go to their own Secret
   Manager secrets (naming: `arkova-docusign-member-{userId}-{accountHash}-refresh-token`).
4. **RLS**: Members can only see their own integration rows. Org admins can
   see all member integrations in their org (for troubleshooting).

### Migration Plan

1. **Sprint 3**: Create `member_integrations` table + RLS + member OAuth
   endpoints.
2. **Sprint 3**: Extend webhook handler `findIntegration()` to check both
   tables.
3. **Sprint 4**: Extend reconciliation cron to cover member integrations.
4. **Sprint 4**: UI for member-level DocuSign connection in org settings.

### Open Questions

1. **Notification delivery for member-level events**: Supabase Realtime
   broadcast vs. job queue with member routing flag? Realtime is simpler
   but requires the member to have an active browser session.
2. **Member self-service key rotation**: Should members be able to rotate
   their own HMAC keys, or is that admin-only?
3. **Quota implications**: Each member-level connection provisions a
   separate Connect listener. DocuSign accounts have a limit on Connect
   configurations (varies by plan). Should we warn when approaching limits?
