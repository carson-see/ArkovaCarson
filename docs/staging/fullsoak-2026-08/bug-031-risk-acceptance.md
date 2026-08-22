# BUG-2026-08-15-031 — risk ruling: mitigated in-window, fix ships post-freeze (CTO)

**Defect.** `utils/verifyCache.ts` (`verify:v5:`) and `middleware/upstashIdempotency.ts` (`idem:`)
share one Upstash database across environments with no environment namespace. A verification result
computed in a non-prod environment can be served to a production caller of the public verify API.

**Ruling (2026-08-15): no freeze exception.** The code fix (in flight as its own T2 change) ships
after the window closes 2026-08-19T15:51:30Z. Rationale + mitigation:

1. **The exposure requires a non-prod WRITER.** The cache key is derived from the verified content
   fingerprint; poisoning requires a non-prod environment actually writing `verify:v5:*` /`idem:*`
   keys for fingerprints a prod caller then requests.
2. **Mitigated by removing every active non-prod writer, verified live 2026-08-15:**
   - Side-rig `arkova-worker-connector-sidecar-2026-08-staging`: Upstash secret bindings **removed**
     (rev `00013-zqx`, healthy after; also reverted min-instances 2→0). It was the only non-prod
     service both bound to Upstash and receiving traffic.
   - Soak rig: binds no Upstash credentials (verified — 0 refs).
   - `arkova-worker-staging`: still binds the secrets, but its backing Supabase project no longer
     exists (BUG-2026-08-12-015), so it receives no meaningful traffic and therefore writes nothing.
     Left unmodified mid-freeze deliberately — it is a shared service and its rebuild is a separate,
     already-tracked decision. If it is revived before the fix deploys, unbind Upstash first.
3. **Residual risk accepted for ≤4 days:** prod remains the sole active writer, which is exactly the
   pre-existing steady state; the defect's exposure window (months) is not widened by waiting for a
   properly soaked fix. Deploying an unsoaked cache-layer change to the public verify API during the
   soak would be a larger integrity risk than the one being fixed.

_Note for the fix session (task_aceedaf6): the side-rig no longer binds Upstash. For empirical
verification, rebind temporarily — your namespaced keys make that safe — and unbind again after._
