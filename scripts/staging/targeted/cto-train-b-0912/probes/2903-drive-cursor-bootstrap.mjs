// PR #2903 — Drive null-cursor bootstrap on successful subscription renewal
// (BUG 2026-09-13, branch fix/drive-page-token-bootstrap, head a193a4f74).
//
// WHAT THIS PR CHANGED, AND THE EXACT INVARIANT THIS MODULE DRAWS.
//
// `services/worker/src/integrations/connectors/drive-subscription-renewal.ts`
// (`renewDriveSubscriptions` / `processOne`) already never overwrites a
// POPULATED `org_integrations.last_page_token` — that discipline predates
// this PR and is the reason a live changes-feed cursor can never be reset by
// a routine channel-rotation sweep. What was missing (BUG 2026-09-13) was the
// other half: a NULL/empty cursor was ALSO never touched, which stranded
// every connection that was never bootstrapped (every row created before
// migration 0288, and the one real prod Arkova row — churning its channel
// hourly with zero failures, Google delivering notifications the whole time,
// and not one Drive artifact ever produced, because `drive-changes-runner.ts`
// skips a null-cursor connection outright and named THIS module as the
// intended recovery path).
//
// The fix: on a SUCCESSFUL renewal (`createChannel` returns and the new
// channel is persisted) — and ONLY when `conn.last_page_token` was
// null/empty AND the new watch's `createChangesWatch` call returned a
// non-empty `startPageToken` — `processOne` folds `last_page_token` +
// `last_token_advanced_at` into the SAME `updateConnection` write as the
// channel swap (`res = await args.db.updateConnection({ ..., ...(bootstrapToken
// ? { last_page_token: bootstrapToken, last_token_advanced_at: now.toISOString() }
// : {}) })`), so the cursor and the channel that feeds it can never disagree.
// A cursor that is already POPULATED is still never included in that update
// at all — the key stays ABSENT on every other code path (the success/no-token
// branch, both `recordSetback` branches for `token_revoked` and
// `renewal_failed`), not merely re-sent unchanged. That absence, not a
// conditional no-op, is what makes a live cursor unreachable by this sweep.
//
// WHAT THIS RIG CAN AND CANNOT PROVE, stated before the probes so the
// evidence is not read as more than it is.
//
// This rig runs `USE_MOCKS=true` and holds no Google credential (SCRUM-5082
// — the same gap #2846's probe module documents). That matters here more
// than usual: `integrations/oauth/drive.ts`'s `createChangesWatch` has no
// `USE_MOCKS` branch of its own — every call site (this PR's production
// wiring in `jobs/drive-subscription-renewal-deps.ts`'s
// `makeDriveSubscriptionRenewalClient`, constructed with no `fetchImpl`
// override from the real `/jobs/drive-subscription-renewal` route) resolves
// `fetchImpl` to the real global `fetch` and calls Google's Drive API for
// real. So there is no "mock path" for this sweep at all on a live worker —
// only a real Google call or no call. And the deciding gate sits BEFORE any
// network call: `makeDriveSubscriptionRenewalClient().getAccessToken` reads
// `if (!raw.encrypted_tokens || !raw.token_kms_key_id) return { accessToken:
// null, revoked: true }` — a connection seeded with no KMS-encrypted token
// short-circuits straight to the `token_revoked` degrade branch, and
// `createChannel` (therefore `startPageToken`, therefore the bootstrap write
// this PR added) is NEVER REACHED. That is a structural property of this PR's
// production wiring, not a flake: it is deterministic and reproducible every
// cycle, and it is why this module seeds both fixture connections with
// `encrypted_tokens: null, token_kms_key_id: null` rather than fabricating
// KMS bytes that would either throw from a bogus key id (non-deterministic
// timing against a real KMS call) or, if somehow decryptable, attempt a real
// OAuth refresh this rig cannot complete either.
//
// CAN prove here, every cycle, with a live worker call and a DB read-back:
//   (1) THE INVARIANT — a populated cursor (fixture B) is byte-identical
//       before and after a real sweep pass touches its row for an unrelated
//       reason (channel-rotation bookkeeping on the degrade path). This is
//       the strongest form of the claim: it is proven on the FAILURE path,
//       where the `updateConnection` payload has no chance to carry the key
//       by construction (`recordSetback`'s payload literal lists exactly
//       `subscription_id, subscription_expires_at, account_label,
//       last_renewal_error, last_renewal_at, watch_renewal_failure_count` —
//       `last_page_token` is not one of them), which is a strictly easier bar
//       than "the success branch's conditional spread also excludes it" but
//       is the bar this rig can actually clear.
//   (2) Fixture A's null cursor is NOT spuriously bootstrapped by the
//       `token_revoked` degrade path — it stays exactly null, every cycle,
//       through the same absent-key mechanism as (1).
//   (3) The due predicate (`subscription_expires_at.lte.horizon OR
//       subscription_id.is.null`, `provider=google_drive`, `revoked_at IS
//       NULL`) actually selects both fixtures every cycle — proven by
//       `last_renewal_at` moving, not by trusting the response body alone.
//   (4) The response's `degraded` counter reflects the branch actually taken.
//
// CANNOT prove here: the bootstrap write itself
// (`success_bootstrapped` / `success_no_token` below) — that needs
// `createChannel` to actually run, which needs a live Google OAuth grant.
// Per the CTO review's own instruction on #2846 ("cover only what is real —
// do not fake it"), this module does not synthesize KMS-encrypted tokens to
// force that branch. `drive-subscription-renewal-deps.test.ts` pins the
// bootstrap write itself (unit level, injected fakes); this module proves the
// one thing a credential-less rig can prove about it: the invariant that
// makes the fix safe, exercised on every cycle of the soak, against the real
// deployed route.
//
// `run()` still detects and reports whichever case the deployed head
// actually produces (success/bootstrapped, success/no-token, revoked,
// other-failure) rather than hard-coding the expectation, in case a future
// rig gains a real credential — but on THIS rig `revoked_no_credential` is
// the only reachable case, deterministically, every cycle.

export const pr = '#2903';

export const changedBehavior = [
  'Proven here, every cycle: (1) THE INVARIANT — fixture B, seeded with a',
  "populated last_page_token ('cto-train-b-0912-2903-live-cursor'), is",
  'byte-identical and last_token_advanced_at is unchanged after a real sweep',
  'pass touches its row (the updateConnection payload on every non-bootstrap',
  'code path — success-without-token AND both degrade/failure branches —',
  'structurally omits the last_page_token key, never re-sends it unchanged).',
  '(2) Fixture A, re-armed to a NULL cursor at the top of every cycle, is NOT',
  'spuriously populated by a degrade-path renewal. (3) The due predicate',
  '(subscription_expires_at in the past OR subscription_id null, provider',
  'google_drive, revoked_at null) actually selects both fixtures every cycle,',
  'proven by last_renewal_at moving, not by trusting the response alone.',
  '(4) The /jobs/drive-subscription-renewal response degraded counter',
  'reflects the branch actually taken.',
  'NOT proven here: the bootstrap write itself (last_page_token +',
  'last_token_advanced_at landing in the SAME updateConnection call as a',
  'successful channel swap, same `now`). This rig runs USE_MOCKS=true with no',
  'Google credential (SCRUM-5082) and createChangesWatch has no mock branch —',
  'every call site resolves to the real fetch — so getAccessToken short-',
  "circuits on the fixtures' absent encrypted_tokens/token_kms_key_id to the",
  'token_revoked degrade branch BEFORE createChannel is ever reached. That is',
  'deterministic on this rig, not a flake: the observed case is detected and',
  "recorded every cycle (2903_a_observed_case_recorded) and is",
  "'revoked_no_credential' on every run this train has access to. The",
  'bootstrap write is pinned at unit level in',
  'drive-subscription-renewal-deps.test.ts; this module proves the invariant',
  'that makes it safe, against the real deployed route, not the write itself.',
].join(' ');

const NAME_PREFIX = 'cto-train-b-0912-2903';
const LIVE_CURSOR = `${NAME_PREFIX}-live-cursor`;
// `.lte.horizon` has no lower bound, so a fixed PAST expiry stays "due for
// renewal" on every cycle of a multi-day soak without ever needing to be
// reset — only last_page_token needs re-arming each cycle (see run()).
const EXPIRED_SUBSCRIPTION_AT = '2026-01-01T00:00:00.000Z';
const ADVANCED_AT_FIXTURE = '2026-01-01T00:00:00.000Z';
const REVOKED_REASON = 'oauth grant revoked — reconnect required';

/** One org_integrations row per fixture, looked up by (org_id, provider, account_id) — idempotent re-run. */
async function ensureConnection(admin, { orgId, accountId, lastPageToken, lastTokenAdvancedAt }) {
  const { data: existing, error: findErr } = await admin
    .from('org_integrations')
    .select('id')
    .eq('org_id', orgId)
    .eq('provider', 'google_drive')
    .eq('account_id', accountId)
    .maybeSingle();
  if (findErr) throw new Error(`#2903 lookup ${accountId}: ${findErr.message}`);
  if (existing) return { id: existing.id };

  const { data, error } = await admin
    .from('org_integrations')
    .insert({
      org_id: orgId,
      provider: 'google_drive',
      account_id: accountId,
      account_label: null,
      // Deliberately absent: this is what forces the deterministic
      // token_revoked degrade branch on a credential-less rig — see the
      // module doc comment above. A real connected row always carries both.
      encrypted_tokens: null,
      token_kms_key_id: null,
      subscription_id: `${accountId}-channel`,
      subscription_expires_at: EXPIRED_SUBSCRIPTION_AT,
      last_page_token: lastPageToken,
      last_token_advanced_at: lastTokenAdvancedAt,
      watch_renewal_failure_count: 0,
      revoked_at: null,
    })
    .select('id')
    .single();
  if (error) throw new Error(`#2903 insert ${accountId}: ${error.message}`);
  return { id: data.id };
}

export async function seed(admin, state) {
  const orgId = state.orgA;
  const connectionA = await ensureConnection(admin, {
    orgId, accountId: `${NAME_PREFIX}-a`, lastPageToken: null, lastTokenAdvancedAt: null,
  });
  const connectionB = await ensureConnection(admin, {
    orgId, accountId: `${NAME_PREFIX}-b`, lastPageToken: LIVE_CURSOR, lastTokenAdvancedAt: ADVANCED_AT_FIXTURE,
  });
  return { connectionA, connectionB, liveCursor: LIVE_CURSOR };
}

async function readRow(admin, id) {
  return admin.from('org_integrations').select('*').eq('id', id).maybeSingle();
}

export async function run(ctx) {
  const { admin, state, probe, workerFetch, env } = ctx;
  const s = state['#2903'] ?? {};
  const out = [];

  if (!s.connectionA?.id || !s.connectionB?.id || !s.liveCursor) {
    out.push(probe('2903_fixtures_seeded', true, false, {
      pass: false,
      detail: { reason: 'no #2903 fixture state — run setup.mjs', have: Object.keys(s) },
    }));
    return out;
  }

  // ── Re-arm A's cursor to NULL at the top of EVERY cycle — item 4: the
  // bootstrap precondition (cursor unset) must be exercised every cycle, not
  // proven once at setup and then left populated by whatever the prior
  // cycle's sweep did (or, on this rig, left untouched by the degrade path
  // that never writes it either way — re-arming still keeps the fixture
  // honest against a future rig that DOES have a credential). ─────────────
  const { error: rearmErr } = await admin
    .from('org_integrations')
    .update({ last_page_token: null, last_token_advanced_at: null })
    .eq('id', s.connectionA.id);
  out.push(probe('2903_a_rearmed', true, !rearmErr, { detail: rearmErr?.message ?? null }));

  const [beforeARes, beforeBRes] = await Promise.all([
    readRow(admin, s.connectionA.id),
    readRow(admin, s.connectionB.id),
  ]);
  const beforeA = beforeARes.data;
  const beforeB = beforeBRes.data;
  out.push(probe('2903_before_snapshot_readable', true, Boolean(beforeA) && Boolean(beforeB), {
    detail: { aErr: beforeARes.error?.message ?? null, bErr: beforeBRes.error?.message ?? null },
  }));
  if (!beforeA || !beforeB) return out;

  out.push(probe('2903_a_rearmed_cursor_is_null', true, beforeA.last_page_token === null, {
    detail: { present: Object.hasOwn(beforeA, 'last_page_token') },
  }));
  out.push(probe('2903_b_starts_with_seeded_cursor', true, beforeB.last_page_token === s.liveCursor, {
    detail: { match: beforeB.last_page_token === s.liveCursor, actualLength: beforeB.last_page_token?.length ?? null },
  }));

  const cronSecret = env.CRON_SECRET ?? '';
  const trigger = () => workerFetch('/jobs/drive-subscription-renewal', {
    method: 'POST',
    headers: cronSecret ? { 'X-Cron-Secret': cronSecret } : {},
  });

  let sweep = await trigger();
  out.push(probe('2903_sweep_cron_authenticated', true, sweep.status !== 401 && sweep.status !== 403, {
    detail: { status: sweep.status, cronSecretPresent: Boolean(cronSecret) },
  }));
  let retried = false;
  if (sweep.body?.skipped === true) {
    // The cross-instance run lease (jobs/run-lease.ts's
    // DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE) was already held by the OTHER
    // trigger this route shares with routes/scheduled.ts's hourly in-process
    // backup — both call the same lease-guarded runDriveSubscriptionRenewal().
    // A skip must be a pure no-op (EMPTY_RENEWAL_SUMMARY); wait for the
    // holder to finish and call once more rather than asserting against a
    // response that did nothing. The DB read-back below is authoritative
    // either way — if the concurrent holder's pass reached our fixtures
    // between attempts, last_renewal_at will show it.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    retried = true;
    sweep = await trigger();
  }
  out.push(probe('2903_sweep_200', 200, sweep.status, { detail: { error: sweep.body?.error, retried, skipped: sweep.body?.skipped ?? false } }));

  const [afterARes, afterBRes] = await Promise.all([
    readRow(admin, s.connectionA.id),
    readRow(admin, s.connectionB.id),
  ]);
  const afterA = afterARes.data;
  const afterB = afterBRes.data;
  out.push(probe('2903_after_snapshot_readable', true, Boolean(afterA) && Boolean(afterB), {
    detail: { aErr: afterARes.error?.message ?? null, bErr: afterBRes.error?.message ?? null },
  }));
  if (!afterA || !afterB) return out;

  // ── (1) THE INVARIANT — provable on any rig, no Google credential needed.
  // Never printed as raw values beyond a boolean/length match. ─────────────
  out.push(probe('2903_b_cursor_byte_identical', true, afterB.last_page_token === s.liveCursor, {
    detail: {
      match: afterB.last_page_token === s.liveCursor,
      expectedLength: s.liveCursor.length,
      actualLength: afterB.last_page_token?.length ?? null,
    },
  }));
  out.push(probe('2903_b_advanced_at_unchanged', beforeB.last_token_advanced_at, afterB.last_token_advanced_at, {
    detail: 'A populated cursor is never in the updateConnection payload on any code path — see the module doc comment.',
  }));

  // ── Was A actually processed this cycle? The due predicate has no lower
  // bound, so a past subscription_expires_at is due on every cycle; the only
  // reason this would NOT move is lease contention the retry above already
  // absorbs once. ───────────────────────────────────────────────────────────
  const aProcessed = afterA.last_renewal_at !== beforeA.last_renewal_at;
  out.push(probe('2903_a_processed_this_cycle', true, aProcessed, {
    detail: {
      beforeLastRenewalAt: beforeA.last_renewal_at,
      afterLastRenewalAt: afterA.last_renewal_at,
      sweepSkippedBothAttempts: sweep.body?.skipped === true,
    },
  }));
  if (!aProcessed) return out;

  const bootstrapped = afterA.last_page_token != null;
  const success = afterA.last_renewal_error === null;
  const revokedCase = afterA.last_renewal_error === REVOKED_REASON;

  let observedCase;
  if (success && bootstrapped) observedCase = 'success_bootstrapped';
  else if (success && !bootstrapped) observedCase = 'success_no_token';
  else if (revokedCase) observedCase = 'revoked_no_credential';
  else observedCase = 'failed_other';

  out.push(probe('2903_a_observed_case_recorded', true, true, {
    detail: {
      observedCase,
      note: 'No Google credential exists on this rig (SCRUM-5082) — getAccessToken short-circuits on the absent encrypted_tokens/token_kms_key_id BEFORE any network call, so createChannel (and therefore the bootstrap write this PR added) is structurally unreachable here. revoked_no_credential is the deterministic case this rig proves every cycle; the two success_* cases require a real Google-connected rig.',
    },
  }));

  if (observedCase === 'success_bootstrapped') {
    out.push(probe('2903_a_bootstrap_token_present_non_null', true, afterA.last_page_token != null, {
      detail: { length: afterA.last_page_token?.length ?? null },
    }));
    out.push(probe('2903_a_advanced_at_matches_renewal_at', afterA.last_renewal_at, afterA.last_token_advanced_at, {
      detail: 'Same `now` in the same updateConnection call — the exact write BUG 2026-09-13 added.',
    }));
  } else if (observedCase === 'success_no_token') {
    out.push(probe('2903_a_stays_null_no_token_returned', true, afterA.last_page_token === null, {
      detail: { last_renewal_error: afterA.last_renewal_error, last_renewal_at: afterA.last_renewal_at },
    }));
  } else {
    // revoked_no_credential (expected, deterministic on this rig) or
    // failed_other: the row degraded/failed before createChannel — the
    // bootstrap write was never attempted, and the cursor must still read
    // null because the key was never in this write's payload either.
    out.push(probe('2903_a_stays_null_degrade_or_fail_path', true, afterA.last_page_token === null, {
      detail: {
        observedCase,
        last_renewal_error: afterA.last_renewal_error,
        watch_renewal_failure_count: afterA.watch_renewal_failure_count,
      },
    }));
    if (observedCase === 'revoked_no_credential') {
      out.push(probe('2903_a_revoked_reason_matches_no_credential_path', REVOKED_REASON, afterA.last_renewal_error));
    }
  }

  // ── (3)/(4) sweep response counts — only meaningful when THIS call did the
  // work; a skipped response's counters are structurally zero. ─────────────
  if (sweep.body?.skipped !== true) {
    out.push(probe('2903_sweep_scanned_covers_fixtures', true, (sweep.body?.scanned ?? 0) >= 2, {
      detail: { scanned: sweep.body?.scanned },
    }));
    const summaryField = observedCase === 'revoked_no_credential' ? 'degraded' : (success ? 'renewed' : 'failed');
    out.push(probe(`2903_sweep_response_counts_${summaryField}`, true, (sweep.body?.[summaryField] ?? 0) >= 1, {
      detail: { field: summaryField, value: sweep.body?.[summaryField], observedCase, fullSummary: { scanned: sweep.body?.scanned, renewed: sweep.body?.renewed, degraded: sweep.body?.degraded, failed: sweep.body?.failed } },
    }));
  }

  return out;
}
