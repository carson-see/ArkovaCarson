# UAT-04 mandatory MFA rollout

This rollout requires the application, worker, edge, migration, and hosted Auth
configuration to move together. Migration `0451` contains the reversible
database changes and the full rollback SQL.

## Apply

1. Confirm hosted TOTP enrollment and verification are enabled. Deploy the web
   application first: it gives existing AAL1 users the enrollment/challenge path
   and requires a signed AAL2 token before product content. Verify that flow
   before tightening server authorization.
2. In one coordinated change window, deploy worker and edge builds that reject
   human AAL1 bearer tokens, then apply migration
   `0451_uat04_mandatory_mfa.sql`. Keep machine API-key, webhook, and service
   OIDC authentication on their separate paths.
3. Configure hosted Auth with this exact custom access-token hook and verify the
   values with `GET /v1/projects/$PROJECT_REF/config/auth`:

   ```json
   {
     "hook_custom_access_token_enabled": true,
     "hook_custom_access_token_uri": "pg-functions://postgres/private/oauth_email_confirmation_token_hook"
   }
   ```

4. After the hook is verified, activate new OAuth mailbox enrollment with server
   time. Do not backdate the cohort:

   ```sql
   BEGIN;
   UPDATE private.oauth_email_confirmation_policy
   SET enabled_at = clock_timestamp()
   WHERE singleton AND enabled_at IS NULL
   RETURNING enabled_at;
   COMMIT;
   ```

5. Repeat the web enrollment/challenge and direct worker, edge, PostgREST, RPC,
   and Storage controls after the coupled server/database/Auth activation.

## Acceptance

- A newly created OAuth user remains `arkova_email_pending` at AAL1 and AAL2
  until mailbox proof, then becomes `arkova_mfa_pending` at AAL1.
- Individual, organization member, organization admin, and platform admin users
  all enroll or challenge before onboarding and protected routes.
- The admitted staging schema must have its `auth.users` profile-creation
  trigger installed. Run a real signup and prove its profile is created before
  using the onboarding positive control. Production uses
  `on_auth_user_created` to call `public.create_profile_for_new_user()` and
  `zz_auth_user_auto_associate_org` after insert or verified-email updates;
  staging must mirror those current functions and trigger order. The local
  baseline does not attach the profile trigger, so a manually inserted profile
  is not release evidence for this step.
- Old signed `authenticated`/AAL1 JWTs fail on PostgREST RPC/table access,
  private Storage, worker bearer auth, edge bearer auth, and hosted MCP bearer
  auth. Matching AAL2 tokens succeed subject to their normal tenant policies.
- Production currently publishes no application tables through Postgres
  Changes. Before enabling a publication, stage a representative protected
  table and prove an AAL1 subscription receives no event while AAL2 receives the
  positive control. Every future RLS table or publication must add the same
  restrictive `mfa_verified_authenticated` policy in its creating migration.
- API-key and service-role positive controls still succeed; anonymous public
  reads remain limited to their existing policies.

## Rollback

Set `oauth_email_confirmation_policy.enabled_at` to `NULL`, restore the
email-only hook, and run the rollback block at the bottom of migration `0451`.
Keep the hosted custom hook enabled so existing pending mailboxes cannot refresh
into `authenticated`. Keep worker/edge AAL2 checks until all old human JWTs have
expired, then remove the unused pending role in a later migration.
