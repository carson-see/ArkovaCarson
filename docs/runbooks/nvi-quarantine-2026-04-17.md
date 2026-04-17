# NVI Quarantine — 2026-04-17

**Scope:** Nessie compliance-intelligence endpoints (FCRA / HIPAA / FERPA).
**Mandate:** CLAUDE.md §0 NVI Gate Mandate — no new regulation training, and
customer-facing UI must surface a caveat for under-verified intelligence.
**Jira:** SCRUM-819 (NVI-15), SCRUM-804 (NVI epic).

## Status Roster

| Regulation | Version       | Endpoint (RunPod)        | Status         | Caveat required | Confidence downgrade |
|------------|---------------|--------------------------|----------------|-----------------|----------------------|
| FCRA       | v27.x (27.3)  | `ikkto3e36xllms`         | UNDER_REVIEW   | Yes (soft)      | 0.05                 |
| HIPAA      | v28.0         | `7d1mr5m9y6nnyx`         | **QUARANTINED**| Yes             | 0.10                 |
| FERPA      | v29.0         | `mwcomiw9avfqom`         | **QUARANTINED**| Yes             | 0.10                 |

All three endpoints REMAIN SERVING. Quarantine is a routing + UX treatment,
not a takedown.

## Policy

1. **No new regulations until FCRA passes NVI.**
   SOX, GDPR, state-specific, Kenya DPA Deep, etc. are blocked. FCRA is the
   designated single-domain mastery target.

2. **Quarantined endpoints MUST surface a caveat** on every customer-facing
   surface that shows the model's output:
   - Compliance scorecard page (NCA-08)
   - `/api/v1/compliance/audit` response body (`quarantine` field)
   - Intelligence-answer responses from `/api/v1/nessie/*`

3. **Confidence is downgraded by the table value above** before it is shown
   to the user or logged to audit metadata. This avoids false precision.

4. **CI gates on citation verification.** `build-dataset.ts` consults
   `verification-status.json` and refuses to emit training JSONL if any
   cited source is not trusted (NVI-18). Override for disposable experiments:
   `NVI_SKIP_GUARD=1`. CI MUST NOT set this.

5. **Roadmap to clearance (FCRA v27.4+):**
   - Every FCRA source in the registry passes NVI-01..04 validator.
   - `verify-sources.ts` exits 0 under `--strict` for FCRA.
   - Attorney review on the FCRA gold-standard benchmark (SCRUM-815 / NVI-11).
   - Roster updated in `services/worker/src/ai/nessie-quarantine.ts`.

## Consumer Wiring

- `services/worker/src/ai/nessie-quarantine.ts` — policy source of truth.
  `getQuarantineStatus(regulation, version)` returns the current entry.
- `services/worker/src/api/v1/compliance-audit.ts` — attaches
  `result.quarantine` to audit responses.
- UI (frontend `src/lib/copy.ts`) — caveat strings read directly from the
  quarantine entry's `caveat` field via API response.

## Review Checklist

When a regulation is proposed for clearance:

- [ ] `verify-sources.ts --strict --regulation <reg>` exits 0.
- [ ] Independent attorney spot-check of ≥20 source quotes.
- [ ] Gold-standard benchmark passes DoD threshold (SCRUM-815).
- [ ] `nessie-quarantine.ts` updated + PR reviewed + tests green.
- [ ] CLAUDE.md §0 roster line updated.
- [ ] Customer status page notes the clearance.

## Why Not Take the Endpoints Offline?

The model still encodes useful regulatory structure even where individual
citations are fabricated. The failure mode we care about is **customers
relying on fabricated quotes** — which the caveat addresses. Taking the
endpoint offline denies users information they already had yesterday.
