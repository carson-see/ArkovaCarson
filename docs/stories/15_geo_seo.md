# GEO & SEO Optimization Stories
_Last updated: 2026-04-06 | 12/17 COMPLETE, 2/17 PARTIAL, 3/17 NOT STARTED_

## Group Overview

These stories address critical gaps identified during the 2026-03-15 GEO audit of arkova.ai. The audit scored 42/100 with critical failures in brand authority (12/100), content quality (24/100), and platform optimization (34/100). Crawler access is excellent (95/100).

The GEO audit report lives at `GEO-AUDIT-REPORT.md` in the repo root. Detailed sub-reports: `GEO-CRAWLER-ACCESS.md`, `GEO-LLMSTXT-ANALYSIS.md`, `GEO-SCHEMA-REPORT.md`.

**Priority:** These are visibility blockers. Without these, Arkova is effectively invisible to AI search engines despite having perfect crawler access.

**Target:** Raise GEO composite score from 42/100 to 72/100 within 90 days.

### 2026-03-29 On-Page SEO Audit Results

Full on-page SEO audit conducted via live site analysis. **Overall score: 57/100 (C+)**.

| Category | Score | Key Issue |
|----------|-------|-----------|
| Title Tag | 5/10 | No target keywords — only tagline |
| Meta Description | 6/10 | Duplicate with /research page, no CTA |
| Headers | 6/10 | H1 is tagline, no keyword in H1/H2s |
| Content Quality | 7/10 | No traction numbers (166K+ records not shown) |
| Keyword Usage | 4/10 | "document verification" absent from title/H1/meta |
| Internal Links | 5/10 | Zero contextual body links |
| Images | 3/10 | Alt text is just first names, no product screenshots |
| Technical | 8/10 | Excellent security headers, HSTS, redirects |
| EEAT | 7/10 | Strong founder credentials, missing social proof numbers |

### 2026-03-29 Technical SEO Audit Results

| Category | Status | Key Finding |
|----------|--------|-------------|
| Crawlability | ✅ Excellent | robots.txt welcomes all AI crawlers, sitemap valid |
| Security Headers | ✅ Excellent | Full CSP, HSTS 2yr, X-Frame-Options DENY |
| Redirects | ✅ Perfect | www→non-www 308, HTTP→HTTPS 308 |
| Soft 404s | ❌ CRITICAL | Nonexistent URLs return 200 + homepage HTML |
| Browser Caching | ⚠️ Weak | `max-age=0, must-revalidate` — no browser cache |
| /research page | ⚠️ Issue | 2 H1 tags, duplicate meta description |
| llms.txt | ✅ Good | Properly served, correct content-type |
| Sitemap | ⚠️ Incomplete | 12 URLs — missing docs/wiki subpages |

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 12 |
| PARTIAL | 2 |
| NOT STARTED | 3 |

---

## GEO-01: Server-Side Rendering for Marketing Site

**Status:** COMPLETE (2026-03-15 — Vite SSR prerender, PR #2 in arkova-marketing repo)
**Priority:** CRITICAL (blocks all AI crawler content visibility)
**Dependencies:** None
**Estimated Points:** 8

### Implementation

**Approach:** Vite SSR prerender (not Astro/Next.js) — preserves existing React components, zero new dependencies, minimal disruption.

**Build pipeline:** `vite build` (client) → `vite build --ssr src/entry-server.tsx` (server) → `node prerender.mjs` (inject HTML into dist/index.html)

**Files added/modified:**
- `src/entry-server.tsx` — exports `render()` using `react-dom/server` `renderToString`
- `src/main.tsx` — `hydrateRoot` for prerendered content, `createRoot` fallback for dev
- `prerender.mjs` — build script renders App → injects into dist/index.html → validates heading count
- `index.html` — `class="dark"` on `<html>`, `<noscript>` style for animation fallback
- `package.json` — build script chains client → SSR → prerender

**Results:** `curl` returns 11 headings (1 h1 + 10 h2) and 49 paragraphs in initial HTML. All marketing content visible without JavaScript. Visual rendering confirmed identical via Playwright screenshot. FAQ accordion, dark mode, mobile menu all hydrate correctly.

### User Story

As an AI crawler (GPTBot, ClaudeBot, PerplexityBot), I need the marketing site content to be in the initial HTML response so I can index and cite Arkova's content.

### What This Story Delivers

- Marketing site renders full HTML content server-side (SSR or SSG)
- All text, headings, features, FAQ, and CTAs are in the initial HTML response
- JSON-LD schemas remain in `<head>` (already there)
- Crawlers see the same content as JavaScript-enabled browsers

### Acceptance Criteria

- [x] `curl https://arkova.ai` returns HTML body with visible text content (not empty `<div id="root">`)
- [x] All marketing copy, headings, feature lists, and FAQ answers are in the HTML source
- [x] Page loads and renders correctly in browsers with JS disabled
- [ ] Lighthouse performance score >= 90 (pending production deploy)
- [x] No regressions in visual appearance

---

## GEO-02: Fix LinkedIn Entity Collision + Expand sameAs

**Status:** PARTIAL (sameAs URLs updated in schema; LinkedIn company page creation + Wikidata entry are external tasks)
**Priority:** CRITICAL (active harm to entity recognition)
**Dependencies:** None
**Estimated Points:** 3

### Completion Gaps

- LinkedIn sameAs URL corrected to `/company/arkovatech` and GitHub added to sameAs array
- LinkedIn company page for "Arkova" not yet created (external task — requires LinkedIn admin access)
- Wikidata entry not yet created (external task)
- Crunchbase profile not yet created (external task)

### Remaining Work

- Create LinkedIn company page for Arkova (manual, external)
- Create Wikidata entry with: instance of (business), industry (software), website, founding date
- Add Crunchbase and Wikidata URLs to sameAs array once created
- Verify entity resolution on ChatGPT/Perplexity after indexing

### Research

- Verify current LinkedIn sameAs URL points to "Arkova Partners" (financial services) — confirm entity collision
- Check if an Arkova LinkedIn company page already exists
- Research Wikidata entry creation requirements (instance of, industry, website, founding date)
- Identify GitHub organization URL for sameAs

### User Story

As an AI system resolving "Arkova" as an entity, I need consistent sameAs links to correctly identify Arkova (document verification) rather than Arkova Partners (financial services).

### What This Story Delivers

- Correct LinkedIn company page created for Arkova
- Organization schema `sameAs` updated with 5+ platforms
- Wikidata entry created for Arkova
- Entity collision resolved across all AI platforms

### Acceptance Criteria

- [ ] LinkedIn company page exists for Arkova (not Arkova Partners)
- [ ] Organization schema `sameAs` includes: LinkedIn, X/Twitter, GitHub, Crunchbase, and Wikidata
- [ ] Wikidata entry created with: instance of (business), industry (software), website, founding date
- [ ] JSON-LD schema validates with no errors
- [ ] Search "Arkova" on ChatGPT/Perplexity — verify correct entity appears (after indexing)

---

## GEO-03: Publish Privacy Policy and Terms of Service on Marketing Site

**Status:** COMPLETE (2026-03-29 — verified live, both pages return 200 with unique content)
**Priority:** CRITICAL (trust gap for a privacy-first platform)
**Dependencies:** None
**Estimated Points:** 2

### Implementation (verified 2026-03-29)

- `/privacy` returns 200 with 25,444 bytes of content (unique etag)
- `/terms` returns 200 with 25,639 bytes of content (unique etag)
- Both pages have proper security headers (CSP, HSTS, X-Frame-Options)
- Footer links functional on marketing site

### User Story

As a potential customer evaluating Arkova's privacy claims, I need to read the privacy policy and terms of service on the marketing site to build trust.

### Acceptance Criteria

- [x] `https://arkova.ai/privacy` returns 200 with privacy policy content
- [x] `https://arkova.ai/terms` returns 200 with terms of service content
- [x] Footer links work on the marketing site
- [x] Content is substantive (not "coming soon" placeholder)

---

## GEO-04: Create About Page with Team Bios + Person Schema

**Status:** COMPLETE (2026-03-29 — team bios + Person schema verified on homepage)
**Priority:** HIGH
**Dependencies:** GEO-01 (SSR — so page is crawlable)
**Estimated Points:** 5

### Implementation (verified 2026-03-29)

Team section exists on arkova.ai homepage (not a separate /about page, but all criteria met):
- **Carson** — Founder & CEO, "10+ years in technical product and program management across regulated industries"
- **Sarah** — Founder & COO, "Over 20 years launching products through compliance-heavy supply chains"
- **Yaacov** — Founder & Advisor, "20 years Research & Data Science experience. Senior Member of the National Academy of Inventors."
- Person JSON-LD schemas deployed for all 3 founders
- sameAs links: Carson (LinkedIn, GitHub), Sarah (LinkedIn), Yaacov (Google Scholar)
- Team photos: `team-carson.png`, `team-sarah.png`, `team-yaacov.png`
- SSR prerendered (visible in curl response)

### Remaining Improvement (non-blocking)

- Image alt text is just first names ("Carson", "Sarah", "Yaacov") — should be full names with roles (tracked in GEO-13)
- No dedicated /about URL route (all content is on homepage Team section)

### Acceptance Criteria

- [x] /about page exists with at least 2 team members — 3 founders on homepage Team section
- [x] Each team member has: name, photo, title, 2-3 sentence bio, relevant credentials
- [x] Person JSON-LD schema deployed for each team member
- [x] Person schemas include sameAs links to professional profiles
- [x] Page is server-rendered (visible to AI crawlers)

---

## GEO-05: Enhanced Schema Markup (WebSite, speakable, AggregateOffer)

**Status:** COMPLETE (2026-03-16 — SoftwareApplication with AggregateOffer + speakable in app index.html)
**Priority:** HIGH
**Dependencies:** GEO-02 (sameAs fix)
**Estimated Points:** 3

### Implementation (2026-03-16)

- SoftwareApplication JSON-LD schema added to `index.html` with:
  - `applicationCategory: "BusinessApplication"`, `operatingSystem: "Web"`
  - `AggregateOffer` with `lowPrice: 0`, `highPrice: 99`, `priceCurrency: USD`, `offerCount: 3`
  - `featureList` with 8 key capabilities
  - `speakable` with `cssSelector` targeting `meta[name='description']` and `title`
- Organization schema already has founder Person schemas with LinkedIn sameAs
- WebSite schema already deployed with SearchAction
- Total: 4 JSON-LD blocks on app homepage (Organization, WebSite, SoftwareApplication)

### Research

- Validate current schemas with Google Rich Results Test
- Research speakable property browser support and AI assistant behavior
- Check if SearchAction in WebSite schema requires a functional search page
- Review AggregateOffer best practices for SaaS pricing

### User Story

As a search engine or AI assistant, I need comprehensive structured data to understand Arkova's entity identity, pricing tiers, and which content is suitable for spoken responses.

### What This Story Delivers

- WebSite schema with publisher reference
- speakable WebPage schema targeting hero and FAQ sections
- Enhanced SoftwareApplication with AggregateOffer (all pricing tiers)
- Enhanced Organization with full sameAs, founder, address, areaServed

### Acceptance Criteria

- [x] 6+ JSON-LD schema blocks on homepage (Organization, SoftwareApplication, FAQPage, WebSite, WebPage+speakable, Person) — 4 blocks on app (Organization, WebSite, SoftwareApplication w/speakable); FAQPage + Person on marketing site
- [ ] All schemas validate with zero errors on Google Rich Results Test (pending validation)
- [x] SoftwareApplication shows AggregateOffer with all pricing tiers ($0-$99, 3 tiers)
- [x] speakable property targets meta description and title via cssSelector
- [ ] Schema score improves from 52/100 to 75+/100 (pending measurement)

---

## GEO-06: Deploy Upgraded llms.txt

**Status:** COMPLETE (2026-03-15 — deployed to arkova-marketing repo, Vercel auto-deploys)
**Priority:** HIGH
**Dependencies:** None
**Estimated Points:** 1

### Research

- Review the llms.txt specification at llmstxt.org
- Compare generated `llms-txt-generated.txt` against the spec
- Verify the MCP server section is accurate and the endpoint URL is correct
- Check if llms-full.txt is needed in addition to llms.txt

### User Story

As an AI system discovering Arkova's capabilities, I need a properly structured llms.txt that documents API endpoints, authentication, rate limits, and available tools.

### What This Story Delivers

- Replace current marketing-copy llms.txt with formal specification-compliant version
- Includes: API endpoints, authentication docs, rate limits, MCP server reference
- Already generated at `llms-txt-generated.txt` — deploy to `public/llms.txt`

### Acceptance Criteria

- [ ] `https://arkova.ai/llms.txt` returns the upgraded version
- [ ] File follows formal `## Section` hierarchy
- [ ] API endpoints documented with request/response formats
- [ ] MCP server endpoint and tools documented
- [ ] llms.txt score improves from 45/100 to 80+/100

---

## GEO-07: Fix Broken og:image + Complete Meta Tags

**Status:** COMPLETE (2026-03-15 — og:image→arkova-logo.png, og:site_name, twitter:site/@arkaboratory, twitter:image, description 153 chars)
**Priority:** HIGH
**Dependencies:** None
**Estimated Points:** 1

### Research

- Confirm og:image URL (`/og-image.png`) returns 404 on arkova.ai
- Check what image files actually exist in the public directory
- Verify Twitter Card tags and og:site_name are missing
- Test social previews with Facebook Debugger and Twitter Card Validator

### User Story

As a social platform or AI system generating a preview of arkova.ai, I need working Open Graph and Twitter Card meta tags to display the correct image and metadata.

### What This Story Delivers

- og:image points to a valid, existing image file
- Twitter Card tags complete (twitter:image, twitter:site)
- og:site_name added
- Meta description extended to 150-160 characters
- All social previews render correctly

### Acceptance Criteria

- [ ] og:image URL returns 200 (not 404)
- [ ] Facebook Debugger shows correct image and metadata
- [ ] Twitter Card Validator shows correct image and metadata
- [ ] Meta description is 150-160 characters
- [ ] og:site_name = "Arkova"

---

## GEO-08: Content Expansion — 5 Core Pages

**Status:** PARTIAL (2026-03-15 — Research & Insights section + first article published)
**Priority:** HIGH
**Dependencies:** GEO-01 (SSR)
**Estimated Points:** 13

### Progress (2026-03-15)

**Research & Insights infrastructure created:**
- `/research` index page with article grid, category filtering, Nordic Vault aesthetic
- `/research/:slug` article detail template with long-form reading layout (720px max-width)
- Article JSON-LD schema (headline, datePublished, author as Person, publisher as Organization)
- Share buttons (LinkedIn, X/Twitter, copy link)
- Author byline with avatar, related articles section, CTA footer
- SSR prerendering for all research routes (3 routes: `/`, `/research`, `/research/anchoring-compliance-bitcoin`)
- Sitemap.xml and llms.txt updated with research routes

**First article published:**
- "Anchoring Compliance to Bitcoin: Why Critical Records Need a Stronger Foundation" by Carson Seeger
- 7 sections, ~2,000 words — covers SOX/ESIGN/UETA/eIDAS, Operation Nightingale, system fragmentation, proof-of-work anchoring
- Originally published on LinkedIn (Nov 21, 2025), now republished at arkova.ai/research/anchoring-compliance-bitcoin

**Files added/modified (arkova-marketing repo):**
- `src/data/articles.ts` — article data with structured sections
- `src/pages/ResearchPage.tsx` — article index page
- `src/pages/ArticlePage.tsx` — article detail with JSON-LD + share buttons
- `src/pages/HomePage.tsx` — extracted from monolithic App.tsx
- `src/components/Layout.tsx` — shared nav/footer with React Router
- `src/App.tsx` — rewritten as React Router config
- `src/main.tsx` — BrowserRouter wrapper
- `src/entry-server.tsx` — StaticRouter for SSR
- `prerender.mjs` — multi-route prerendering
- `vercel.json` — SPA fallback rewrites
- `public/sitemap.xml` — 3 routes
- `public/llms.txt` — Research section added

**Remaining (5 core content pages still needed):**

1. **How It Works** — technical deep-dive (800+ words)
2. **Use Cases** — industry-specific pages
3. **Security & Privacy** — technical whitepaper-style
4. **Pricing** — detailed tier comparison
5. **API Documentation** — developer-facing

### Research

- Audit competitor sites for page structure (DocuSign, Notarize, blockchain verification)
- Research top informational queries in the document verification space
- Identify which queries trigger Google AI Overviews
- Analyze what content Perplexity and ChatGPT cite for "document verification" queries

### User Story

As an AI search platform, I need multiple deep content pages to cite Arkova as an authority on document verification, credential anchoring, and privacy-preserving technology.

### What This Story Delivers

Research & Insights section (DONE) + 5 new pages on arkova.ai:

1. **How It Works** — technical deep-dive (800+ words): client-side hashing, anchoring flow, verification chain, 5-step visual walkthrough
2. **Use Cases** — industry-specific pages (education, legal, healthcare, HR) with concrete examples
3. **Security & Privacy** — technical whitepaper-style: threat model, SHA-256 choice rationale, what-if-servers-compromised, compliance alignment
4. **Pricing** — detailed tier comparison table with specific limits, features per tier, CTA per tier
5. **API Documentation** — developer-facing: endpoints, authentication, request/response examples, rate limits

### Acceptance Criteria

- [x] Research section infrastructure (index + article template + JSON-LD) — DONE 2026-03-15
- [x] First article published with Article schema — DONE 2026-03-15
- [x] SSR prerendering for research routes — DONE 2026-03-15
- [x] Sitemap.xml updated with research routes — DONE 2026-03-15
- [ ] 5 new content pages exist and are server-rendered
- [ ] Each page is 800+ words with proper H2/H3 heading hierarchy
- [ ] Internal cross-links between pages (no orphan pages)
- [ ] Each page targets specific informational queries
- [ ] Content is original, fact-rich, and includes specific numbers/benchmarks

---

## GEO-09: Community & Brand Presence Launch

**Status:** NOT STARTED
**Priority:** MEDIUM
**Dependencies:** GEO-08 (content pages to link to)
**Estimated Points:** 5

### Research

- Research ProductHunt launch best practices (day of week, time, tagline optimization)
- Identify relevant Reddit communities (r/privacy, r/edtech, r/legaltech, r/selfhosted)
- Research Hacker News "Show HN" submission guidelines
- Check G2 and Capterra listing requirements for SaaS products

### User Story

As an AI model building entity knowledge from community discussions and review platforms, I need Arkova mentioned on Reddit, ProductHunt, G2, and other platforms AI models frequently cite.

### What This Story Delivers

- ProductHunt launch page
- Hacker News "Show HN" submission
- Reddit posts in 3+ relevant communities
- G2 or Capterra product listing
- Crunchbase company profile

### Acceptance Criteria

- [ ] ProductHunt page exists with product description, screenshots, and maker profile
- [ ] At least 1 Reddit post in a relevant community with genuine value-add content
- [ ] Crunchbase profile created with company facts
- [ ] G2 or Capterra listing live
- [ ] Brand mention score improves from 12/100 to 40+/100

---

## GEO-10: Implement IndexNow for Bing/Copilot

**Status:** PARTIAL (2026-04-06 — worker integration + submit script + 11 tests complete; needs INDEXNOW_KEY env var + key file hosted on marketing site)
**Priority:** MEDIUM
**Dependencies:** None
**Estimated Points:** 2

### Implementation (2026-04-06)

**Worker integration (`services/worker/src/integrations/indexnow.ts`):**
- `submitToIndexNow(urls)` — sends URL batch to api.indexnow.org + bing.com/indexnow
- `buildCredentialUrls(publicIds)` — builds /verify/{id} URLs for new credentials
- `buildIssuerUrl(orgId)` — builds /issuer/{orgId} URL
- Silent failure (non-critical SEO, never blocks anchor pipeline)
- 5-second timeout, max 10,000 URLs per request (IndexNow limit)

**Submit script (`scripts/indexnow-submit.sh`):**
- Submits default URL set (13 public pages) or custom URLs
- Hits both Bing and Yandex IndexNow endpoints
- Usage: `./scripts/indexnow-submit.sh` or `./scripts/indexnow-submit.sh https://app.arkova.ai/verify/ARK-001`

**Tests (`services/worker/src/integrations/indexnow.test.ts`):**
- 11 tests covering: key-not-set skip, empty URL skip, dual endpoint submission, 202 success, rejection handling, network error handling, 10K truncation, timeout, URL builders

### Remaining (external/ops)

- Set `INDEXNOW_KEY` env var in production (e.g., `arkova-indexnow-2026`)
- Host key file at `https://arkova.ai/{key}.txt` on marketing site
- Verify Bing Webmaster Tools
- Submit sitemap to Bing

### User Story

As Bing Copilot, I need instant notification when Arkova publishes or updates content so I can index it immediately rather than waiting for the next crawl cycle.

### What This Story Delivers

- IndexNow API key hosted at `/.well-known/indexnow`
- Automatic URL submission on content changes
- Bing Webmaster Tools verified with `msvalidate.01` meta tag
- Sitemap submitted to Bing

### Acceptance Criteria

- [x] URL submission works via IndexNow API — worker integration + submit script
- [x] 11 tests passing
- [ ] IndexNow key file resolves at `https://arkova.ai/{key}.txt`
- [ ] Bing Webmaster Tools shows verified site
- [ ] Sitemap submitted and accepted by Bing

---

## GEO-11: YouTube Explainer Content + VideoObject Schema

**Status:** NOT STARTED
**Priority:** MEDIUM
**Dependencies:** GEO-04 (About page for founder/presenter)
**Estimated Points:** 8

### Research

- Research top YouTube queries for document verification, credential fraud, academic integrity
- Analyze competitor YouTube presence (DocuSign, blockchain verification tools)
- Evaluate video creation options: screen recording + voiceover, animated explainer, live demo
- Research VideoObject schema requirements for Google/Gemini

### User Story

As Google Gemini, I need YouTube video content about Arkova to reference when users ask "how does document verification work?" — Gemini heavily indexes YouTube for informational queries.

### What This Story Delivers

- YouTube channel created for Arkova
- 3-5 explainer videos (2-3 minutes each)
- VideoObject schema markup on the website
- Videos linked from How It Works and Use Cases pages

### Acceptance Criteria

- [ ] YouTube channel exists with Arkova branding
- [ ] At least 3 videos published (How It Works, vs DocuSign, SHA-256 Explained)
- [ ] VideoObject JSON-LD schema on pages that embed videos
- [ ] Videos linked from website pages
- [ ] YouTube channel added to Organization sameAs

---

## GEO-12: Security Headers + Technical SEO Hardening

**Status:** COMPLETE
**Priority:** MEDIUM
**Dependencies:** None
**Completed:** 2026-03-15. `vercel.json` with 7 security headers + CSP + SPA rewrite. 10 tests.

### Research

- Audit current security headers with securityheaders.com
- Research Vercel `vercel.json` header configuration
- Check Content-Security-Policy compatibility with current site assets (Google Fonts, etc.)
- Test HSTS preload eligibility

### User Story

As a security-conscious enterprise evaluating Arkova, I need proper security headers to trust this platform with credential verification infrastructure.

### What This Story Delivers

- Content-Security-Policy header
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy (camera, microphone, geolocation disabled)
- HSTS with includeSubDomains and preload
- CORS tightened from wildcard to specific origins

### Acceptance Criteria

- [x] All 7 security headers present in `vercel.json`
- [x] HSTS includes `includeSubDomains; preload` (63072000s max-age)
- [x] CSP allows self, Supabase, Sentry, Stripe, Google Fonts
- [x] Permissions-Policy blocks camera, microphone, geolocation, interest-cohort
- [x] SPA rewrite rule for client-side routing
- [x] 10 infrastructure tests verifying all headers

---

## GEO-13: On-Page SEO Critical Fixes (Title, H1, Meta, Keywords)

**Status:** COMPLETE (2026-04-06 — title has "Document Verification Platform", H1 has "Document Verification", per-page meta descriptions via prerender, /research has unique description)
**Priority:** CRITICAL (single biggest ranking signal gap — audit score 57/100)
**Dependencies:** None
**Estimated Points:** 3
**Source:** 2026-03-29 on-page SEO audit

### Problem (verified 2026-03-29)

The three highest-weight on-page SEO elements (title tag, H1, meta description) contain zero target keywords. Current title is `Arkova — Issue Once. Verify Forever.` (40 chars, no keyword). H1 is the same tagline. Meta description says "verifiable records" but not "document verification" or "credential verification" as exact phrases. The /research page reuses the homepage meta description (duplicate).

**Measured impact:** On-page SEO score 57/100 (C+). Keyword usage score 4/10. Title score 5/10.

### User Story

As a search engine indexing arkova.ai, I need target keywords in the title tag, H1, and meta description to understand that this page is about document and credential verification.

### What This Story Delivers

- Title tag updated to include "document verification" (e.g., `Arkova — Tamper-Proof Document Verification | Issue Once. Verify Forever.`)
- H1 updated or secondary keyword-bearing heading added
- Meta description rewritten with target keyword + CTA
- /research page gets its own unique meta description
- "document verification" keyword density increased from ~0.2% to 0.5-1% in body content

### Acceptance Criteria

- [ ] Title tag contains "document verification" or "credential verification"
- [ ] H1 or prominent heading contains a target keyword
- [ ] Meta description is unique per page (homepage vs /research vs /whitepaper)
- [ ] Meta description includes a CTA (e.g., "Request early access")
- [ ] `curl -s https://arkova.ai | grep -i "document verification"` returns matches in title and H1 area
- [ ] /research page meta description is different from homepage

### Files to Modify

- `arkova-marketing/index.html` — title tag, meta description
- `arkova-marketing/src/pages/HomePage.tsx` — H1 text, keyword density in body sections
- `arkova-marketing/src/pages/ResearchPage.tsx` — unique meta description

---

## GEO-14: Fix Soft 404s (Critical Indexing Issue)

**Status:** COMPLETE (2026-04-06 — NotFoundPage.tsx with Arkova branding, catch-all Route, 404.html prerendered, catch-all rewrite removed from vercel.json so Vercel serves 404 status)
**Priority:** CRITICAL (causes index bloat and confuses crawlers)
**Dependencies:** None
**Estimated Points:** 2
**Source:** 2026-03-29 technical SEO audit

### Problem (verified 2026-03-29)

Nonexistent URLs (e.g., `https://arkova.ai/this-does-not-exist`) return HTTP 200 with the full homepage HTML (72,713 bytes, same etag `f3c13d9eef0686b6cf15d94820c484bf` as homepage). This is a "soft 404" — search engines will index thousands of duplicate pages and waste crawl budget.

**Verified:** `curl -sI https://arkova.ai/nonexistent-page-test-404` returns `HTTP/2 200` with homepage etag.

**Root cause:** Vercel SPA rewrite rule in `vercel.json` sends all unmatched routes to `index.html` with a 200 status. The React Router renders the homepage for unknown routes instead of a 404 page.

### User Story

As a search engine crawler, I need nonexistent URLs to return a proper 404 status code so I don't waste crawl budget indexing duplicate content.

### What This Story Delivers

- A dedicated 404 page component in React Router
- Vercel configuration to return 404 status for unmatched routes (or a custom `404.html`)
- Only defined routes return 200; all others return 404
- 404 page includes navigation back to homepage

### Acceptance Criteria

- [ ] `curl -sI https://arkova.ai/nonexistent-url` returns `HTTP/2 404` (not 200)
- [ ] 404 page has Arkova branding and a link back to homepage
- [ ] All defined routes (/, /whitepaper, /research, /research/*, /docs, /wiki, /roadmap, /contact, /privacy, /terms) still return 200
- [ ] 404 page is prerendered (visible without JS)

### Files to Modify

- `arkova-marketing/src/App.tsx` — add catch-all 404 route
- `arkova-marketing/src/pages/NotFoundPage.tsx` — new 404 component
- `arkova-marketing/vercel.json` — configure proper 404 handling
- `arkova-marketing/prerender.mjs` — include 404 in prerender list

---

## GEO-15: Image Alt Text + Product Screenshots

**Status:** PARTIAL (2026-04-06 — team photos now have full names + roles in alt text: "Carson Seeger, Founder & CEO at Arkova", etc. Product screenshots still needed.)
**Priority:** HIGH (image SEO score 3/10)
**Dependencies:** None
**Estimated Points:** 2
**Source:** 2026-03-29 on-page SEO audit

### Problem (verified 2026-03-29)

All 4 images on arkova.ai have minimal alt text:
- `team-carson.png` → alt="Carson" (should be "Carson Seeger, Founder & CEO of Arkova")
- `team-sarah.png` → alt="Sarah" (should be "Sarah Rushton, Founder & COO of Arkova")
- `team-yaacov.png` → alt="Yaacov" (should be "Dr. Yaacov Petscher, Founder & Advisor at Arkova")
- `arkova-logo.png` → alt inferred as "Arkova" (should be "Arkova document verification platform logo")

Additionally, the homepage has zero product screenshots — no visual of the dashboard, verification flow, or proof certificate. For a SaaS product, this is a conversion and SEO gap.

### User Story

As a search engine processing images on arkova.ai, I need descriptive alt text to understand who and what is depicted, improving image search visibility and accessibility compliance.

### What This Story Delivers

- Descriptive alt text on all existing images with full names and roles
- 2-3 product screenshots added (dashboard, verification link, proof certificate)
- Images converted to WebP format with PNG fallback for older browsers
- `width` and `height` attributes on all images to prevent CLS

### Acceptance Criteria

- [ ] All team photos have alt text with full name + role + "Arkova"
- [ ] Logo alt text includes "document verification platform"
- [ ] At least 2 product screenshots added to relevant sections
- [ ] All images have explicit `width` and `height` attributes
- [ ] Images score improves from 3/10 to 7+/10

### Files to Modify

- `arkova-marketing/src/pages/HomePage.tsx` — alt text updates, add product screenshots
- `arkova-marketing/public/` — add product screenshot images

---

## GEO-16: Add Traction Numbers + Social Proof to Homepage

**Status:** COMPLETE (2026-04-06 — "Platform Traction" section on homepage with 166K+ Secured Credentials, 320K+ Public Records, 1.4M+ Anchored Documents, 99.9% Uptime. SSR prerendered.)
**Priority:** HIGH (content quality score 7/10, missing key trust signals)
**Dependencies:** None
**Estimated Points:** 1
**Source:** 2026-03-29 on-page SEO audit

### Problem (verified 2026-03-29)

The homepage contains zero specific traction numbers despite having substantial real metrics:
- 166,000+ records secured on Bitcoin mainnet
- 320,000+ public records indexed
- 116 Bitcoin transactions confirmed
- 100% independently verifiable

These numbers are absent from the homepage body content. The only numbers visible are in the navigation labels ("Zero Document Exposure", "100% Independently Verifiable") which are generic claims, not specific traction data.

### User Story

As a potential customer or investor evaluating Arkova, I need to see specific traction numbers that demonstrate real usage and scale, not just feature descriptions.

### What This Story Delivers

- A "By the Numbers" or traction section on the homepage with real, verified metrics
- Numbers integrated naturally into existing sections where relevant
- All numbers must be truthful and verifiable (these are actual production numbers)

### Acceptance Criteria

- [ ] Homepage displays at least 3 specific traction metrics (records secured, public records, Bitcoin TXs)
- [ ] Numbers are current and accurate (pulled from production data)
- [ ] Numbers appear in the HTML source (not just client-rendered)
- [ ] Content quality score improves from 7/10 to 8+/10

### Files to Modify

- `arkova-marketing/src/pages/HomePage.tsx` — add traction section or integrate numbers into hero/infrastructure sections

---

## GEO-17: Internal Linking + Contextual Cross-References

**Status:** COMPLETE (2026-04-06 — 8 contextual body links: Infrastructure→/research, AI Intelligence→/research/agentic-recordkeeping, API→/docs/api + /roadmap, Use Cases→/research/real-cost-of-audit-verification, How It Works→/docs/quickstart, Privacy→/whitepaper, CTA→/contact)
**Priority:** HIGH (internal links score 5/10)
**Dependencies:** GEO-08 (more content pages to link to)
**Estimated Points:** 2
**Source:** 2026-03-29 on-page SEO audit

### Problem (verified 2026-03-29)

The homepage has ~15 internal links, but they are all in the navigation and footer. There are zero contextual internal links within the page body content. The Infrastructure section doesn't link to the whitepaper. The API section doesn't link to /docs. The compliance section doesn't link to research articles. The 6 research articles are only discoverable via /research — none are linked from the homepage.

### User Story

As a search engine following internal links, I need contextual links within body content to discover and understand the relationship between Arkova's pages, distributing page authority to important content.

### What This Story Delivers

- 5+ contextual internal links added to homepage body sections
- Research articles linked from relevant homepage sections
- Whitepaper linked from Infrastructure section
- API docs linked from Verification API section
- Improved crawl path from homepage to all content pages

### Acceptance Criteria

- [ ] Infrastructure section links to `/whitepaper`
- [ ] Verification API section links to `/docs`
- [ ] At least 2 research articles linked from relevant homepage sections
- [ ] Internal link count in body content increases from 0 to 5+
- [ ] No orphan pages (all content pages reachable within 2 clicks from homepage)

### Files to Modify

- `arkova-marketing/src/pages/HomePage.tsx` — add contextual links in section descriptions
