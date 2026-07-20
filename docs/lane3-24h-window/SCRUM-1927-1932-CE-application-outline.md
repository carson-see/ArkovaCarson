# SCRUM-1927 / SCRUM-1932 — Credential Engine Application Outlines (draft)

**Lane 3, 2026-07-20. OUTLINE ONLY — not a submission.** Founder-reserved: filing and any signature are Carson's (SIGN-01 undecided — **no signature or commitment language anywhere in these drafts**). CE applications drafted by 2026-07-28, filed 2026-07-31 per Lane 3 sprint plan. All capability statements are sourced from `SCRUM-2995-capability-matrix-v1` and preserve §1.5 labels.

## SCRUM-1927 — CE Membership / Organization Application (outline)
1. **Organization identity** — Arkova legal entity, domain (arkova.ai), primary contact (Carson). *[founder to supply legal specifics]*
2. **Mission / fit statement** — verifiable document anchoring + credential interoperability; alignment with CE's open-registry mission.
3. **Technical capability summary** — sourced from capability matrix (see claim table below).
4. **Intended registry use** — publish/consume CTDL for credential records; interoperability with issuer partners.
5. **Standards posture** — CTDL import/parse implemented (SCRUM-2913); "natively CTDL-compliant" **not asserted** pending SCRUM-2998.
6. **References / partners** — Credential Engine contact Jeanne Kitchens (CTSO); Jeff Grann (sandbox). *[relationship framing only, no commitments]*

## SCRUM-1932 — CE Registry Publishing / CTDL Application (outline)
1. **CTDL production readiness** — importer built (Draft PR #1603); serializer exists (`ctdl-serializer.ts`). Round-trip parse tested (26 cases).
2. **Sandbox validation status** — sandbox reachable; GET-by-CTID read confirmed; **real-envelope consume pending** a Jeff Grann published resource (SCRUM-2993 finding).
3. **Data scope** — which fields Arkova publishes (ctid, name, ownedBy/issuer, dateEffective, expirationDate/status). Map to capability matrix.
4. **Limitations disclosure** — English-only OCR (Mercy-letter disclosure); template reconstruction currently degraded (SCRUM-2999, being fixed).
5. **Timeline** — *[dates are founder's to commit; leave as placeholders]*.

## Claim table (paste-ready; §1.5-labeled)
| Claim | Label | Wording to use | Wording to AVOID |
|---|---|---|---|
| Document anchoring | measured | "Anchors any file format with SHA-256 integrity + Bitcoin timestamp." | — |
| CTDL import/parse | measured | "CTDL JSON-LD import implemented and unit-tested." | "in production" (Draft, unmerged) |
| CE registry consume | measured | "Validated read access against the CE sandbox registry." | "fully integrated with CE registry" |
| Natively CTDL-compliant | **not_asserted** | *(omit)* | "natively CTDL-compliant" (pending SCRUM-2998) |
| Audio/image support | measured | "Anchors audio and image files; extracts content from PDF/DOCX/common images." | "understands/reads audio", "reads all image formats" |
| Template intelligence | asserted/degraded | *(omit or)* "structured extraction for supported document types." | any richness/accuracy metric |

**Signature/commitment guard:** these drafts contain **no** signature blocks, no dated commitments, no membership-fee acceptance, no LOI language. Carson decides SIGN-01 and files.
