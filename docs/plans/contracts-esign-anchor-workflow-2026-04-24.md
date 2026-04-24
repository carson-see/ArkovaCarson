# Contracts E-Signature Audit + Anchor Workflow

Status: engineering note for SCRUM-862 and SCRUM-863. Confluence remains the documentation source of truth.

## What shipped

- `services/worker/src/ai/contracts/e-signature-providers.ts` normalizes six provider audit trails into one schema:
  - DocuSign
  - Adobe Acrobat Sign
  - Dropbox Sign / HelloSign
  - SignNow
  - PandaDoc
  - Proof / Notarize
- Tamper detection compares the client-side signed-document fingerprint to the audit-trail document hash.
- DocuSign Connect webhooks verify `X-DocuSign-Signature-1` HMAC-SHA256 over the exact raw request body.
- Adobe Acrobat Sign webhooks verify the registered `X-AdobeSign-ClientId` verification-of-intent value and support optional HMAC if configured.
- Contract pre/post-signing anchors use existing `anchors` rows and preserve Arkova's no-raw-document boundary.
- Proof packages are ZIP bundles of fingerprints, anchor receipts, audit-trail metadata, and validation reports. PDF bytes are intentionally excluded.

## Provider caveats

DocuSign: Connect HMAC validation must use the unmodified raw body. Pretty-printed JSON or reserialized request bodies will fail verification. Configure `DOCUSIGN_CONNECT_HMAC_SECRET`.

Adobe Acrobat Sign: official webhook delivery relies on verification of intent using `X-AdobeSign-ClientId`; the worker requires that value to match `ADOBE_SIGN_CLIENT_ID`. If a tenant adds a separate HMAC layer, set `ADOBE_SIGN_WEBHOOK_SECRET`.

Dropbox Sign / HelloSign: audit trails include transaction identifiers and PDF hash evidence, but provider callbacks are not wired in this story. Use the normalized parser for retrieved audit trails.

SignNow: normalized from document-history/certificate-of-events exports. Hash labels vary by export mode, so the parser accepts `Document Hash` and `SHA-256`.

PandaDoc: normalized from document audit-trail exports and API audit entries. Provider API retrieval is out of scope for this story.

Proof / Notarize: transaction-level and document-level audit trails differ. The normalized parser treats transaction ID and tamper-sealed document hash as the canonical evidence fields.

## Legal-admissibility notes

This workflow is evidence preparation, not legal advice. The proof package is designed to help a qualified witness or records custodian explain what system produced the evidence and what the hashes prove.

- Federal Rule of Evidence 901 asks the proponent to show enough evidence that the item is what the proponent claims it is.
- Federal Rule of Evidence 902(13)/(14) supports self-authentication paths for certified electronic-process records and digitally identified file copies.
- ESIGN, 15 U.S.C. 7001, prevents a signature, contract, or record from being denied legal effect solely because it is electronic, while preserving other substantive-law requirements.
- UETA similarly establishes legal equivalence for electronic records/signatures in adopting states.

## Privacy boundary

The Jira story text says worker endpoints accept PDFs. That conflicts with CLAUDE.md section 1.6: documents never leave the user's device. The implementation therefore rejects `pdf`, `pdfBase64`, `signedPdfBase64`, `file`, and `documentBytes` payloads and accepts only client-side SHA-256 fingerprints plus PII-aware audit metadata.

## Remaining human gates

- Configure DocuSign/Adobe secrets in the worker environment.
- Run provider sandbox webhooks end to end.
- Decide whether SCRUM-863 should get a dedicated frontend flow or stay API-first.
- Legal counsel should review the final Confluence legal-admissibility wording before customer-facing use.

## Sources

- DocuSign HMAC: https://www.docusign.com/blog/developers/manually-authenticating-hmac-signatures-docusign-connect-webhook-configurations
- Adobe Acrobat Sign webhooks: https://developer.adobe.com/acrobat-sign/docs/overview/acrobat_sign_events/
- Federal Rule of Evidence 901: https://www.law.cornell.edu/rules/fre/rule_901
- Federal Rule of Evidence 902: https://www.law.cornell.edu/rules/fre/rule_902
- ESIGN Act compilation: https://www.govinfo.gov/content/pkg/COMPS-940/pdf/COMPS-940.pdf
- UETA overview: https://www.uniformlaws.org/acts/catalog/current/e
