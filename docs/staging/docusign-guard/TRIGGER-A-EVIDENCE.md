# Trigger A (size-based) — fired 2026-09-03T11:28:02.556596Z

## Direct log evidence (unlike Trigger B, A logs explicitly)
Rig `arkova-worker-docusign-guard-staging` rev 00003-hwq:
  11:28:02.556596  Batch size trigger fired          <-- triggerA_shouldFireOnSize
  11:28:07.333323  Claimed anchors for batch processing
  11:28:43.917847  Batch anchor processing complete

## Conditions
pendingCount 10,106 >= BATCH_SIZE (10,000), seeded as service_role across both
orgs. No age requirement for A. Forced flush still held
(flush = {"skipped":"held-for-trigger-exercise"}), so this was NOT Trigger D.

## Result
PENDING 10,106 -> 108; SUBMITTED 12,375; SECURED 2,126. No claim timeout in this
run (contrast the 4,064-pending run at 11:01:13, which timed out on its second
1,000-row chunk).
