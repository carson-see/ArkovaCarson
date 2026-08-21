# FD-FERPA-1 — the FERPA directory-information opt-out is not honored by any public projection

**Found 2026-08-20 during adversarial review of the provenance-chain spec. This is a LIVE
regulatory compliance defect affecting real records in production, not a design concern.**

## The defect

`anchors.directory_info_opt_out` was added by archive migration `0197_reg02_directory_info_opt_out.sql`.
Its own column comment states the obligation exactly:

> FERPA Section 99.37 — when true, directory-level fields (name, degree type, dates) are
> suppressed in verification API responses

The column exists in production (present in the squashed baseline at line 7339 and in
`database.types.ts`). **No public projection function reads it.** Verified directly against
prod `vzwyaatejekddvltxyye` by searching each function's definition:

| Function | Reads `directory_info_opt_out`? |
|---|---|
| `get_public_anchor` | **NO** |
| `get_public_anchor_by_fingerprint` | **NO** |
| `search_public_credentials` | **NO** |

## Live impact, measured

```
SELECT count(*) FILTER (WHERE directory_info_opt_out)                       -> 3
       count(*) FILTER (WHERE directory_info_opt_out AND status='SECURED')  -> 3
       count(*)                                                             -> 3,553,500
```

**All three records that carry the opt-out are SECURED, and SECURED is exactly the state the
public projections serve.** So three people exercised a statutory right to suppress their
directory information, the flag was recorded faithfully, and the verification API publishes
their directory fields anyway. The suppression was never wired to the surface it names.

Three is a small number, and that is not a mitigation. The obligation is per-person, the
control was represented as implemented, and the count only stays small until a customer with a
student population turns this on at scale.

## Why it survived

The REST path does consult the flag, which is likely why this looked implemented. The RPC path
that anonymous verification actually uses does not. That asymmetry — one path honoring a
suppression flag and a parallel path ignoring it — is the same shape as FD-GATE-1 filed earlier
today, where three `/api/v1` route trees bypass the kill switch that §1.9 claims covers them.
Both are cases where a control exists, is believed to be global, and is enforced on only one of
several surfaces.

## What must happen

1. **Fix the three projections** to suppress directory-level fields when the flag is set,
   failing CLOSED (suppress on read error, never publish on doubt) — the same discipline
   migration 0356 applied to `recipient_identifier`.
2. **Add a projection-parity ratchet test** that fails when any NEW anon-reachable surface
   projects directory-level fields without consulting the flag. A one-time fix here repeats;
   a ratchet does not.
3. **Assess disclosure obligations** for the three affected records with counsel — that is a
   legal call, not an engineering one, and it should not wait on the code fix.
4. Do NOT treat this as closed when the code lands: confirm against prod that the three records
   stop projecting directory fields.

## Not asserted

Whether any of the three records was actually retrieved by a third party is NOT established
here. That would require log analysis over the retention window, and it changes the disclosure
question materially, so it should be answered before counsel decides.
