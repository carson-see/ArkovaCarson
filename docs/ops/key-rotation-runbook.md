# Key Rotation Runbook

> **Version:** 2026-04-03 | **Classification:** CONFIDENTIAL
> **Reference:** CLAUDE.md Section 7 (Environment Variables)

This runbook covers step-by-step procedures for rotating all secrets used by the Arkova platform. Never include actual secret values in this document or in logs.

---

## General Principles

1. **Never rotate in place.** Always generate the new key first, verify it works, then revoke the old key.
2. **Coordinate timing.** Rotate during low-traffic windows (recommended: Tuesday-Thursday, 06:00-08:00 UTC).
3. **Audit trail.** Log the rotation event (who, when, which key) in the team's incident/ops log.
4. **Two-person rule.** Critical rotations (Bitcoin Treasury WIF, Supabase Service Role Key) require a second engineer to verify.

---

## 1. Stripe API Keys

**Env vars:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
**Location:** Cloud Run (worker service)

### Pre-Rotation Checklist

- [ ] Confirm current webhook delivery is healthy (Stripe Dashboard > Webhooks)
- [ ] Identify all services consuming the Stripe key (worker only per Constitution 1.4)
- [ ] Schedule rotation window

### Procedure

1. **Generate new restricted key**
   - Stripe Dashboard > Developers > API Keys > Create restricted key
   - Grant the same permissions as the current key (charges, subscriptions, webhooks, customers)
   - Copy the new key (it will not be shown again)

2. **Update Cloud Run environment**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "STRIPE_SECRET_KEY=<new-key>"
   ```

3. **If rotating webhook secret** (only needed if webhook endpoint changes):
   - Stripe Dashboard > Webhooks > Select endpoint > Reveal signing secret
   - Update Cloud Run:
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "STRIPE_WEBHOOK_SECRET=<new-webhook-secret>"
   ```

4. **Verify webhook delivery**
   - Stripe Dashboard > Webhooks > Send test event (e.g., `invoice.payment_succeeded`)
   - Confirm worker logs show successful webhook processing
   - Confirm `stripe.webhooks.constructEvent()` succeeds (no signature mismatch)

5. **Revoke old key**
   - Stripe Dashboard > API Keys > Delete/revoke the previous restricted key
   - Verify no 401 errors in worker logs after revocation

### Rollback

- If the new key fails verification, re-update Cloud Run with the old key before revoking it
- Old key remains valid until explicitly revoked

### Estimated Downtime

**Zero** — Cloud Run performs rolling updates. Brief window (< 30 seconds) during revision swap.

---

## 2. Supabase Service Role Key

**Env vars:** `SUPABASE_SERVICE_ROLE_KEY`
**Location:** Cloud Run (worker service), CI/CD secrets (GitHub Actions)

### Pre-Rotation Checklist

- [ ] Confirm worker health (`/health` returns 200)
- [ ] Identify all consumers: Cloud Run worker, GitHub Actions CI (if used for migrations)
- [ ] Coordinate with team — this rotation briefly disrupts the worker

### Procedure

1. **Regenerate key in Supabase Dashboard**
   - Supabase Dashboard > Project Settings > API > Service Role Key > Regenerate
   - WARNING: This immediately invalidates the old key

2. **Update Cloud Run immediately**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "SUPABASE_SERVICE_ROLE_KEY=<new-service-role-key>"
   ```

3. **Update CI/CD secrets**
   - GitHub > Repository Settings > Secrets > Update `SUPABASE_SERVICE_ROLE_KEY`

4. **Verify worker health**
   ```bash
   curl -s https://<worker-url>/health | jq .
   ```
   - Confirm database connectivity is reported as healthy
   - Confirm anchor processing resumes (check recent anchor status transitions)

5. **Run backup validation script**
   ```bash
   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<new-key> \
     npx tsx services/worker/scripts/backup-validation.ts
   ```

### Rollback

- Supabase does not allow restoring the old service role key after regeneration
- If the update fails mid-rotation, the worker will be down until the new key is applied
- **Mitigation:** Have the Cloud Run update command pre-staged before clicking regenerate

### Estimated Downtime

**< 2 minutes** — Time between Supabase key regeneration and Cloud Run revision deployment. Pre-stage the `gcloud` command to minimize this window.

---

## 3. API_KEY_HMAC_SECRET

**Env var:** `API_KEY_HMAC_SECRET`
**Location:** Cloud Run (worker service)

### Pre-Rotation Checklist

- [ ] CRITICAL: Rotating this secret invalidates ALL existing API key hashes
- [ ] Notify all API consumers of upcoming key re-issuance
- [ ] Schedule migration window with adequate notice (minimum 7 days)
- [ ] Prepare migration script to re-hash existing keys (requires raw keys from consumers)

### Procedure

1. **Generate new HMAC secret**
   ```bash
   openssl rand -hex 32
   ```

2. **Plan the migration** (breaking change)
   - Option A (recommended): Support dual secrets during transition
     - Deploy code change to check HMAC against both old and new secrets
     - Update `API_KEY_HMAC_SECRET` to new value, add `API_KEY_HMAC_SECRET_OLD` temporarily
     - After all consumers re-issue keys, remove dual-secret support
   - Option B (simpler, more disruptive): Rotate and require all consumers to generate new API keys

3. **Update Cloud Run**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "API_KEY_HMAC_SECRET=<new-secret>"
   ```

4. **Verify**
   - Create a new API key via the admin interface
   - Confirm the new key authenticates successfully against the Verification API
   - Confirm old API keys fail (expected — they were hashed with the old secret)

5. **Notify consumers** to regenerate their API keys

### Rollback

- Revert `API_KEY_HMAC_SECRET` to the old value in Cloud Run
- All existing API keys will work again immediately

### Estimated Downtime

**Zero for the platform.** However, all existing API keys become invalid until consumers regenerate them. Plan 7-day notice minimum.

---

## 4. CRON_SECRET

**Env var:** `CRON_SECRET`
**Location:** Cloud Run (worker service), Cloud Scheduler job configs

### Pre-Rotation Checklist

- [ ] List all Cloud Scheduler jobs that use CRON_SECRET for authentication
- [ ] Confirm the jobs and their schedules

### Procedure

1. **Generate new secret**
   ```bash
   openssl rand -hex 16    # minimum 16 characters per CLAUDE.md
   ```

2. **Update Cloud Run**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "CRON_SECRET=<new-cron-secret>"
   ```

3. **Update each Cloud Scheduler job**
   ```bash
   # For each cron job that passes CRON_SECRET as a header or body parameter:
   gcloud scheduler jobs update http <job-name> \
     --location <region> \
     --headers "Authorization=Bearer <new-cron-secret>"
   ```

4. **Verify**
   - Trigger each cron job manually:
   ```bash
   gcloud scheduler jobs run <job-name> --location <region>
   ```
   - Check worker logs for successful execution (no 401/403 errors)

### Rollback

- Revert Cloud Run env var to old secret
- Revert Cloud Scheduler job headers to old secret
- Order matters: update Cloud Run first, then Scheduler (or vice versa depending on which is failing)

### Estimated Downtime

**Zero** — But cron jobs will fail between the Cloud Run update and the Scheduler update. Minimize the gap by running the commands in quick succession.

---

## 5. Bitcoin Treasury WIF

**Env var:** `BITCOIN_TREASURY_WIF`
**Location:** Cloud Run (worker service)

### Pre-Rotation Checklist

- [ ] CRITICAL: The WIF controls real Bitcoin funds. Rotating without transferring funds first means permanent loss of access to the old address
- [ ] Confirm current treasury balance and pending transactions
- [ ] Generate the new keypair in a secure, air-gapped environment
- [ ] Have a second engineer verify the new address
- [ ] Ensure no batch anchoring jobs are in-flight

### Procedure

1. **Pause anchoring**
   - Set `ENABLE_PROD_NETWORK_ANCHORING=false` in Cloud Run to halt new transactions
   - Wait for any in-flight transactions to confirm (check mempool)

2. **Generate new keypair**
   - Use a secure, air-gapped environment
   - Generate new WIF and derive the corresponding Bitcoin address
   - Record the new address securely (password manager, hardware vault)

3. **Transfer all funds from old address to new address**
   ```bash
   # Verify old address balance
   # Create and broadcast transfer transaction moving ALL funds to new address
   # Wait for confirmation (minimum 1 confirmation, recommended 3)
   ```

4. **Verify funds arrived at new address**
   - Check via block explorer or mempool API
   - Confirm balance matches expected amount (minus transaction fee)

5. **Update Cloud Run with new WIF**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "BITCOIN_TREASURY_WIF=<new-wif>"
   ```

6. **Re-enable anchoring**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "ENABLE_PROD_NETWORK_ANCHORING=true"
   ```

7. **Verify**
   - Submit a test anchor and confirm it reaches SECURED status
   - Verify batch anchoring resumes

8. **Securely destroy old WIF**
   - Remove from any temporary storage
   - The old address should have zero balance at this point

### Rollback

- If funds have NOT been transferred yet: simply revert the env var to old WIF
- If funds HAVE been transferred: you must use the new WIF; the old one controls an empty address
- **There is no rollback after funds are transferred and old WIF is destroyed**

### Estimated Downtime

**30-60 minutes** — Anchoring is paused during the transfer and key swap. Existing verification continues to work (read-only). New anchors queue and are processed after re-enabling.

---

## 6. Resend API Key

**Env var:** `RESEND_API_KEY`
**Location:** Cloud Run (worker service)

### Pre-Rotation Checklist

- [ ] Confirm current email delivery is working (check recent sends in Resend dashboard)
- [ ] Verify the sender domain (`EMAIL_FROM`) is still verified

### Procedure

1. **Generate new API key**
   - Resend Dashboard > API Keys > Create API Key
   - Grant "Sending access" permission for the verified domain
   - Copy the new key

2. **Update Cloud Run**
   ```bash
   gcloud run services update arkova-worker \
     --region <region> \
     --update-env-vars "RESEND_API_KEY=<new-resend-key>"
   ```

3. **Verify**
   - Trigger a test email (e.g., password reset flow, or use Resend dashboard test send)
   - Confirm delivery in Resend dashboard logs

4. **Revoke old key**
   - Resend Dashboard > API Keys > Delete the old key
   - Verify no delivery failures in worker logs

### Rollback

- If the new key fails, re-update Cloud Run with the old key before revoking it

### Estimated Downtime

**Zero** — Rolling update. Emails during the ~30-second revision swap may be delayed but will retry.

---

## Rotation Schedule

| Secret | Recommended Frequency | Last Rotated | Next Due |
|--------|-----------------------|-------------|----------|
| Stripe API Keys | Every 90 days | | |
| Supabase Service Role Key | Every 180 days | | |
| API_KEY_HMAC_SECRET | Only on compromise | | |
| CRON_SECRET | Every 90 days | | |
| Bitcoin Treasury WIF | Only on compromise or key migration | | |
| Resend API Key | Every 90 days | | |

---

## Emergency Rotation (Suspected Compromise)

If a key is suspected compromised:

1. **Immediately** rotate the key following the procedure above — skip the scheduling step
2. **Audit** Cloud Run and Supabase logs for unauthorized access during the exposure window
3. **Notify** the team via the incident response channel
4. **Document** the incident in `docs/incidents/` per the incident response plan
5. For Bitcoin Treasury WIF compromise: **transfer funds immediately** before the attacker can
