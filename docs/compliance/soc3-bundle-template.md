# SOC 3 Bundle — Template + Extraction Procedure

> **Version:** 1.0 | **Created:** 2026-04-21 | **Owner:** Carson (CISO)
> **Jira:** SCRUM-981 (TRUST-13) | **Depends on:** SCRUM-979 (TRUST-12) completion
> **Target publish date:** 2027-03-15 (2 weeks after SOC 2 Type II report lands)

---

## Purpose

SOC 2 Type II is a confidential attestation report — prospects need an
NDA before we can share it. **SOC 3** is a public-facing executive
summary of the same audit that we can hand out freely, link in a
footer, or render on the marketing compliance page.

This doc is the template + extraction procedure that turns the SOC 2
Type II report (SCRUM-979) into a public SOC 3 bundle without leaking
confidential control details.

## How to use this document

1. Wait for the final SOC 2 Type II report PDF (SCRUM-979 Step 6).
2. Request a SOC 3 bundle from the same auditor (cheap incremental —
   see Section 2).
3. When the SOC 3 PDF arrives, run Section 4 to publish it.
4. Maintain the marketing trust page (Section 5) + refresh annually.

## 1. What the auditor actually produces

Both SOC 2 Type II and SOC 3 cover the same audit window + same TSCs.
The difference is what gets published:

| SOC 2 Type II | SOC 3 |
|---------------|-------|
| Management's system description | Management's system description (abridged) |
| Description of controls with evidence references | Description of controls (summary only, no evidence detail) |
| Results of tests of controls | **Omitted** (the value: this is where exceptions live) |
| Auditor's opinion | Auditor's opinion |
| Complementary user entity controls | Summary of customer-side responsibilities |
| **Report distribution:** NDA-only | **Report distribution:** public |

So the SOC 3 bundle is essentially: management's description + opinion
letter, without the detailed test results or exception list.

## 2. Cost + procurement

When engaging the auditor for Type II (SCRUM-522), ALSO request the
SOC 3 add-on in the same SOW. The auditor reuses all the same
evidence + opinion, so the incremental cost is typically **$3k-$5k**
vs ~$35-55k for the Type II itself.

Do NOT wait until Type II delivery to ask — auditors charge a
premium for "re-opening" an engagement to produce an additional
report.

## 3. SOC 3 extraction procedure

### Step 1 — Receive the auditor's SOC 3 draft

Typically a 10-15 page PDF, structured:
- Cover + distribution statement.
- Independent service auditor's report (the opinion).
- Management's assertion.
- System description (1-2 pages; condensed from Type II's ~10 pages).
- Trust Service Criteria + our controls summary table.

### Step 2 — CISO review against public-sharing criteria

Before signing off, check every paragraph for:

- [ ] No customer names or logos.
- [ ] No specific vendor names beyond industry-standard references
  (e.g. "hyperscaler infrastructure" OK; "Supabase database" requires
  sign-off because it names a sub-processor).
- [ ] No specific Supabase project IDs, GCP project IDs, Cloudflare
  account numbers.
- [ ] No specific revenue, employee counts, or other financial detail
  beyond the minimum the auditor needs.
- [ ] No raw employee names (auditor normally redacts automatically).
- [ ] No mention of specific incidents or exceptions — SOC 3 is
  summary-only by design.
- [ ] Architecture claims are tight: "client-side only document
  processing per Constitution 1.6" (quote this doc by name) ✓.

### Step 3 — Sign the management assertion

Carson (CEO) signs. CTO co-signs as signatory on control operations.
Auditor finalizes.

### Step 4 — Final PDF + hosting

- [ ] Upload to
  `docs/compliance/evidence-binder/2026-Q4/soc3-report-2026.pdf`.
- [ ] Mirror to R2 / CDN at
  `https://trust.arkova.ai/soc3/arkova-soc3-2026.pdf` (content-type
  `application/pdf`, cache-control `public, max-age=86400`).
- [ ] Set up a 302 at `https://arkova.ai/trust/soc3` → the CDN PDF.

## 4. Marketing compliance page updates

On publish date (target 2027-03-15):

1. Add SOC 3 badge to `arkova-marketing/src/pages/CompliancePage.tsx`.
2. Badge links to `/trust/soc3`.
3. Update footer on `arkova-marketing/src/components/Footer.tsx` to
   add "SOC 3 Report" link.
4. Add FAQ entry: "Where do I get the full SOC 2 Type II report?" →
   "Under NDA — email `trust@arkova.ai`."

## 5. Ongoing maintenance

- **Annual re-audit** (TRUST-12 follow-up): the Year-2 Type II
  re-audit produces a new SOC 3. The public PDF URL stays the same;
  only the PDF contents rotate. Update the badge year.
- **Interim letters:** if a material control change mid-audit-year
  (e.g. new data center) requires a SOC 2 "bridge letter", the SOC 3
  is typically NOT re-issued; bridge letters are for Type II
  consumers only.
- **De-list procedure:** if a SOC 3 is withdrawn (rare — usually only
  on major control failure), remove the 302, the badge, and the
  footer link. Keep the PDF archived but delisted.

## 6. Trust page structure (for the marketing handoff)

```markdown
# Trust Center — Arkova

## Audits + Attestations
- SOC 3 2026 — [PDF](/trust/soc3)
- SOC 2 Type II 2026 — [Request via NDA](mailto:trust@arkova.ai)
- CSA STAR Level 1 — [Registry Listing](...)
- UK Cyber Essentials Plus — Cert #...

## Security
- Constitution 1.6 — client-side-only document processing
- KMS-backed signing (GCP)
- TLS 1.3 everywhere

## Privacy
- EU-US DPF: Arkova participates
- 13 regulatory frameworks mapped

## Reports
- Architecture diagram (public)
- SBOM (public, generated via SCRUM-TBD)
- Whitepaper: "How Arkova anchors documents without leaving your device"
```

## 7. Change log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-21 | Claude / Carson | Initial template (SCRUM-981 TRUST-13). |
