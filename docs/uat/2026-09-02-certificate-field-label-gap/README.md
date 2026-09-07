# UAT — audit certificate field labels vs values (2026-09-02)

Branch `fix/certificate-field-label-gap`, stacked on PR #2528 (`fix/published-verification-pointers`, head `7781bf0e`).
Fixes `addField` in `src/lib/generateAuditReport.ts`; the QR / Verify Online block from PR #2528 is untouched.

## What was wrong

For any field label of roughly 13 characters or more, the value was painted on top of the label:
"Document TypeDIPLOMA", "Verification Path2 step(s)", "Record Position#3", "Tree Leaf Count8",
"Network Record#850,123", "Proof Schema Version1", "Network Observed TimeJun 2, 2026, 3:00 AM UTC".
Short labels (Filename, File Size, Issued, Created, Secured, Signature) kept a visible gap.

Root cause: jsPDF's `getTextWidth` measures with the *current* font. The helper painted the label in
helvetica-bold, switched to helvetica-regular for the value, then measured `label + '  '` — regular
metrics, kerning on — for text painted with bold advance widths. jsPDF 4.2.1 has a separate
Helvetica-Bold width table, so the shortfall grew with label length. Present since PR #761 (2026-05-11).

Pre-fix gap between the painted label edge and the value start (from jsPDF's own tables, 9 pt):

| Label | old value offset | painted label | gap |
|---|---|---|---|
| Filename | 14.73 mm | 13.72 mm | +1.02 mm |
| Document Type | 23.69 mm | 23.72 mm | −0.03 mm |
| Verification Path | 24.48 mm | 24.92 mm | −0.44 mm |
| Record Position | 24.03 mm | 24.26 mm | −0.22 mm |
| Proof Schema Version | 33.05 mm | 33.72 mm | −0.67 mm |
| Network Observed Time | 35.85 mm | 36.23 mm | −0.38 mm |

## The fix

Measure the label while the bold face is still selected, with `doKerning: false` (a plain `Tj` string
is painted with advance widths only; jsPDF's own `text()` measures the same way), then start the value a
fixed 2 mm past it. Every label now gets the same gap.

## Files

Same fixture in every file (the `securedData()` fixture from `generateAuditReport.test.ts`, publicId `ARK-2026-001`).
In each side-by-side image the **left half is before, the right half is after**.

| File | Renderer |
|---|---|
| `fields-before-after-quicklook.png` | macOS QuickLook (`qlmanage -t -s 2400`) |
| `fields-before-after-poppler.png` | poppler `pdftoppm -r 200` |
| `fields-before-quicklook.png` / `fields-after-quicklook.png` | the two halves, unstitched |
| `certificate-before.pdf` / `certificate-after.pdf` | the PDFs themselves |

## Gates run

`npx vitest run src/lib/generateAuditReport.test.ts src/lib/certificateQr.test.ts` — 43 passed (5 new spacing tests,
all red before the fix). `npm run typecheck` clean. `npm run lint` 0 errors (1 pre-existing warning in an unrelated
hook test). `npm run lint:copy` compliant. `src/lib/copy.ts` untouched.

## Bug Tracker entry (paste-ready — the Atlassian connector was unauthenticated in the fixing session)

- **Title:** Audit certificate PDF: field values overprint labels of ~13+ characters
- **Found:** 2026-09-02, while reviewing PR #2528's certificate output; pre-existing since PR #761 (2026-05-11)
- **Surface:** downloadable audit certificate (`src/lib/generateAuditReport.ts`, `addField`)
- **Severity:** cosmetic; every certificate ever generated is affected, no data or proof integrity impact
- **Root cause:** label width measured in the value face (helvetica-regular, kerned) after being painted in helvetica-bold
- **Fix:** measure in the painted face with `doKerning: false`, fixed 2 mm gap; content-stream tests pin the gap and its uniformity
- **PR:** fix/certificate-field-label-gap (stacked on #2528)
- **Evidence:** this folder
