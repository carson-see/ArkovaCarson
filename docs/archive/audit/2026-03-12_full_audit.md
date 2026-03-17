# Arkova Full Audit Report — 2026-03-12
_Auditor: Claude Code | Scope: Backlog, UI/UX, Gaps, Stories, Next Steps_

---

## 1. BACKLOG AUDIT — STATUS vs. REALITY

### Summary

| Priority | Stories | Complete | Partial | Not Started | Testnet Blocker? |
|----------|---------|----------|---------|-------------|-----------------|
| P1 Bedrock | 6 | 6 | 0 | 0 | No |
| P2 Identity | 5 | 5 | 0 | 0 | No |
| P3 Vault | 3 | 3 | 0 | 0 | No |
| P4-E1 Anchor Engine | 3 | 3 | 0 | 0 | No |
| P4-E2 Credential Metadata | 3 | 3 | 0 | 0 | No |
| P5 Org Admin | 6 | 6 | 0 | 0 | No |
| P6 Verification | 6 | 5 | 1 | 0 | No (widget is nice-to-have) |
| P7 Go-Live | 13 | 9 | 2 | 2 | **YES — CRIT-2, CRIT-3** |
| P4.5 Verification API | 13 | 0 | 0 | 13 | No (post-launch) |
| DH Deferred Hardening | 12 | 1 | 0 | 11 | **Partial — some items affect reliability** |
| **Total** | **70** | **41** | **3** | **26** | |

### What Remains for Testnet MVP

**Already done** (don't worry about these):
- Core credentialing flow (upload → fingerprint → anchor → verify) — COMPLETE
- Signet chain client with full provider abstractions — CODE COMPLETE
- Signet treasury funded (500,636 sats) — DONE
- Signet E2E broadcast verified — TX `b8e381df...` confirmed on Signet
- Webhook delivery engine — COMPLETE
- Billing UI + checkout flow — MOSTLY COMPLETE
- 736+ tests, 116 E2E specs, 80%+ coverage thresholds — SOLID

**Must finish for testnet MVP** (blocking full user flow):

| # | Item | Why It Blocks | Effort |
|---|------|---------------|--------|
| 1 | Worker ↔ Frontend integration test (real Signet anchor) | Worker processes PENDING anchors but may not be tested E2E against the actual frontend flow on Signet | 1-2 days |
| 2 | Plan change/downgrade flows (CRIT-3 remainder) | If user downgrades mid-cycle, entitlements could be inconsistent | 2-3 days |
| 3 | Dead footer links (/privacy, /terms, /contact) | 404 on public pages — unprofessional for any release | 1 day |
| 4 | No logo assets (SVG/PNG) | Using lucide Shield icon — no brand identity for proof receipts, public pages, PDF certificates | 1 day (design provided) |
| 5 | No favicon or meta tags | `index.html` has no favicon, no OG tags, no meta description | 0.5 days |
| 6 | No toast/notification system | Users get no feedback on most actions (save, create, error) except revoke/webhook | 1 day |
| 7 | `ENABLE_PROD_NETWORK_ANCHORING` flag default=false | Must be true for testnet demo; needs deployment config | 0.5 days |
| 8 | Worker deployment | Express worker needs a hosting solution (Railway, Fly.io, EC2) | 1-2 days |
| 9 | Supabase production/staging project | Currently local only | 1 day |
| 10 | Email confirmation flow | `EmailConfirmation.tsx` exists but Supabase email config may not be set | 0.5 days |

**Can defer past testnet MVP:**
- P4.5 Verification API (all 13 stories) — intentionally post-launch
- P6-TS-03 embeddable widget — nice-to-have
- DH-01 through DH-12 (except DH-06 and DH-07 which affect reliability)
- AWS KMS (mainnet only)
- P7-TS-04, P7-TS-06 (not enumerated in backlog)

---

## 2. UI/UX AUDIT

### Critical Issues (Must Fix)

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **No logo** — uses lucide Shield icon everywhere | Sidebar, PublicVerifyPage, AuthLayout, PDF certificates | No brand identity. Proof receipts look generic. |
| 2 | **No favicon** — browser tab shows default icon | `index.html` | Looks unfinished. |
| 3 | **No meta tags** — no description, no OG image | `index.html` | Bad SEO, ugly link previews when shared. |
| 4 | **Dead footer links** — /privacy, /terms, /contact are 404 | `PublicVerifyPage.tsx:105-107`, `AuthLayout.tsx:58-62` | Users click → white screen. Unacceptable for public-facing pages. |
| 5 | **No toast/notification system** — no Sonner, no react-hot-toast | Global | Users click "Save" with no visible feedback. Only webhooks has toast. |
| 6 | **No loading page/splash** — app shows blank white during auth check | `App.tsx` initial render | Brief flash of nothing before auth resolves. |
| 7 | **No 404 page** — unmatched routes show blank | `App.tsx` — no catch-all route | Typing wrong URL → nothing. |
| 8 | **No error boundary** — unhandled errors crash the whole app | Global | One component error → white screen. |

### UX Improvements (Should Fix)

| # | Issue | Location | Recommendation |
|---|-------|----------|----------------|
| 9 | Sidebar missing Billing link | `Sidebar.tsx:36-44` | Add "Billing" nav item for easy access to plan/usage |
| 10 | Sidebar missing Webhooks link | `Sidebar.tsx:42-44` | Webhooks buried under Settings, should be in secondary nav |
| 11 | No mobile responsive sidebar | `Sidebar.tsx` | Sidebar doesn't collapse to hamburger on mobile — unusable on phones |
| 12 | Dashboard "Secure Document" flow UX | `DashboardPage.tsx` | No progress indicator during fingerprinting. No success animation. |
| 13 | Public verify page has no "drag & drop" | `VerificationForm.tsx` | SimpleProof allows file drag-and-drop to verify — we only have ID lookup |
| 14 | Onboarding has no progress stepper | `OnboardingRolePage → OnboardingOrgPage` | Users don't know how many steps remain |
| 15 | Records list has no pagination | `RecordsList.tsx` | Will break with 100+ records |
| 16 | No dark mode toggle | Global | Design tokens exist in `index.css` but no toggle in UI |
| 17 | Help page is sparse | `HelpPage.tsx` | Only 4 FAQ items. No docs, no video, no getting started guide. |
| 18 | PDF certificate has no logo | `generateAuditReport.ts` | jsPDF proof receipt has text only — should have Arkova logo |
| 19 | Organization page has no org logo upload | `OrganizationPage.tsx` | Orgs can't brand their credentials |
| 20 | No keyboard shortcuts | Global | Power users can't navigate quickly |

### Design Comparison: Arkova vs. SimpleProof

| Aspect | SimpleProof | Arkova Current | Gap |
|--------|-------------|----------------|-----|
| Landing page | Full marketing site with hero, how-it-works, case studies | None — app only | **No marketing site** |
| Logo | Orange/white professional mark | Lucide Shield icon | **No custom logo** |
| Public verification | Drag & drop file + hash comparison | ID lookup only | Missing file-based verification |
| Trust indicators | Forbes, AWS Qualified, case studies | None | No social proof |
| Developer docs | API docs prominently linked | Behind feature flag | Deferred (fine) |
| Mobile experience | Fully responsive | Desktop-only sidebar | Needs responsive design |

---

## 3. GAPS PREVENTING TESTNET LAUNCH

### GAP-1: No Production Deployment Pipeline
**What:** The app has no deployment target beyond `arkova-carson.vercel.app` (frontend only). The Express worker has no deployment config.
**Why it blocks:** Without deployed worker, anchors stay PENDING forever. No real Signet anchoring happens.
**Fix:** Deploy worker to Railway/Fly.io/EC2 with env vars. Configure Supabase staging project.

### GAP-2: No Toast/Feedback System
**What:** 95% of user actions have no visible feedback. No Sonner, no react-hot-toast, no notification center.
**Why it blocks:** Users can't tell if actions succeeded or failed. They'll think the app is broken.
**Fix:** Add Sonner (shadcn/ui compatible). Wire to all mutation hooks.

### GAP-3: Dead Legal Pages
**What:** Footer links to /privacy, /terms, /contact go to 404.
**Why it blocks:** Any investor, customer, or auditor who clicks these links sees a blank page. For a trust product, this is devastating.
**Fix:** Create minimal legal pages or link to external hosted docs.

### GAP-4: No Brand Assets
**What:** No SVG logo, no favicon, no OG image, no brand mark.
**Why it blocks:** Proof receipts (PDF + JSON) have no visual brand. Public pages look generic. Can't create marketing site without a logo.
**Fix:** Design and integrate Arkova logo SVG. Add favicon. Add OG meta tags.

### GAP-5: No Error Boundary / 404 Page
**What:** Unhandled errors or unknown routes produce blank white screens.
**Why it blocks:** Any edge case during demo → white screen → app looks broken.
**Fix:** Add React ErrorBoundary wrapper + catch-all 404 route.

### GAP-6: Worker-Frontend Integration Not Tested on Signet
**What:** We have a verified Signet broadcast (tx `b8e381df...`) and we have a working frontend, but the full loop (frontend upload → worker processes → Signet broadcast → status SECURED → public verify) has never been tested end-to-end against a deployed system.
**Why it blocks:** This IS the testnet MVP. If this flow doesn't work, nothing else matters.
**Fix:** Deploy worker + frontend to staging, run the full flow, verify.

### GAP-7: Stripe Plan Change/Downgrade (CRIT-3 Remainder)
**What:** Users can subscribe but can't upgrade, downgrade, or cancel.
**Why it blocks:** For testnet MVP, this is acceptable if plans are free/demo. For any paid release, it's blocking.
**Fix:** Implement `customer.subscription.updated` and `customer.subscription.deleted` webhook handlers.

### GAP-8: No Marketing/Landing Site
**What:** arkova.ai has no website. No way for prospects to learn about the product.
**Why it blocks:** Can't share the product with anyone who doesn't have a direct link.
**Fix:** Build marketing site (SimpleProof-inspired). Can be a separate Next.js/Astro site or even static HTML.

### GAP-9: File-Based Public Verification Missing
**What:** Public verification only supports ID lookup. Users can't drag-and-drop a file to verify its fingerprint matches a record.
**Why it blocks:** This is a core value proposition — "verify without revealing." SimpleProof has this. We don't.
**Fix:** Add file drop zone to PublicVerifyPage that computes SHA-256 in browser and matches against stored fingerprint.

### GAP-10: No Responsive Mobile Layout
**What:** Sidebar doesn't collapse to hamburger menu. App is desktop-only.
**Why it blocks:** Anyone trying the app on a phone/tablet gets a broken layout.
**Fix:** Add mobile-responsive sidebar with sheet/drawer pattern.

---

## 4. USER STORIES TO ADDRESS GAPS

### MVP-Critical Stories (Must complete for testnet launch)

#### MVP-01: Production Deployment Pipeline
**As a** developer,
**I want** the worker service deployed to a cloud platform with proper env vars,
**So that** PENDING anchors are processed against Signet and the full user flow works.

**Acceptance Criteria:**
- Worker deployed to Railway/Fly.io with all env vars from Constitution 13
- `ENABLE_PROD_NETWORK_ANCHORING=true` for testnet
- `BITCOIN_NETWORK=signet` configured
- Health endpoint accessible
- Cron jobs running (anchor processing, webhook retries)
- Supabase staging project provisioned with production schema

**DoD:** Full flow tested: upload → fingerprint → insert → worker processes → Signet broadcast → SECURED → public verify page shows status.

---

#### MVP-02: Toast/Notification System
**As a** user,
**I want** visual feedback when I perform actions (save, create, delete, error),
**So that** I know whether my action succeeded or failed.

**Acceptance Criteria:**
- Sonner installed and configured (shadcn/ui Toaster)
- Toast wired to: anchor creation, revocation, profile save, org settings, billing, CSV upload, webhook creation
- Error toasts for failed operations
- Success toasts for completed operations

**DoD:** Every mutation hook shows appropriate toast. No silent failures.

---

#### MVP-03: Legal Pages (Privacy, Terms, Contact)
**As a** visitor to the public verification page,
**I want** working privacy policy, terms of service, and contact links,
**So that** I can trust this platform with my document verification.

**Acceptance Criteria:**
- `/privacy` route renders privacy policy page
- `/terms` route renders terms of service page
- `/contact` route renders contact page (or redirects to mailto)
- Content can be placeholder for testnet but must exist

**DoD:** All footer links functional. No 404s on public pages.

---

#### MVP-04: Brand Assets Integration
**As a** user,
**I want** to see the Arkova logo (not a generic shield icon) throughout the app,
**So that** the platform feels professional and trustworthy.

**Acceptance Criteria:**
- Arkova SVG logo created and placed in `public/` directory
- Logo used in: Sidebar, PublicVerifyPage header, AuthLayout, PDF certificates
- Favicon (`.ico` + `apple-touch-icon`) added to `index.html`
- OG meta tags added (title, description, image)
- Logo variants: full color, white (for dark backgrounds), icon-only

**DoD:** Brand consistent across all surfaces. PDF proof receipt includes logo. Browser tab shows favicon.

---

#### MVP-05: Error Boundary + 404 Page
**As a** user,
**I want** a helpful error page when something goes wrong or I visit an invalid URL,
**So that** I'm not confused by a blank white screen.

**Acceptance Criteria:**
- React ErrorBoundary wraps App with fallback UI
- Catch-all `*` route in App.tsx renders 404 page
- 404 page includes: Arkova branding, "Page not found" message, link to dashboard
- Error boundary includes: "Something went wrong" message, retry button, link to dashboard

**DoD:** No blank white screens for any URL or error condition.

---

#### MVP-06: File-Based Public Verification
**As a** verifier,
**I want** to drag-and-drop a file on the public verification page,
**So that** I can verify a document's authenticity without needing to know its record ID.

**Acceptance Criteria:**
- File drop zone added to PublicVerifyPage (when no publicId in URL)
- File is fingerprinted client-side (SHA-256 via existing `generateFingerprint`)
- Fingerprint is looked up via `get_public_anchor_by_fingerprint` RPC (new)
- If match found: display full verification result
- If no match: "No record found for this document"
- Original file never leaves the browser (Constitution 1.6)

**DoD:** User can verify by file OR by ID. Both paths show identical verification results.

---

### High-Priority Stories (Should complete before any external demo)

#### MVP-07: Mobile Responsive Layout
**As a** user on a mobile device,
**I want** the app to work on my phone,
**So that** I can check my records and verify documents anywhere.

**Acceptance Criteria:**
- Sidebar collapses to hamburger menu on screens < 768px
- Sheet/drawer pattern from shadcn/ui for mobile nav
- All pages render correctly at 375px width
- Touch-friendly tap targets (min 44x44px)

---

#### MVP-08: Onboarding Progress Stepper
**As a** new user going through onboarding,
**I want** to see how many steps remain,
**So that** I know what to expect and don't abandon the process.

**Acceptance Criteria:**
- Step indicator (1/3, 2/3, 3/3) shown during onboarding
- Steps: Role Selection → Organization Setup (if ORG_ADMIN) → Confirmation
- Visual progress bar or stepper component

---

#### MVP-09: Records Pagination + Search
**As a** user with many records,
**I want** to paginate and search my records,
**So that** I can find specific documents quickly.

**Acceptance Criteria:**
- Cursor-based pagination in RecordsList (25 per page)
- Search by filename, credential type, or status
- Sort by date, status, or name

---

#### MVP-10: Marketing Website (arkova.ai)
**As a** prospective customer,
**I want** to learn about Arkova on a professional marketing website,
**So that** I understand the value proposition before signing up.

**Acceptance Criteria:**
- Deployed at arkova.ai (or arkova.io)
- Sections: Hero, How It Works (3 steps), Features, Trust/Security, Pricing, CTA
- Design inspired by SimpleProof (clean, minimal, trust-focused)
- Links to app (app.arkova.ai or app.arkova.io)
- Mobile responsive

See Section 6 of this audit for detailed design spec.

---

### Deferred Stories (Post-testnet, pre-production)

#### MVP-11: Stripe Plan Change/Downgrade
Same as CRIT-3 remainder. Handle `customer.subscription.updated` + `customer.subscription.deleted`.

#### MVP-12: Dark Mode Toggle
Add toggle in Header or Settings. CSS tokens already exist.

#### MVP-13: Organization Logo Upload
Allow ORG_ADMIN to upload org logo. Display on credentials and public verification.

#### MVP-14: Embeddable Verification Widget (P6-TS-03)
Bundle VerificationWidget.tsx as standalone JS embed. Existing code, needs route + build config.

---

## 5. DOCUMENTATION UPDATES NEEDED

| Document | What Needs Updating |
|----------|-------------------|
| CLAUDE.md Section 8 | Add MVP-01 through MVP-10 stories, update gap status |
| CLAUDE.md Section 9 | Update sprint plan with new stories |
| MEMORY.md | Update current focus, add gap analysis reference |
| docs/stories/00_stories_index.md | Add new MVP stories to index |
| docs/stories/11_mvp_launch_gaps.md | **NEW** — create gap stories document |
| docs/confluence/00_index.md | Add reference to audit report |
| All agents.md | Note new stories and their file targets |
| docs/bugs/bug_log.md | Add dead-link bug, toast gap, favicon gap |

---

## 6. MARKETING WEBSITE PLAN (arkova.ai)

### Inspired by SimpleProof, adapted for Arkova's positioning

**Tech Stack:** Astro or Next.js static export (separate repo: `arkova-marketing`). Tailwind CSS. Deploy to Vercel.

### Proposed Sections

#### 1. Navigation
- Logo (left) | About | Solution | Developers | Pricing | **Sign In** (right) | **Get Started** (CTA button)

#### 2. Hero
- Headline: **"Prove It. Permanently."**
- Subtext: "Secure your documents with tamper-proof cryptographic fingerprints anchored to the Bitcoin network. Your documents never leave your device."
- CTA: **"Start Securing Documents"** + **"See How It Works"**
- Background: Subtle gradient (Ice Blue → white) with abstract geometric pattern

#### 3. Trust Bar
- "Trusted by organizations for document integrity"
- Logo row: placeholder for early customers/partners

#### 4. How It Works (3 Steps — sticky scroll like SimpleProof)
1. **Fingerprint** — "A unique cryptographic fingerprint is computed in your browser. Your document never leaves your device."
2. **Anchor** — "The fingerprint is permanently recorded on the Bitcoin network, creating an immutable timestamp."
3. **Verify** — "Anyone can verify a document's authenticity instantly — no account required."

Each step with illustration/animation.

#### 5. Features Grid (4 cards)
- **Privacy First** — Documents never leave your device
- **Bitcoin Anchored** — Secured by the most resilient network
- **Instant Verification** — Verify in seconds, no account needed
- **Enterprise Ready** — Organization management, bulk upload, webhooks

#### 6. Use Cases
- **Academic Credentials** — Universities issuing tamper-proof diplomas
- **Legal Documents** — Contracts with provable timestamps
- **Compliance Records** — Regulatory evidence that can't be altered
- **Digital Certificates** — Professional certifications verified instantly

#### 7. For Developers (preview of P4.5)
- "Coming Soon: Verification API"
- Code snippet showing API usage
- Link to waitlist/signup

#### 8. Pricing
- **Free** — 10 records/month, basic verification
- **Professional** — 100 records/month, priority anchoring, webhooks
- **Enterprise** — Unlimited, custom SLA, dedicated support

#### 9. CTA
- "Ready to prove it?" + Sign up button

#### 10. Footer
- Sitemap, Legal links, Social (Twitter/X, LinkedIn, GitHub)
- "Arkova - Secure Document Verification" + copyright

### Color Palette (from existing brand)
- Primary: Steel Blue `#82b8d0`
- Dark: Charcoal `#303433`
- Light: Ice Blue `#dbeaf1`
- Accent: White
- Text: Charcoal on light backgrounds, White on dark

---

## 7. NEXT STEPS — PRIORITIZED

### Phase A: Testnet MVP (1-2 weeks)
_Goal: Full user flow working on Signet testnet, demoable_

1. **MVP-04: Brand assets** — Design logo, favicon, OG tags (Day 1)
2. **MVP-05: Error boundary + 404** — Quick wins (Day 1)
3. **MVP-02: Toast system** — Sonner integration (Day 1-2)
4. **MVP-03: Legal pages** — Even placeholder content (Day 2)
5. **MVP-01: Deploy worker** — Railway/Fly.io + Supabase staging (Day 2-4)
6. **MVP-06: File-based verification** — Core differentiator (Day 3-5)
7. **Full flow test** — Upload → Signet anchor → Public verify (Day 5-6)

### Phase B: Demo Ready (Week 2-3)
_Goal: Can show to investors, early customers_

8. **MVP-07: Mobile responsive** (Day 7-8)
9. **MVP-08: Onboarding stepper** (Day 8)
10. **MVP-09: Records pagination** (Day 8-9)
11. **MVP-10: Marketing website** (Day 9-14, can parallel)
12. **MVP-11: Stripe plan changes** — CRIT-3 remainder (Day 10-12)

### Phase C: Phase 1.5 + P8 (Week 4+)
_Goal: API monetization + AI credential intelligence_

13. P4.5 Verification API (13 stories)
14. P8 AI Implementation (from story cards doc)
15. DH hardening stories (as needed for stability)

### Immediate Action Items (Today)

- [ ] Create the logo (can you provide the Arkova logo files, or should I design one?)
- [ ] Install Sonner: `npm install sonner`
- [ ] Create 404 page component
- [ ] Create ErrorBoundary component
- [ ] Create placeholder /privacy, /terms, /contact pages
- [ ] Update `index.html` with meta tags
- [ ] Decide on worker hosting (Railway? Fly.io? EC2?)

---

_Audit complete. 10 gaps identified, 14 stories written, 3-phase execution plan outlined._
_Total effort estimate: ~2-3 weeks to testnet MVP, ~4-5 weeks to demo ready._
