# Arkova API — Complete Setup & Usage Guide

> **Last updated:** 2026-03-28
> **Production API:** `https://arkova-worker-270018525501.us-central1.run.app`
> **App:** `https://arkova-26.vercel.app`
> **Interactive docs:** `https://arkova-worker-270018525501.us-central1.run.app/api/docs`

This guide walks you through everything you need to use the Arkova Verification API, from creating your account to making your first API call, building an AI agent that can query Arkova, and setting up x402 micropayments. No blockchain or cryptography experience required.

---

## Table of Contents

1. [What is Arkova?](#1-what-is-arkova)
2. [Creating Your Account](#2-creating-your-account)
3. [Getting Your API Key](#3-getting-your-api-key)
4. [Your First API Call](#4-your-first-api-call)
5. [Core API Endpoints](#5-core-api-endpoints)
   - [Verify a Credential](#51-verify-a-credential)
   - [Anchor a Document](#52-anchor-a-document-submit-for-verification)
   - [Batch Verification](#53-batch-verification)
   - [Entity Lookup](#54-entity-lookup)
   - [Attestations](#55-attestations)
   - [Compliance & Regulatory](#56-compliance--regulatory-checks)
   - [CLE Verification](#57-cle-continuing-legal-education)
   - [AI-Powered Search](#58-ai-powered-search)
   - [Usage & Quotas](#59-usage--quotas)
6. [Using the SDKs](#6-using-the-sdks)
7. [Building an AI Agent with Arkova](#7-building-an-ai-agent-with-arkova)
8. [Setting Up x402 Micropayments](#8-setting-up-x402-micropayments)
9. [Use Cases & Examples](#9-use-cases--examples)
10. [Rate Limits & Quotas](#10-rate-limits--quotas)
11. [Error Handling](#11-error-handling)
12. [API Reference Quick Sheet](#12-api-reference-quick-sheet)
13. [Troubleshooting & FAQ](#13-troubleshooting--faq)

---

## 1. What is Arkova?

Arkova is a credential verification platform that anchors documents to the Bitcoin blockchain. When a document (degree, license, certificate, legal filing, etc.) is "anchored," a unique fingerprint (SHA-256 hash) of that document is permanently recorded on Bitcoin. Anyone can later verify that the document hasn't been tampered with by checking the fingerprint against the blockchain record.

**Key concepts:**

| Term | What it means |
|------|---------------|
| **Anchor** | The act of recording a document's fingerprint on the Bitcoin blockchain |
| **Fingerprint** | A SHA-256 hash of your document — a unique 64-character string. The document itself is never uploaded. |
| **Public ID** | A human-readable identifier like `ARK-2026-ABCD1234` that you share with anyone who needs to verify the document |
| **PENDING** | The fingerprint has been submitted but hasn't been recorded on Bitcoin yet |
| **ACTIVE** | The fingerprint has been confirmed on the Bitcoin blockchain (this is the "verified" state) |
| **Attestation** | A formal claim or endorsement about a credential, made by a person or organization |

**What makes Arkova different:**
- Your documents **never leave your device**. Only the fingerprint (hash) is sent to the server.
- Verification is anchored to Bitcoin — the most secure, tamper-proof public ledger.
- The API is accessible via standard API keys, AI agents, or x402 micropayments (pay-per-query with stablecoins).

---

## 2. Creating Your Account

### Step 1: Go to the Arkova App

Open your browser and navigate to:

```
https://arkova-26.vercel.app
```

### Step 2: Sign Up

You can sign up two ways:

**Option A: Google Sign-In (Fastest)**
1. Click **"Sign in with Google"**
2. Select your Google account
3. You're in!

**Option B: Email & Password**
1. Click **"Sign Up"** (or the sign-up tab)
2. Enter your **email address**
3. Choose a **password** (minimum 8 characters)
4. Confirm your password
5. Optionally enter your **full name**
6. Click **"Create Account"**
7. **Check your email** — you'll receive a confirmation link
8. Click the link in the email to verify your account
9. Sign in with your new credentials

### Step 3: Complete Onboarding

After signing in for the first time, you'll go through a brief onboarding flow where you'll select your role. **To use the API, you must select the "Organization" role.** Individual accounts cannot create API keys.

> **Important:** If there's a beta invite code required, you'll be prompted to enter it before signing up. Contact the Arkova team if you need one.

### Step 4: Create or Join an Organization

After selecting the Organization role, you'll set up your organization:
1. Enter your **organization name**
2. You'll be assigned as the organization admin

That's it — your account is ready. You don't need to verify your identity or your organization to start using the API during the beta period.

---

## 3. Getting Your API Key

### Step 1: Navigate to API Keys

Once logged in:
1. Click **"Settings"** in the left sidebar
2. Click **"API Keys"** (or navigate directly to the API Keys section)

### Step 2: Create a New Key

1. Click **"Create API Key"**
2. Enter a **name** for the key (e.g., "My Test Key", "Production App", "Agent Key")
3. The key will be created with the default `verify` scope (sufficient for most use cases)
4. Click **"Create"**

### Step 3: Copy and Save Your Key

You'll see your API key displayed **once**. It looks like this:

```
ak_live_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6
```

> **CRITICAL:** Copy this key immediately and store it somewhere safe (a password manager, a `.env` file, etc.). You will **never** be able to see the full key again. If you lose it, you'll need to create a new one.

### Understanding Your Key

- Keys starting with `ak_live_` are production keys
- Keys starting with `ak_test_` are test keys
- Your key prefix (first ~12 characters) is visible in the dashboard for identification
- Keys can be revoked at any time from the Settings page

---

## 4. Your First API Call

Let's verify that everything works. Open your terminal and run:

### Check the API is running

```bash
curl https://arkova-worker-270018525501.us-central1.run.app/health
```

You should see:

```json
{
  "status": "healthy",
  "version": "0.1.0",
  "uptime": 123456,
  "network": "mainnet",
  "checks": { "supabase": "ok" }
}
```

### Verify an existing record

Let's verify a public record. Replace `YOUR_API_KEY` with your actual key:

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-DEMO-001
```

If the record exists, you'll get a response like:

```json
{
  "verified": true,
  "status": "ACTIVE",
  "issuer_name": "Arkova",
  "credential_type": "CERTIFICATE",
  "anchor_timestamp": "2026-03-15T12:00:00.000Z",
  "bitcoin_block": 890123,
  "network_receipt_id": "abc123def456...",
  "record_uri": "https://app.arkova.io/verify/ARK-DEMO-001",
  "explorer_url": "https://mempool.space/tx/abc123def456..."
}
```

**Congratulations!** You just made your first Arkova API call.

### Two ways to authenticate

You can pass your API key in either of these ways — both work identically:

```bash
# Method 1: X-API-Key header (recommended)
curl -H "X-API-Key: ak_live_your_key_here" \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-DEMO-001

# Method 2: Authorization Bearer header
curl -H "Authorization: Bearer ak_live_your_key_here" \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-DEMO-001
```

---

## 5. Core API Endpoints

**Base URL:** `https://arkova-worker-270018525501.us-central1.run.app/api/v1`

All examples below assume you've set your API key as an environment variable:

```bash
export ARKOVA_API_KEY="ak_live_your_key_here"
export ARKOVA_BASE="https://arkova-worker-270018525501.us-central1.run.app/api/v1"
```

---

### 5.1 Verify a Credential

**The most common operation.** Given a Public ID (like `ARK-2026-ABCD1234`), check whether the credential is verified on the blockchain.

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/verify/ARK-2026-ABCD1234"
```

**Response:**

```json
{
  "verified": true,
  "status": "ACTIVE",
  "issuer_name": "University of Michigan",
  "credential_type": "DEGREE",
  "issued_date": "2025-05-03",
  "expiry_date": null,
  "anchor_timestamp": "2026-01-15T14:30:00.000Z",
  "bitcoin_block": 890456,
  "network_receipt_id": "a1b2c3...",
  "merkle_proof_hash": "d4e5f6...",
  "record_uri": "https://app.arkova.io/verify/ARK-2026-ABCD1234",
  "explorer_url": "https://mempool.space/tx/a1b2c3...",
  "jurisdiction": "Michigan, USA"
}
```

**Key fields explained:**

| Field | What it tells you |
|-------|-------------------|
| `verified` | `true` if the credential is confirmed on the blockchain |
| `status` | `ACTIVE` = blockchain-confirmed. `PENDING` = submitted but not yet confirmed. `REVOKED` = issuer revoked it. `EXPIRED` = past expiry date. |
| `issuer_name` | The organization that issued/anchored the credential |
| `credential_type` | Type of document: `DEGREE`, `LICENSE`, `CERTIFICATE`, `TRANSCRIPT`, `PROFESSIONAL`, `OTHER` |
| `bitcoin_block` | The Bitcoin block number where this was recorded |
| `explorer_url` | Click this to see the actual Bitcoin transaction on mempool.space |
| `record_uri` | A shareable link anyone can use to verify this credential |

**Get Merkle Proof (advanced):**

If you need cryptographic proof for auditing:

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/verify/ARK-2026-ABCD1234/proof"
```

---

### 5.2 Anchor a Document (Submit for Verification)

To anchor a new document, you send its SHA-256 fingerprint. **The document itself is never uploaded.**

**Step 1: Generate the fingerprint locally**

```bash
# On Mac/Linux — hash any file
shasum -a 256 my_diploma.pdf
# Output: e3b0c44298fc1c149afbf4c8996fb924...  my_diploma.pdf

# Or hash a string
echo -n "my important data" | shasum -a 256
# Output: 7b3f9...
```

**Step 2: Submit the fingerprint**

```bash
curl -X POST "$ARKOVA_BASE/anchor" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "fingerprint": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "credential_type": "DEGREE",
    "description": "BS Computer Science, University of Michigan, 2025"
  }'
```

**Response (201 Created):**

```json
{
  "public_id": "ARK-2026-F7A3B2C1",
  "fingerprint": "e3b0c44298fc1c149afbf4c8996fb924...",
  "status": "PENDING",
  "created_at": "2026-03-28T15:30:00.000Z",
  "record_uri": "https://app.arkova.io/verify/ARK-2026-F7A3B2C1"
}
```

The status starts as `PENDING`. Within minutes, the Arkova worker will batch this fingerprint into a Bitcoin transaction. Once confirmed (usually 10-60 minutes), the status changes to `ACTIVE`.

**Credential types:** `DEGREE`, `LICENSE`, `CERTIFICATE`, `TRANSCRIPT`, `PROFESSIONAL`, `OTHER`

**Idempotent:** If you submit the same fingerprint twice, you'll get back the existing record (200 instead of 201). No duplicates are created.

---

### 5.3 Batch Verification

Verify up to 100 credentials in a single request:

```bash
curl -X POST "$ARKOVA_BASE/verify/batch" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "public_ids": [
      "ARK-2026-ABCD1234",
      "ARK-2026-EFGH5678",
      "ARK-2026-IJKL9012"
    ]
  }'
```

**For small batches (1-20 items)** — you get results immediately:

```json
{
  "results": [
    { "public_id": "ARK-2026-ABCD1234", "verified": true, "status": "ACTIVE", ... },
    { "public_id": "ARK-2026-EFGH5678", "verified": true, "status": "ACTIVE", ... },
    { "public_id": "ARK-2026-IJKL9012", "verified": false, "error": "Record not found" }
  ],
  "total": 3
}
```

**For large batches (21-100 items)** — you get a job ID and poll for results:

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "total": 50,
  "expires_at": "2026-04-04T15:30:00.000Z"
}
```

Then poll for results:

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/jobs/550e8400-e29b-41d4-a716-446655440000"
```

```json
{
  "job_id": "550e8400-...",
  "status": "complete",
  "total": 50,
  "results": [ ... ],
  "created_at": "2026-03-28T15:30:00.000Z",
  "completed_at": "2026-03-28T15:30:05.000Z",
  "expires_at": "2026-04-04T15:30:00.000Z"
}
```

Job statuses: `submitted` → `processing` → `complete` (or `failed`). Results are retained for 7 days.

---

### 5.4 Entity Lookup

Search for all credentials associated with an entity (person, organization, or domain):

```bash
# Search by name
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/verify/entity?name=University%20of%20Michigan&limit=10"

# Search by domain
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/verify/entity?domain=umich.edu"

# Search by identifier
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/verify/entity?identifier=CIK-0001318605"
```

---

### 5.5 Attestations

Attestations are formal claims about a credential. For example, an employer attesting they verified a degree, or an auditor attesting a compliance check was performed.

**Create an attestation:**

```bash
curl -X POST "$ARKOVA_BASE/attestations" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subject_type": "credential",
    "subject_identifier": "ARK-2026-ABCD1234",
    "attestation_type": "VERIFICATION",
    "attester_name": "Acme HR Department",
    "attester_type": "CORPORATION",
    "claims": [
      {
        "claim": "Verified degree authenticity via direct institution contact",
        "evidence": "Phone verification with University of Michigan Registrar on 2026-03-28"
      }
    ],
    "summary": "Degree verified as authentic during employment background check"
  }'
```

**Response (201):**

```json
{
  "public_id": "ARK-ACME-VER-A1B2C3",
  "subject_type": "credential",
  "subject_identifier": "ARK-2026-ABCD1234",
  "attestation_type": "VERIFICATION",
  "status": "ACTIVE",
  "attester_name": "Acme HR Department",
  "claims": [{ "claim": "...", "evidence": "..." }],
  "created_at": "2026-03-28T16:00:00.000Z"
}
```

**Attestation types:** `VERIFICATION`, `ENDORSEMENT`, `AUDIT`, `APPROVAL`, `WITNESS`, `COMPLIANCE`, `SUPPLY_CHAIN`, `IDENTITY`, `CUSTOM`

**List attestations:**

```bash
curl "$ARKOVA_BASE/attestations?subject_identifier=ARK-2026-ABCD1234&limit=25"
```

**Batch create (up to 100):**

```bash
curl -X POST "$ARKOVA_BASE/attestations/batch-create" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "attestations": [
      { "subject_type": "credential", "subject_identifier": "ARK-2026-001", "attestation_type": "VERIFICATION", "attester_name": "Acme Corp", "claims": [{"claim": "Verified"}] },
      { "subject_type": "credential", "subject_identifier": "ARK-2026-002", "attestation_type": "VERIFICATION", "attester_name": "Acme Corp", "claims": [{"claim": "Verified"}] }
    ]
  }'
```

**Revoke an attestation:**

```bash
curl -X PATCH "$ARKOVA_BASE/attestations/ARK-ACME-VER-A1B2C3/revoke" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Attestation made in error" }'
```

---

### 5.6 Compliance & Regulatory Checks

**Run a compliance check against public records (SEC filings, sanctions, regulatory actions):**

```bash
curl -X POST "$ARKOVA_BASE/compliance/check" \
  -H "X-API-Key: $ARKOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "entity_name": "Acme Corp",
    "entity_type": "organization",
    "check_types": ["sec_filings", "regulatory_actions"],
    "jurisdiction": "California"
  }'
```

**Response:**

```json
{
  "entity_name": "Acme Corp",
  "risk_level": "low",
  "compliance_status": "clear",
  "findings": [
    {
      "source": "sec_filings",
      "type": "10-K",
      "title": "Annual Report - Acme Corp",
      "filed_date": "2026-02-15",
      "url": "https://sec.gov/..."
    }
  ],
  "checked_at": "2026-03-28T16:30:00.000Z"
}
```

**Search public regulatory records:**

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/regulatory/lookup?q=Acme%20Corp&source=edgar&limit=20"
```

Sources: `edgar` (SEC), `federal_register`, `uspto` (patents), `openalex` (academic), `courtlistener` (court records), `all`

---

### 5.7 CLE (Continuing Legal Education)

For legal professionals — verify CLE compliance:

```bash
# Check CLE compliance for a bar number
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/cle/verify?bar_number=NY-123456&jurisdiction=New%20York"

# List CLE credits
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/cle/credits?bar_number=NY-123456&period_start=2025-01-01&period_end=2025-12-31"

# Get CLE requirements by state
curl "$ARKOVA_BASE/cle/requirements?jurisdiction=New%20York"
```

---

### 5.8 AI-Powered Search

**Nessie RAG Query — Ask questions about public records in natural language:**

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/nessie/query?q=What%20SEC%20filings%20has%20Tesla%20made%20in%202025?&limit=10"
```

**Response:**

```json
{
  "query": "What SEC filings has Tesla made in 2025?",
  "results": [
    {
      "title": "Tesla Inc - 10-K Annual Report",
      "source": "edgar",
      "relevance_score": 0.95,
      "snippet": "For the fiscal year ended December 31, 2025...",
      "url": "https://sec.gov/..."
    }
  ],
  "total": 5
}
```

---

### 5.9 Usage & Quotas

Check how many API calls you've made this month:

```bash
curl -H "X-API-Key: $ARKOVA_API_KEY" \
  "$ARKOVA_BASE/usage"
```

```json
{
  "used": 1234,
  "limit": "unlimited",
  "remaining": "unlimited",
  "reset_date": "2026-05-01T00:00:00.000Z",
  "month": "2026-04",
  "keys": [
    { "key_prefix": "ak_live_a1b2", "name": "My Test Key", "used": 1234 }
  ]
}
```

> **During beta, all quotas are disabled.** You have unlimited API calls.

---

## 6. Using the SDKs

### TypeScript SDK

**Install:**

```bash
npm install @arkova/sdk
# or
yarn add @arkova/sdk
```

**Usage:**

```typescript
import { ArkovaClient } from '@arkova/sdk';

const client = new ArkovaClient({
  apiKey: 'ak_live_your_key_here'
});

// --- Verify a credential ---
const result = await client.verify('ARK-2026-ABCD1234');
console.log(result.verified);  // true
console.log(result.status);    // "ACTIVE"
console.log(result.issuer_name); // "University of Michigan"

// --- Anchor new data ---
// The SDK hashes your data locally — the raw data never leaves your machine
const receipt = await client.anchor('my important document text');
console.log(receipt.public_id);  // "ARK-2026-F7A3B2C1"
console.log(receipt.status);     // "PENDING"

// --- Anchor a file ---
import { readFileSync } from 'fs';
const fileData = readFileSync('my_diploma.pdf');
const receipt2 = await client.anchor(fileData, {
  credentialType: 'DEGREE',
  description: 'BS Computer Science'
});

// --- Verify raw data against the chain ---
const verification = await client.verifyData('my important document text');
console.log(verification.verified);

// --- Generate a fingerprint without anchoring ---
const fp = await ArkovaClient.fingerprint('my data');
console.log(fp); // "7b3f9..."
```

### Python SDK

**Install:**

```bash
pip install arkova
# Requires: httpx
```

**Usage:**

```python
from arkova import ArkovaClient

client = ArkovaClient(api_key="ak_live_your_key_here")

# --- Verify a credential ---
result = client.verify("ARK-2026-ABCD1234")
print(result.verified)      # True
print(result.status)        # "ACTIVE"
print(result.issuer_name)   # "University of Michigan"

# --- Anchor new data ---
receipt = client.anchor(b"my important document text")
print(receipt.public_id)    # "ARK-2026-F7A3B2C1"

# --- Anchor a file ---
with open("my_diploma.pdf", "rb") as f:
    receipt = client.anchor(f.read(), credential_type="DEGREE")

# --- Verify raw data ---
result = client.verify_data(b"my important document text")
print(result.verified)

# --- Use as context manager ---
with ArkovaClient(api_key="ak_live_...") as client:
    result = client.verify("ARK-2026-ABCD1234")
```

---

## 7. Building an AI Agent with Arkova

You can give an AI agent (Claude, ChatGPT, or any LLM) the ability to verify credentials and search public records through Arkova. Here's how.

### Option A: Tool/Function Calling (Recommended)

Most modern AI platforms support "tool calling" or "function calling." You define tools that the AI can invoke, and the platform handles the back-and-forth.

#### Claude (Anthropic API) Example

```python
import anthropic
import httpx

ARKOVA_API_KEY = "ak_live_your_key_here"
ARKOVA_BASE = "https://arkova-worker-270018525501.us-central1.run.app/api/v1"

# Define the tools the agent can use
tools = [
    {
        "name": "verify_credential",
        "description": "Verify a credential's authenticity by its Arkova Public ID (e.g., ARK-2026-ABCD1234). Returns whether the credential is blockchain-verified, who issued it, what type it is, and when it was anchored.",
        "input_schema": {
            "type": "object",
            "properties": {
                "public_id": {
                    "type": "string",
                    "description": "The Arkova Public ID of the credential to verify (starts with 'ARK-')"
                }
            },
            "required": ["public_id"]
        }
    },
    {
        "name": "search_entity",
        "description": "Search for all credentials and public records associated with a person, organization, or domain. Useful for background checks and due diligence.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the person or organization"
                },
                "domain": {
                    "type": "string",
                    "description": "Domain name (e.g., 'umich.edu')"
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (1-50, default 10)"
                }
            }
        }
    },
    {
        "name": "compliance_check",
        "description": "Run a compliance check on an entity against SEC filings, sanctions lists, and regulatory actions. Returns risk level and findings.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entity_name": {
                    "type": "string",
                    "description": "Name of the entity to check"
                },
                "entity_type": {
                    "type": "string",
                    "enum": ["person", "organization"],
                    "description": "Type of entity"
                },
                "check_types": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["sec_filings", "sanctions", "regulatory_actions", "attestations", "all"]},
                    "description": "Types of checks to run"
                }
            },
            "required": ["entity_name"]
        }
    },
    {
        "name": "search_records",
        "description": "Search Arkova's database of 320K+ public records using natural language. Covers SEC filings, court records, patents, academic publications, and regulatory actions.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural language search query"
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (1-50, default 10)"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "anchor_document",
        "description": "Submit a document fingerprint (SHA-256 hash) for blockchain anchoring. The document itself is never uploaded — only the hash. Returns a Public ID that anyone can use to verify the document later.",
        "input_schema": {
            "type": "object",
            "properties": {
                "fingerprint": {
                    "type": "string",
                    "description": "SHA-256 hash of the document (64 hex characters)"
                },
                "credential_type": {
                    "type": "string",
                    "enum": ["DEGREE", "LICENSE", "CERTIFICATE", "TRANSCRIPT", "PROFESSIONAL", "OTHER"],
                    "description": "Type of credential"
                },
                "description": {
                    "type": "string",
                    "description": "Brief description of the document"
                }
            },
            "required": ["fingerprint"]
        }
    }
]


def call_arkova_tool(tool_name: str, tool_input: dict) -> str:
    """Execute an Arkova API call based on the tool name and input."""
    headers = {"X-API-Key": ARKOVA_API_KEY, "Content-Type": "application/json"}

    if tool_name == "verify_credential":
        resp = httpx.get(
            f"{ARKOVA_BASE}/verify/{tool_input['public_id']}",
            headers=headers
        )
        return resp.text

    elif tool_name == "search_entity":
        params = {k: v for k, v in tool_input.items() if v is not None}
        resp = httpx.get(
            f"{ARKOVA_BASE}/verify/entity",
            headers=headers,
            params=params
        )
        return resp.text

    elif tool_name == "compliance_check":
        resp = httpx.post(
            f"{ARKOVA_BASE}/compliance/check",
            headers=headers,
            json=tool_input
        )
        return resp.text

    elif tool_name == "search_records":
        resp = httpx.get(
            f"{ARKOVA_BASE}/nessie/query",
            headers=headers,
            params={"q": tool_input["query"], "limit": tool_input.get("limit", 10)}
        )
        return resp.text

    elif tool_name == "anchor_document":
        resp = httpx.post(
            f"{ARKOVA_BASE}/anchor",
            headers=headers,
            json=tool_input
        )
        return resp.text

    return '{"error": "Unknown tool"}'


def run_agent(user_message: str):
    """Run a Claude agent with Arkova tools."""
    client = anthropic.Anthropic()

    messages = [{"role": "user", "content": user_message}]

    # Agent loop — keep going until Claude stops calling tools
    while True:
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system="You are a credential verification assistant powered by Arkova. You can verify credentials on the Bitcoin blockchain, search public records, run compliance checks, and anchor new documents. Always explain what you find in clear, non-technical language.",
            tools=tools,
            messages=messages,
        )

        # Add assistant response to conversation
        messages.append({"role": "assistant", "content": response.content})

        # Check if Claude wants to use tools
        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = call_arkova_tool(block.name, block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })
            messages.append({"role": "user", "content": tool_results})
        else:
            # Claude is done — print the final response
            for block in response.content:
                if hasattr(block, "text"):
                    print(block.text)
            break


# --- Example usage ---
run_agent("Can you verify credential ARK-2026-ABCD1234 and tell me if it's legitimate?")
run_agent("Run a compliance check on Tesla Inc and summarize any SEC filings.")
run_agent("Search for any credentials or records related to Stanford University.")
```

#### OpenAI (GPT) Example

```python
from openai import OpenAI
import httpx
import json

ARKOVA_API_KEY = "ak_live_your_key_here"
ARKOVA_BASE = "https://arkova-worker-270018525501.us-central1.run.app/api/v1"

client = OpenAI()

# Define tools in OpenAI format
tools = [
    {
        "type": "function",
        "function": {
            "name": "verify_credential",
            "description": "Verify a credential by its Arkova Public ID",
            "parameters": {
                "type": "object",
                "properties": {
                    "public_id": {"type": "string", "description": "Arkova Public ID (e.g., ARK-2026-ABCD1234)"}
                },
                "required": ["public_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_records",
            "description": "Search 320K+ public records using natural language",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Max results (default 10)"}
                },
                "required": ["query"]
            }
        }
    }
]


def call_tool(name, args):
    headers = {"X-API-Key": ARKOVA_API_KEY}
    if name == "verify_credential":
        r = httpx.get(f"{ARKOVA_BASE}/verify/{args['public_id']}", headers=headers)
        return r.text
    elif name == "search_records":
        r = httpx.get(f"{ARKOVA_BASE}/nessie/query", headers=headers,
                       params={"q": args["query"], "limit": args.get("limit", 10)})
        return r.text
    return '{"error": "Unknown"}'


messages = [
    {"role": "system", "content": "You are a credential verification assistant. Use the Arkova tools to verify credentials and search public records."},
    {"role": "user", "content": "Is credential ARK-2026-ABCD1234 legitimate?"}
]

# Agent loop
while True:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=tools,
    )

    msg = response.choices[0].message
    messages.append(msg)

    if msg.tool_calls:
        for tc in msg.tool_calls:
            result = call_tool(tc.function.name, json.loads(tc.function.arguments))
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })
    else:
        print(msg.content)
        break
```

### Option B: MCP Server (Model Context Protocol)

If you're using Claude Desktop or another MCP-compatible client, Arkova provides an MCP server:

1. The MCP spec is at `https://arkova-worker-270018525501.us-central1.run.app/.well-known/openapi.json`
2. Point your MCP client at the Arkova API base URL
3. The tools are automatically discovered

### Option C: Simple Script (No Agent Framework)

If you just want to query Arkova from a script without an AI framework:

```python
import httpx

ARKOVA_API_KEY = "ak_live_your_key_here"
BASE = "https://arkova-worker-270018525501.us-central1.run.app/api/v1"
HEADERS = {"X-API-Key": ARKOVA_API_KEY}

# Verify a credential
result = httpx.get(f"{BASE}/verify/ARK-2026-ABCD1234", headers=HEADERS).json()
print(f"Verified: {result['verified']}, Status: {result.get('status')}")

# Search public records
records = httpx.get(f"{BASE}/nessie/query", headers=HEADERS,
                     params={"q": "Tesla SEC filings 2025"}).json()
for r in records.get("results", []):
    print(f"  - {r['title']} ({r['source']})")

# Run compliance check
check = httpx.post(f"{BASE}/compliance/check", headers=HEADERS,
                    json={"entity_name": "Acme Corp", "check_types": ["all"]}).json()
print(f"Risk: {check['risk_level']}, Findings: {len(check.get('findings', []))}")
```

---

## 8. Setting Up x402 Micropayments

x402 is an open protocol that lets you pay for API calls with stablecoins (USDC) instead of using an API key. This is useful for:
- Anonymous access (no account needed)
- Pay-per-query pricing
- Machine-to-machine payments
- Agents that need to pay for their own API calls

### How it Works

1. You make an API call **without** an API key
2. The server returns a **402 Payment Required** response with payment instructions
3. You send a USDC payment to the specified address on Base Sepolia
4. You retry the request with the payment proof in the `X-Payment` header
5. The server verifies the payment on-chain and returns the result

### Current x402 Configuration

| Setting | Value |
|---------|-------|
| Network | Base Sepolia (testnet) |
| Currency | USDC |
| Payment address | `0xae1201D68cE24fC6...75ba04` |
| Chain ID | `eip155:84532` |

### Step-by-Step: Making an x402 Payment

**Step 1: Make a request without auth**

```bash
curl https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-2026-ABCD1234
```

**Step 2: You receive a 402 response**

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:84532",
    "maxAmountRequired": "2000",
    "resource": "/api/v1/verify/ARK-2026-ABCD1234",
    "description": "Arkova verification: /api/v1/verify",
    "payTo": "0xae1201D68cE24fC6...75ba04",
    "maxTimeoutSeconds": 60,
    "asset": "USDC",
    "extra": {
      "facilitatorUrl": "https://x402.org/facilitator"
    }
  }],
  "error": "Payment required. Include x402 payment header to proceed."
}
```

The `maxAmountRequired` is in USDC micro-units (6 decimals). `2000` = $0.002.

**Step 3: Send the USDC payment**

Using your wallet (MetaMask, ethers.js, viem, etc.), send the specified amount of USDC to the `payTo` address on Base Sepolia.

**Step 4: Retry with payment proof**

Encode your payment proof as base64 JSON and include it in the `X-Payment` header:

```javascript
// Using ethers.js / viem
const paymentProof = {
  txHash: "0xabc123...",           // The USDC transfer transaction hash
  network: "eip155:84532",         // Base Sepolia chain ID
  payerAddress: "0xyour_wallet...", // Your wallet address
  timestamp: Math.floor(Date.now() / 1000)
};

const encoded = btoa(JSON.stringify(paymentProof));

// Make the request with payment proof
fetch("https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-2026-ABCD1234", {
  headers: { "X-Payment": encoded }
});
```

```bash
# curl version
PAYMENT=$(echo -n '{"txHash":"0xabc...","network":"eip155:84532","payerAddress":"0xyour...","timestamp":1711648000}' | base64)

curl -H "X-Payment: $PAYMENT" \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/ARK-2026-ABCD1234
```

**Step 5: Get your result**

The server verifies the payment on-chain, then returns the normal verification response.

### x402 Pricing Table

| Endpoint | Price per call |
|----------|---------------|
| `/verify/:publicId` | $0.002 |
| `/verify/batch` | $0.002 per item |
| `/verify/entity` | $0.005 |
| `/compliance/check` | $0.010 |
| `/regulatory/lookup` | $0.002 |
| `/cle/*` | $0.005 |
| `/ai/search` | $0.010 |
| `/nessie/query` | $0.010 |

### x402 with an AI Agent (ethers.js example)

```javascript
import { ethers } from 'ethers';

const USDC_ADDRESS = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // Base Sepolia USDC
const ARKOVA_PAY_TO = "0xae1201D68cE24fC6...75ba04"; // Arkova's payment address

async function payAndVerify(publicId, wallet) {
  // Step 1: Try the request
  const resp = await fetch(
    `https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/${publicId}`
  );

  if (resp.status !== 402) return await resp.json();

  // Step 2: Parse payment requirements
  const payReq = await resp.json();
  const amount = payReq.accepts[0].maxAmountRequired; // "2000" (micro USDC)

  // Step 3: Send USDC payment
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    "function transfer(address to, uint256 amount) returns (bool)"
  ], wallet);

  const tx = await usdc.transfer(ARKOVA_PAY_TO, amount);
  const receipt = await tx.wait();

  // Step 4: Retry with payment proof
  const proof = btoa(JSON.stringify({
    txHash: receipt.hash,
    network: "eip155:84532",
    payerAddress: wallet.address,
    timestamp: Math.floor(Date.now() / 1000)
  }));

  const result = await fetch(
    `https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/${publicId}`,
    { headers: { "X-Payment": proof } }
  );

  return await result.json();
}
```

> **Note:** x402 is currently on Base Sepolia (testnet). You'll need testnet USDC, which you can get from faucets. In production, this will move to Base mainnet.

---

## 9. Use Cases & Examples

### Background Check / HR Verification

An HR department receives a candidate's credential IDs and verifies them in bulk:

```python
import httpx

HEADERS = {"X-API-Key": "ak_live_...", "Content-Type": "application/json"}
BASE = "https://arkova-worker-270018525501.us-central1.run.app/api/v1"

# Candidate provides their credential IDs
candidate_credentials = [
    "ARK-2026-UMICH-BS-001",
    "ARK-2026-NYBOE-LIC-042",
    "ARK-2026-ABIM-CERT-018"
]

# Batch verify all at once
resp = httpx.post(f"{BASE}/verify/batch", headers=HEADERS,
                   json={"public_ids": candidate_credentials})
results = resp.json()["results"]

for r in results:
    status = "VERIFIED" if r["verified"] else "NOT VERIFIED"
    print(f"{r['public_id']}: {status} — {r.get('credential_type', 'Unknown')} from {r.get('issuer_name', 'Unknown')}")
```

### Due Diligence / Compliance

Before onboarding a vendor, check their regulatory history:

```python
# Check the company
check = httpx.post(f"{BASE}/compliance/check", headers=HEADERS,
                    json={
                        "entity_name": "Vendor Corp",
                        "entity_type": "organization",
                        "check_types": ["sec_filings", "regulatory_actions", "sanctions"]
                    }).json()

if check["risk_level"] == "high":
    print(f"WARNING: High risk — {len(check['findings'])} findings")
    for f in check["findings"]:
        print(f"  - [{f['source']}] {f['title']}")
else:
    print(f"Clear — risk level: {check['risk_level']}")
```

### Academic Verification for Admissions

A university verifying transfer credits:

```python
# Verify each transcript
for transcript_id in ["ARK-2026-OSU-TRANS-001", "ARK-2026-CC-TRANS-002"]:
    result = httpx.get(f"{BASE}/verify/{transcript_id}", headers=HEADERS).json()
    if result["verified"]:
        print(f"{transcript_id}: Verified transcript from {result['issuer_name']}")
        print(f"  Anchored on Bitcoin block {result['bitcoin_block']}")
        print(f"  View proof: {result['explorer_url']}")
```

### Audit Trail with Attestations

Creating a verifiable audit trail:

```python
# After verifying a credential, create an attestation
attestation = httpx.post(f"{BASE}/attestations", headers=HEADERS,
    json={
        "subject_type": "credential",
        "subject_identifier": "ARK-2026-ABCD1234",
        "attestation_type": "AUDIT",
        "attester_name": "PwC Audit Division",
        "attester_type": "CORPORATION",
        "claims": [
            {
                "claim": "Credential verified against issuing institution records",
                "evidence": "Audit reference: PwC-2026-AUD-4521"
            },
            {
                "claim": "No signs of tampering or modification detected",
                "evidence": "SHA-256 fingerprint matches original submission"
            }
        ],
        "summary": "Annual credential audit — all checks passed"
    }).json()

print(f"Attestation created: {attestation['public_id']}")
# This attestation is now permanently linked and can be verified by anyone
```

### Legal / CLE Compliance Monitoring

A law firm tracking CLE compliance:

```python
# Check all attorneys
attorneys = [
    {"name": "Jane Smith", "bar": "NY-123456", "jurisdiction": "New York"},
    {"name": "John Doe", "bar": "CA-789012", "jurisdiction": "California"},
]

for atty in attorneys:
    result = httpx.get(f"{BASE}/cle/verify",
                        headers=HEADERS,
                        params={"bar_number": atty["bar"],
                                "jurisdiction": atty["jurisdiction"]}).json()
    status = "COMPLIANT" if result.get("compliant") else "NON-COMPLIANT"
    print(f"{atty['name']} ({atty['bar']}): {status}")
```

---

## 10. Rate Limits & Quotas

### Rate Limits

| Access Level | Limit | Window |
|-------------|-------|--------|
| No API key (anonymous) | 100 requests/minute per IP | 60 seconds |
| With API key | 1,000 requests/minute per key | 60 seconds |
| Batch endpoints | 10 requests/minute | 60 seconds |

Every response includes these headers:

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 987
X-RateLimit-Reset: 1711648060
```

If you exceed the limit, you'll get a `429 Too Many Requests` response with a `Retry-After` header telling you how many seconds to wait.

### Monthly Quotas

| Tier | Monthly Limit |
|------|--------------|
| Free | 10,000 requests |
| Paid | Unlimited |
| **Beta (current)** | **Unlimited (all quotas disabled)** |

Every response includes quota headers:

```
X-Quota-Used: 1234
X-Quota-Limit: unlimited
X-Quota-Reset: 2026-05-01T00:00:00.000Z
```

---

## 11. Error Handling

### HTTP Status Codes

| Code | Meaning | What to Do |
|------|---------|-----------|
| `200` | Success | Everything worked |
| `201` | Created | New resource created (anchor, attestation) |
| `202` | Accepted | Async job started (large batch) |
| `400` | Bad Request | Check your request body/params — something is malformed |
| `401` | Unauthorized | Check your API key. Is it correct? Has it been revoked? Has it expired? |
| `402` | Payment Required | x402 payment needed (see Section 8) |
| `403` | Forbidden | Your key doesn't have the required scope, or you're not authorized for this resource |
| `404` | Not Found | The credential/record doesn't exist |
| `429` | Too Many Requests | Rate limit or quota exceeded — wait and retry (check `Retry-After` header) |
| `500` | Server Error | Something went wrong on our end — retry after a moment |
| `503` | Service Unavailable | The API is temporarily disabled — check back later |

### Error Response Format

All errors return JSON:

```json
{
  "error": "error_code",
  "message": "Human-readable description of what went wrong"
}
```

### Retry Strategy

For production applications, implement exponential backoff:

```python
import time
import httpx

def resilient_verify(public_id, max_retries=3):
    for attempt in range(max_retries):
        resp = httpx.get(
            f"{BASE}/verify/{public_id}",
            headers={"X-API-Key": API_KEY}
        )

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 5))
            print(f"Rate limited, waiting {retry_after}s...")
            time.sleep(retry_after)
            continue

        if resp.status_code >= 500:
            wait = 2 ** attempt  # 1s, 2s, 4s
            print(f"Server error, retrying in {wait}s...")
            time.sleep(wait)
            continue

        # 4xx errors (except 429) — don't retry
        return resp.json()

    raise Exception(f"Failed after {max_retries} retries")
```

---

## 12. API Reference Quick Sheet

```
Base URL: https://arkova-worker-270018525501.us-central1.run.app/api/v1
Auth:     X-API-Key: ak_live_... (or Authorization: Bearer ak_live_...)
Docs:     https://arkova-worker-270018525501.us-central1.run.app/api/docs
Spec:     https://arkova-worker-270018525501.us-central1.run.app/api/docs/spec.json
```

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | None | Health check (always available) |
| `GET` | `/verify/:publicId` | Optional | Verify a credential |
| `GET` | `/verify/:publicId/proof` | None | Get Merkle proof |
| `POST` | `/verify/batch` | API Key | Batch verify (up to 100) |
| `GET` | `/verify/entity` | Optional | Entity lookup |
| `POST` | `/anchor` | API Key | Anchor a fingerprint |
| `GET` | `/jobs/:jobId` | API Key | Poll async batch job |
| `POST` | `/attestations` | API Key | Create attestation |
| `GET` | `/attestations` | None | List attestations |
| `GET` | `/attestations/:publicId` | None | Get attestation |
| `PATCH` | `/attestations/:publicId/revoke` | API Key | Revoke attestation |
| `POST` | `/attestations/batch-create` | API Key | Create up to 100 attestations |
| `POST` | `/attestations/batch-verify` | API Key | Verify up to 100 attestations |
| `POST` | `/compliance/check` | Optional | Compliance check |
| `GET` | `/regulatory/lookup` | Optional | Regulatory search |
| `GET` | `/cle/verify` | Optional | CLE compliance check |
| `GET` | `/cle/credits` | Optional | List CLE credits |
| `POST` | `/cle/submit` | API Key | Submit CLE completion |
| `GET` | `/cle/requirements` | None | CLE requirements by state |
| `GET` | `/nessie/query` | Optional | AI-powered record search |
| `GET` | `/usage` | API Key | Monthly usage stats |
| `POST` | `/keys` | JWT | Create API key |
| `GET` | `/keys` | JWT | List API keys |
| `PATCH` | `/keys/:keyId` | JWT | Update/revoke key |
| `DELETE` | `/keys/:keyId` | JWT | Delete key |

---

## 13. Troubleshooting & FAQ

### "I get a 401 Unauthorized error"

- **Check your API key** — make sure it starts with `ak_live_` or `ak_test_`
- **Check the header** — use `X-API-Key: ak_live_...` (not `X-Api-Key` with lowercase)
- **Key revoked?** — check your API Keys settings page
- **Key expired?** — if you set an expiry, the key may have expired

### "I get a 403 Forbidden when creating API keys"

- You must be signed in with a Supabase JWT (not an API key) to manage keys
- Your account must belong to an organization
- Sign up with the "Organization" role during onboarding

### "I get a 503 Service Unavailable"

- The Verification API feature flag may be disabled
- This is temporary — the `Retry-After` header tells you when to try again

### "My credential shows status PENDING"

- This is normal! After anchoring, it takes 10-60 minutes for the Bitcoin transaction to be confirmed
- Once confirmed, the status changes to `ACTIVE`
- You can check the `explorer_url` to see the transaction status on mempool.space

### "How do I verify a PDF or file?"

1. Generate the SHA-256 hash of the file locally:
   ```bash
   shasum -a 256 my_file.pdf
   ```
2. Use the `/anchor` endpoint to submit the hash
3. Share the returned `public_id` with anyone who needs to verify
4. To verify later, the verifier hashes their copy of the file and compares with the anchored fingerprint

### "Can I use the API without an account?"

Yes, in two ways:
1. **Public endpoints** — `/verify/:publicId`, `/attestations` (GET), `/cle/requirements`, `/health` are accessible without any auth
2. **x402 payments** — pay per query with USDC (see Section 8) — no account needed at all

### "What's the difference between verify and attestation?"

- **Verify** checks if a document's fingerprint exists on the blockchain
- **Attestation** is a claim made by someone about a credential ("I, as an employer, attest that I verified this degree")

### "How do I get testnet USDC for x402?"

x402 currently uses Base Sepolia (testnet). Get test USDC from:
- [Base Sepolia Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
- [Chainlink Faucet](https://faucets.chain.link/)

### "Where can I see the interactive API docs?"

Visit: `https://arkova-worker-270018525501.us-central1.run.app/api/docs`

This is a Swagger UI where you can try out every endpoint directly in your browser.

---

## Need Help?

- **Interactive API Docs:** [Swagger UI](https://arkova-worker-270018525501.us-central1.run.app/api/docs)
- **OpenAPI Spec:** [spec.json](https://arkova-worker-270018525501.us-central1.run.app/api/docs/spec.json)
- **App:** [arkova-26.vercel.app](https://arkova-26.vercel.app)
- **Email:** support@arkova.ai
