# SCRUM-2996 — xTRA Program Response (skeleton)

**Lane 3, 2026-07-20. SKELETON ONLY — not a submission.** xTRA response due 2026-08-14 per Lane 3 sprint plan. **No signature promises** (SIGN-01 undecided). Every capability claim is labeled measured / asserted / **NOT-asserted** per §1.5 and sourced from `SCRUM-2995-capability-matrix-v1`. This is the R-7 claims-review discipline: state what is **measured vs asserted vs NOT asserted**.

## Section skeleton
1. **Introduction / org overview** — *[founder framing]*.
2. **Program-fit statement** — how Arkova's verifiable-anchoring + CTDL interoperability maps to xTRA objectives *[align to the specific xTRA prompt — insert the actual xTRA questions here when available]*.
3. **Technical capability response** — governed by the three-column claim table below. **Do not answer any capability question outside this table without adding a labeled row.**
4. **Standards & interoperability** — CTDL import/parse built; sandbox read validated; native-compliance **not asserted**.
5. **Limitations & roadmap** — English-only OCR (disclose); audio/video content extraction **not offered**; template reconstruction fix in flight (SCRUM-2999).
6. **References** — CE (Jeanne Kitchens), sandbox (Jeff Grann). No commitments.

## Claim table — measured / asserted / NOT-asserted
| Capability area | MEASURED (verified) | ASSERTED (config/code, unconfirmed runtime) | **NOT ASSERTED** (explicitly not claimed) |
|---|---|---|---|
| Anchoring | SHA-256 integrity + timestamp, any format | — | anchoring as legal proof of authenticity of *content* |
| Extraction | PDF, DOCX, PNG/JPG/WEBP/GIF | — | HEIC/TIFF OCR; **audio/video content extraction** |
| AI template | — | structured template for supported docs | current richness/accuracy figures (SCRUM-2999 open) |
| CTDL | import/parse implemented + tested (PR #1603) | serializer round-trip | **"natively CTDL-compliant"** (SCRUM-2998 owns) |
| CE registry | sandbox GET-by-CTID read works | — | real-envelope consume; publish access; "fully integrated" |
| Multilingual | — | — | non-English OCR (English-only; disclose) |
| Fraud detection | UI removed | — | fraud detection as a product feature |

## Guards
- **No signature / no commitment language.** SIGN-01 is Carson's decision.
- Any new xTRA question must be answered **only** via a labeled row above; if a capability isn't in the matrix, the answer is "not asserted" until verified.
- English-only OCR limitation must appear in the limitations section (consistency with the Mercy letter).
