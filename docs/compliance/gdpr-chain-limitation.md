# GDPR Right-to-Erasure & Bitcoin OP_RETURN Limitation

> **Version:** 2026-03-23 | **Classification:** CONFIDENTIAL
> **Story:** DB-AUDIT DR-3 — Document GDPR erasure + Bitcoin OP_RETURN limitation

---

## Summary

Arkova anchors document integrity proofs to Bitcoin using OP_RETURN transactions containing SHA-256 hashes. When a user exercises their GDPR right to erasure (Article 17), Arkova can delete all PII from its database but **cannot erase data written to the Bitcoin blockchain**.

This document explains why this is compliant with GDPR and what safeguards are in place.

---

## What Gets Erased (Database)

When `delete_own_account()` or `anonymize_user_data()` is called (migrations 0061 + 0065):

| Data | Action | Migration |
|------|--------|-----------|
| `profiles.email` | Anonymized to `deleted-{uuid}@erased.arkova.ai` | 0061 |
| `profiles.full_name` | Set to `[Deleted User]` | 0061 |
| `audit_events.actor_email` | Set to NULL | 0061 |
| `audit_events.actor_ip` | Set to NULL | 0061 |
| `audit_events.actor_user_agent` | Set to NULL | 0061 |
| `anchors` owned by user | Soft-deleted (`deleted_at` set) | 0065 |
| `attestations` issued by user | Metadata anonymized | 0065 |
| `api_keys` | Hard-deleted | 0065 |
| `webhooks` | Hard-deleted | 0065 |

## What Remains On-Chain (Bitcoin)

| Data | Format | Reversible? |
|------|--------|-------------|
| SHA-256 hash | 32-byte hex in OP_RETURN | **No** — immutable on blockchain |
| Merkle root (batched) | 32-byte hex in OP_RETURN | **No** — immutable on blockchain |
| Transaction ID | Bitcoin tx reference | **No** — public ledger |

## Why This Is GDPR-Compliant

### 1. The Hash Is Not Personal Data

The OP_RETURN contains only a **SHA-256 hash** of the document fingerprint, not the document itself or any PII. Per GDPR Recital 26:

> *"The principles of data protection should therefore not apply to anonymous information, namely information which does not relate to an identified or identifiable natural person."*

A SHA-256 hash is a **one-way function**. Without the original document, the hash reveals nothing about the data subject. After erasure, the original document mapping is deleted from Arkova's database, making the on-chain hash **anonymized data**.

### 2. Technical Impossibility Exception

GDPR Article 17(1) acknowledges that erasure may be limited where processing is necessary for reasons including **exercising the right of freedom of expression** and **compliance with a legal obligation**. The Bitcoin blockchain is a decentralized, immutable ledger — no single entity can modify or delete its contents.

Article 17(3)(b) allows retention where necessary for "compliance with a legal obligation which requires processing by Union or Member State law."

### 3. Data Minimization by Design

Arkova follows GDPR Article 25 (Data Protection by Design):

- **No PII reaches the blockchain.** Documents never leave the user's device (Constitution 1.6).
- Only a cryptographic hash (not content) is anchored.
- The hash cannot be reversed to obtain the original document.
- After erasure, no database record links the hash to a person.

---

## Data Erasure Certificate

When a user account is deleted, Arkova generates a **Data Erasure Certificate** confirming:

1. **What was deleted:** All PII, profile data, API keys, webhooks
2. **What was anonymized:** Audit events (actor fields nullified)
3. **What was soft-deleted:** Anchor records (recoverable for 30 days, then hard-deleted by retention cron)
4. **What remains:** SHA-256 hashes on Bitcoin blockchain (not PII, not reversible)
5. **Timestamp:** When erasure was completed
6. **Verification:** No remaining database records link the hash to the data subject

---

## Privacy Policy Language

The following language should be included in the privacy policy:

> **Blockchain Anchoring:** When you verify a document through Arkova, a cryptographic hash (a one-way mathematical summary) of the document is recorded on the Bitcoin blockchain. This hash cannot be used to reconstruct the document or identify you. If you request account deletion, we will delete all your personal data from our systems. The cryptographic hash on the blockchain will remain but will no longer be linked to your identity in any Arkova system.

---

## References

- GDPR Article 17 — Right to Erasure
- GDPR Article 25 — Data Protection by Design
- GDPR Recital 26 — Definition of Personal Data
- Migration 0061 — `anonymize_user_data()` RPC
- Migration 0065 — `delete_own_account()` RPC
- `services/worker/src/api/account-delete.ts` — Account deletion endpoint
