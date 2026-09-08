# docusign-guard soak — scope note (what this soak does and does NOT prove)

## Correction: the "inbound OAuth regression" is NOT a regression
Earlier in this session I flagged that the inbound declared-hash path now
requires a DocuSign OAuth refresh token, and called it a possible regression.
That was wrong. Verified against PR #2472's branch (head bfd0aaf5b):

  - `ENABLE_DOCUSIGN_INBOUND` does not exist in this branch's config at all.
  - Zero references to `DECLARED_UNVERIFIED`, `_direction`, or `customrecipient`.
  - `processDocusignEnvelopeCompletedJob` unconditionally calls
    `resolveConnection` then `fetchDocusignCombinedDocument` — there is no
    inbound branch to take.

The inbound feature lives in PR #2476 (OPEN, draft, unmerged). The old
bilateral rig produced 280 inbound artifacts because it ran an RC image that
merged #2476 + #2474; this rig runs #2472's branch, which has neither. Nothing
regressed — the feature is simply not present.

Consequence: `ENABLE_DOCUSIGN_INBOUND=true` is set on this rig's Cloud Run
service and is INERT. It is deliberately NOT being removed, because changing
env restarts the container and resets worker uptime, which is the exact signal
this soak depends on. Do not read the rig config as "inbound was soaked."

## What this soak proves (PR #2472, migration 0423)
  - The 0423 write-authority trigger, continuously, all four branches, every
    cycle (`guard == "1111"` or the cycle fails):
      A untrusted + DocuSign claim -> all 8 guarded keys stripped, benign kept
      B untrusted, non-DocuSign     -> account_id/envelope_id PRESERVED
      C service_role                -> keys preserved
      D untrusted UPDATE hijack     -> reverted to OLD
  - Multi-tenant anchor lifecycle under load: two orgs, PENDING -> batched ->
    confirmed, with per-cycle anchor deltas asserted against the DB.
  - Webhook HMAC surface: valid signature 202, bad signature 401, replay 200.
  - Worker uptime continuity (min-instances=1), restarts counted per cycle.

## What it does NOT prove
  - Inbound Recipient-Connect classification or DECLARED_UNVERIFIED (#2476).
  - Outbound signer capture / `_signers` (#2474).
  - The webhook -> connector_artifact -> anchor pipeline end to end. That path
    needs a real DocuSign OAuth token refresh, which an isolated rig cannot
    have. Anchor load is therefore written directly as service_role, exactly as
    the connector drain writes it. The `?customrecipient=true` probes are
    ordinary outbound events here and are HMAC evidence only, not inbound
    evidence.
