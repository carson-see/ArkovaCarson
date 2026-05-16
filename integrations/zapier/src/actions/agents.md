# integrations/zapier/src/actions/agents.md

Zapier action definitions for Arkova (INT-05).

## Files
- **`anchorDocument.ts`** — submits a SHA-256 fingerprint for Bitcoin anchoring via `POST /api/v1/anchor`.
- **`verifyCredential.ts`** — verifies a credential by public ID via `GET /api/v1/verify/:publicId`.
- **`batchVerify.ts`** — verifies up to 20 credentials in one request via `POST /api/v1/verify/batch`.

## Conventions
- Zapier users compute the hash externally or in a prior Zap step; actions receive the pre-computed fingerprint.
- Error responses are mapped to `z.errors.Error` for Zapier's error UX.
