# Arkova MVP

Document anchoring system with cryptographic fingerprinting and on-chain verification.

---

## Running Arkova MVP Locally

This guide provides step-by-step instructions for setting up and running the Arkova MVP on your local development machine.

### Prerequisites

Before starting, ensure you have the following installed:

| Requirement | Version | Verify Command |
|-------------|---------|----------------|
| Node.js | 20.x or higher | `node --version` |
| npm | 10.x or higher | `npm --version` |
| Docker | Latest | `docker --version` |
| Supabase CLI | Latest | `supabase --version` |
| Git | Latest | `git --version` |

**Install Supabase CLI (if not installed):**

```bash
npm install -g supabase
```

---

### Step 1: Clone the Repository

```bash
git clone <repository-url>
cd <project-directory>
```

---

### Step 2: Set Up Environment Files

**⚠️ WARNING: Never commit `.env` files with real credentials.**

#### Frontend Environment

```bash
cp .env.example .env
```

Edit `.env` and configure:

```bash
# Supabase (Vite requires VITE_ prefix for client-side variables)
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<your-anon-key-from-supabase-start>

NODE_ENV=development
```

#### Worker Service Environment

```bash
cp services/worker/.env.example services/worker/.env
```

Edit `services/worker/.env` and configure:

```bash
WORKER_PORT=3001
NODE_ENV=development
LOG_LEVEL=info

SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key-from-supabase-start>

# For local development, use mocks
USE_MOCKS=true
```

---

### Step 3: Install Dependencies

#### Frontend Dependencies

```bash
npm install
```

#### Worker Dependencies

```bash
cd services/worker
npm install
cd ../..
```

---

### Step 4: Start Supabase

```bash
supabase start
```

This command will:
- Start PostgreSQL on port 54322
- Start the API on port 54321
- Start Studio (admin UI) on port 54323

**⚠️ IMPORTANT: Copy the output keys!**

The command outputs `anon key` and `service_role key`. You need these for your `.env` files.

Example output:
```
API URL: http://127.0.0.1:54321
anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

### Step 5: Reset Database

This runs all migrations and seeds demo data:

```bash
supabase db reset
```

**⚠️ WARNING: This command drops all data. Only run on local development databases.**

---

### Step 6: Regenerate TypeScript Types

After any database changes, regenerate types:

```bash
npm run gen:types
```

This updates `src/types/database.types.ts` with the current schema.

---

### Step 7: Run Tests

#### All Tests

```bash
npm test
```

#### RLS Integration Tests

```bash
npm run test:rls
```

**⚠️ NOTE: RLS tests require Supabase to be running.**

#### Type Checking

```bash
npm run typecheck
```

#### Linting

```bash
npm run lint
```

#### UI Copy Lint (Terminology Check)

```bash
npm run lint:copy
```

---

### Step 8: Start the Frontend

```bash
npm run dev
```

The frontend will be available at: `http://localhost:5173`

---

### Step 9: Start the Worker Service

In a new terminal:

```bash
cd services/worker
npm run dev
```

The worker will be available at: `http://localhost:3001`

Health check endpoint: `http://localhost:3001/health`

---

### Sanity Checklist

After setup, verify the following:

- [ ] `supabase status` shows all services running
- [ ] `http://127.0.0.1:54323` (Studio) is accessible
- [ ] `npm test` passes
- [ ] `npm run test:rls` passes
- [ ] `npm run lint` passes
- [ ] `npm run lint:copy` passes
- [ ] Frontend loads at `http://localhost:5173`
- [ ] Worker health check returns `{"status":"healthy"}`

---

### Demo Users

The seed data includes these test users:

| Email | Password | Role | Organization |
|-------|----------|------|--------------|
| admin@umich-demo.arkova.io | Demo1234! | ORG_ADMIN | University of Michigan Registrar |
| registrar@umich-demo.arkova.io | Demo1234! | ORG_MEMBER | University of Michigan Registrar |
| admin@midwest-medical.arkova.io | Demo1234! | ORG_ADMIN | Midwest Medical Board |
| individual@demo.arkova.io | Demo1234! | INDIVIDUAL | None |

---

### Common Mistakes

| Problem | Solution |
|---------|----------|
| Supabase won't start | Ensure Docker is running: `docker ps` |
| RLS tests fail | Run `supabase db reset` to apply latest migrations |
| Types out of sync | Run `npm run gen:types` after schema changes |
| Port already in use | Kill existing processes: `lsof -i :54321` |
| Copy lint fails | Check for forbidden terms (wallet, hash, block, transaction, crypto) |
| Worker won't start | Ensure `.env` is configured in `services/worker/` |

---

### Where Governance Rules Live

| Document | Location |
|----------|----------|
| Document Index | `docs/confluence/00_index.md` |
| Development Guidelines | `CLAUDE.md` |
| Architecture Overview | `docs/confluence/01_architecture_overview.md` |
| Data Model | `docs/confluence/02_data_model.md` |
| Security & RLS | `docs/confluence/03_security_rls.md` |
| Audit Events | `docs/confluence/04_audit_events.md` |
| Retention Policy | `docs/confluence/05_retention_legal_hold.md` |
| On-Chain Policy | `docs/confluence/06_on_chain_policy.md` |
| Seed Data Guide | `docs/confluence/07_seed_clickthrough.md` |
| Payments | `docs/confluence/08_payments_entitlements.md` |
| Webhooks | `docs/confluence/09_webhooks.md` |
| Worker Service | `docs/confluence/10_anchoring_worker.md` |
| Proof Packages | `docs/confluence/11_proof_packages.md` |
| Identity & Access | `docs/confluence/12_identity_access.md` |
| Feature Flags | `docs/confluence/13_switchboard.md` |
| KMS Operations | `docs/confluence/14_kms_operations.md` |
| Operational Runbook | `docs/confluence/15_operational_runbook.md` |
| Zero Trust Architecture | `docs/confluence/15_zero_trust_edge_architecture.md` |
| Incident Response | `docs/confluence/16_incident_response.md` |
| Data Classification | `docs/confluence/17_data_classification.md` |

---

### Required End-of-Task Checks

Before completing any development task:

```bash
# 1. Run all tests
npm test

# 2. Run RLS tests
npm run test:rls

# 3. Type check
npm run typecheck

# 4. Lint code
npm run lint

# 5. Check UI terminology
npm run lint:copy

# 6. Regenerate types if schema changed
npm run gen:types

# 7. Verify types are committed
git diff src/types/database.types.ts
```

**⚠️ IMPORTANT: All checks must pass before merging any code.**

---

### Stopping Services

```bash
# Stop Supabase
supabase stop

# Stop frontend
# Press Ctrl+C in the terminal running npm run dev

# Stop worker
# Press Ctrl+C in the terminal running the worker
```

---

### Full Reset

To completely reset your local environment:

```bash
supabase stop
supabase start
supabase db reset
npm run gen:types
```
