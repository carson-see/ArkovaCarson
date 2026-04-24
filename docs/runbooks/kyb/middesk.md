# Middesk KYB runbook

**Story:** [SCRUM-1162](https://arkova.atlassian.net/browse/SCRUM-1162)
**Owners:** Platform engineering (Carson)
**Last updated:** 2026-04-24

Middesk is Arkova's Know-Your-Business (KYB) vendor for organization
verification. Individual identity verification is handled separately by
Stripe Identity (IDT-03).

## Quick facts

| | Value |
|---|---|
| Base URL (sandbox) | `https://api-sandbox.middesk.com` |
| Base URL (prod) | `https://api.middesk.com` |
| API docs | <https://docs.middesk.com/> |
| Secret Manager key (API) | `MIDDESK_API_KEY` |
| Secret Manager key (webhook) | `MIDDESK_WEBHOOK_SECRET` |
| Arkova webhook endpoint | `POST /webhooks/middesk` |
| Arkova submit endpoint | `POST /api/v1/org-kyb/:orgId/start` |
| Arkova status endpoint | `GET /api/v1/org-kyb/:orgId/status` |
| Relevant migration | `supabase/migrations/0250_org_kyb.sql` |

## Setup (first-time)

1. Register at <https://www.middesk.com/> (sales team → sandbox access).
2. In the Middesk dashboard → **Settings → API keys**:
   - Copy the sandbox key (`sk_test_*`) and store in GCP Secret Manager as
     `MIDDESK_API_KEY`.
   - Copy the webhook signing secret (`whsec_*`) and store as
     `MIDDESK_WEBHOOK_SECRET`.
3. In the Middesk dashboard → **Settings → Webhooks**:
   - Add a webhook pointing to `https://<arkova-worker>/webhooks/middesk`.
   - Subscribe to `business.updated`, `business.verified`,
     `business.requires_review`, `business.rejected`, `business.failed`.
4. Redeploy Cloud Run so the new env vars land (per
   `memory/feedback_worker_hands_off.md` — Carson runs the deploy).
5. Smoke test:
   ```bash
   curl -X POST https://<arkova-worker>/api/v1/org-kyb/<org-uuid>/start \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <user-jwt>" \
     -d '{ "legal_name": "Arkova Inc", "ein": "123456789",
           "address": { "line1": "1 Market St", "city": "San Francisco",
                        "state": "CA", "postal_code": "94105" } }'
   ```
   - Expect `202 { "ok": true, "reference_id": "biz_..." }`.
   - Middesk will POST `business.updated` within ~30 s; verify
     `kyb_events` has a row for the org.

## Env vars (see `docs/reference/ENV.md`)

| Name | Default | Notes |
|---|---|---|
| `MIDDESK_API_KEY` | _unset_ | Required for `/api/v1/org-kyb/*/start`. Missing → 503. |
| `MIDDESK_WEBHOOK_SECRET` | _unset_ | Required for `/webhooks/middesk`. Missing → 503. |
| `MIDDESK_SANDBOX` | `true` | Set to literal `"false"` to hit prod. Anything else stays sandbox. |

Per the 2026-04-24 decision there is no `ENABLE_ORG_KYB` feature flag —
the routes are always registered. Secret absence is surfaced at the route
layer as 503 so misconfiguration is visible.

## Sandbox → production cutover

1. Verify sandbox against at least 5 real businesses (test with your own EIN
   and a handful of the sample EINs in Middesk's docs).
2. Flip `MIDDESK_SANDBOX` to `"false"` in prod's env.
3. Rotate `MIDDESK_API_KEY` + `MIDDESK_WEBHOOK_SECRET` to the **production**
   values from the Middesk dashboard (different from sandbox).
4. Redeploy worker.
5. Run the smoke test above against a known good business.
6. Add the cutover date to `HANDOFF.md`.

## Webhook signature rotation

1. In the Middesk dashboard, click **Rotate secret** on the webhook.
2. Middesk shows the new secret ONCE — copy it immediately.
3. In Secret Manager, add the new secret as a **new version** of
   `MIDDESK_WEBHOOK_SECRET` (do not disable the old version yet).
4. Redeploy worker. While deployment propagates, Middesk may still send
   events signed with the old secret; Arkova's route will 401 them. That's
   fine — Middesk retries with back-off.
5. After the new version is live, disable the old version in Secret
   Manager.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 503 `kyb_unavailable` | `MIDDESK_API_KEY` not set | Provision the secret + redeploy. |
| 503 `webhook_unconfigured` | `MIDDESK_WEBHOOK_SECRET` not set | Same. |
| 401 `invalid_signature` repeating | Secret rotation out of sync | Re-enable both versions in Secret Manager temporarily. |
| Vendor accepts but Arkova never updates | RPC failure after submit; `warning` in 202 body | Re-submit OR call `start_kyb_verification` RPC manually with the known `reference_id`. |
| `kyb_events` shows `error` status | Unknown event type from Middesk | Check `provider_event_id` in `kyb_events`, look up in Middesk dashboard, extend `mapMiddeskEventToStatus` if new type. |

## PII handling

- EIN + full address flow through to Middesk in clear. **Never log them.**
- `kyb_events.payload_hash` is SHA-256 of the raw webhook bytes only; the
  full payload is never persisted.
- `errorSanitizer` scrubs EIN patterns from Sentry via existing middleware;
  do not override that when adding error handlers.

## References

- Vendor docs: <https://docs.middesk.com/>
- Individual verification (Stripe Identity): `src/components/auth/IdentityVerification.tsx`
- Plan doc: <https://arkova.atlassian.net/wiki/spaces/A/pages/25952257>
- Confluence story page: <https://arkova.atlassian.net/wiki/spaces/A/pages/26443777>
