# GEO & SEO Optimization Stories
_Last updated: 2026-03-15 | 2/12 COMPLETE, 2/12 PARTIAL, 8/12 NOT STARTED_

## Group Overview

These stories address critical gaps identified during the 2026-03-15 GEO audit of arkova.ai. The audit scored 42/100 with critical failures in brand authority (12/100), content quality (24/100), and platform optimization (34/100). Crawler access is excellent (95/100).

The GEO audit report lives at `GEO-AUDIT-REPORT.md` in the repo root. Detailed sub-reports: `GEO-CRAWLER-ACCESS.md`, `GEO-LLMSTXT-ANALYSIS.md`, `GEO-SCHEMA-REPORT.md`.

**Priority:** These are visibility blockers. Without these, Arkova is effectively invisible to AI search engines despite having perfect crawler access.

**Target:** Raise GEO composite score from 42/100 to 72/100 within 90 days.

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 2 |
| PARTIAL | 2 |
| NOT STARTED | 8 |

---

## GEO-01: Server-Side Rendering for Marketing Site

**Status:** NOT STARTED
**Priority:** CRITICAL (blocks all AI crawler content visibility)
**Dependencies:** None
**Estimated Points:** 8

### Research

- Evaluate SSR/SSG options: Astro (recommended for marketing), Next.js SSG, Vite prerender plugin, react-snap
- Benchmark: fetch `https://arkova.ai` with `curl` and verify HTML body contains actual content (not just `<div id="root"></div>`)
- Test with Google's Mobile-Friendly Test URL rendering tool
- Check if Vercel supports prerendering for the current Vite setup

### User Story

As an AI crawler (GPTBot, ClaudeBot, PerplexityBot), I need the marketing site content to be in the initial HTML response so I can index and cite Arkova's content.

### What This Story Delivers

- Marketing site renders full HTML content server-side (SSR or SSG)
- All text, headings, features, FAQ, and CTAs are in the initial HTML response
- JSON-LD schemas remain in `<head>` (already there)
- Crawlers see the same content as JavaScript-enabled browsers

### Acceptance Criteria

- [ ] `curl https://arkova.ai` returns HTML body with visible text content (not empty `<div id="root">`)
- [ ] All marketing copy, headings, feature lists, and FAQ answers are in the HTML source
- [ ] Page loads and renders correctly in browsers with JS disabled
- [ ] Lighthouse performance score >= 90
- [ ] No regressions in visual appearance

---

## GEO-02: Fix LinkedIn Entity Collision + Expand sameAs

**Status:** PARTIAL (sameAs URLs updated in schema; LinkedIn company page creation + Wikidata entry are external tasks)
**Priority:** CRITICAL (active harm to entity recognition)
**Dependencies:** None
**Estimated Points:** 3

### Completion Gaps

- LinkedIn sameAs URL corrected to `/company/arkovatech` and GitHub added to sameAs array
- LinkedIn company page for "Arkova Technologies, Inc." not yet created (external task — requires LinkedIn admin access)
- Wikidata entry not yet created (external task)
- Crunchbase profile not yet created (external task)

### Remaining Work

- Create LinkedIn company page for Arkova Technologies, Inc. (manual, external)
- Create Wikidata entry with: instance of (business), industry (software), website, founding date
- Add Crunchbase and Wikidata URLs to sameAs array once created
- Verify entity resolution on ChatGPT/Perplexity after indexing

### Research

- Verify current LinkedIn sameAs URL points to "Arkova Partners" (financial services) — confirm entity collision
- Check if an Arkova Technologies LinkedIn company page already exists
- Research Wikidata entry creation requirements (instance of, industry, website, founding date)
- Identify GitHub organization URL for sameAs

### User Story

As an AI system resolving "Arkova" as an entity, I need consistent sameAs links to correctly identify Arkova Technologies, Inc. (document verification) rather than Arkova Partners (financial services).

### What This Story Delivers

- Correct LinkedIn company page created for Arkova Technologies, Inc.
- Organization schema `sameAs` updated with 5+ platforms
- Wikidata entry created for Arkova Technologies, Inc.
- Entity collision resolved across all AI platforms

### Acceptance Criteria

- [ ] LinkedIn company page exists for Arkova Technologies, Inc. (not Arkova Partners)
- [ ] Organization schema `sameAs` includes: LinkedIn, X/Twitter, GitHub, Crunchbase, and Wikidata
- [ ] Wikidata entry created with: instance of (business), industry (software), website, founding date
- [ ] JSON-LD schema validates with no errors
- [ ] Search "Arkova" on ChatGPT/Perplexity — verify correct entity appears (after indexing)

---

## GEO-03: Publish Privacy Policy and Terms of Service on Marketing Site

**Status:** NOT STARTED
**Priority:** CRITICAL (trust gap for a privacy-first platform)
**Dependencies:** None
**Estimated Points:** 2

### Research

- Confirm PrivacyPage and TermsPage exist in the app codebase (`src/pages/`)
- Determine whether to deploy these on arkova.ai or link to app.arkova.io versions
- Check if current /privacy and /terms URLs return 404 on arkova.ai

### User Story

As a potential customer evaluating Arkova's privacy claims, I need to read the privacy policy and terms of service on the marketing site to build trust.

### What This Story Delivers

- /privacy and /terms pages live on arkova.ai (not 404)
- Pages contain substantive legal content (not placeholder text)
- Footer links point to the correct URLs
- E-E-A-T trustworthiness score increases

### Acceptance Criteria

- [ ] `https://arkova.ai/privacy` returns 200 with privacy policy content
- [ ] `https://arkova.ai/terms` returns 200 with terms of service content
- [ ] Footer links work on the marketing site
- [ ] Content is substantive (not "coming soon" placeholder)

---

## GEO-04: Create About Page with Team Bios + Person Schema

**Status:** NOT STARTED
**Priority:** HIGH
**Dependencies:** GEO-01 (SSR — so page is crawlable)
**Estimated Points:** 5

### Research

- Identify all team members to feature (founders, advisors, key team)
- Research Person schema best practices for E-E-A-T
- Review competitor about pages (DocuSign, Notarize, blockchain verification services)
- Determine what credentials/expertise to highlight per team member

### User Story

As an AI model evaluating source credibility, I need to know who is behind Arkova and their relevant expertise to confidently cite this as an authoritative source.

### What This Story Delivers

- /about page with team bios, photos, and credentials
- Person JSON-LD schema for each team member
- Links to personal LinkedIn/GitHub/Twitter profiles
- Founded story and mission statement

### Acceptance Criteria

- [ ] /about page exists with at least 2 team members
- [ ] Each team member has: name, photo, title, 2-3 sentence bio, relevant credentials
- [ ] Person JSON-LD schema deployed for each team member
- [ ] Person schemas include sameAs links to professional profiles
- [ ] Page is server-rendered (visible to AI crawlers)

---

## GEO-05: Enhanced Schema Markup (WebSite, speakable, AggregateOffer)

**Status:** PARTIAL (WebSite schema deployed; speakable + AggregateOffer still pending)
**Priority:** HIGH
**Dependencies:** GEO-02 (sameAs fix)
**Estimated Points:** 3

### Completion Gaps

- WebSite JSON-LD schema deployed with publisher reference (4 schemas total on homepage)
- Missing: speakable WebPage schema (requires CSS selectors for hero/FAQ sections)
- Missing: AggregateOffer enhancement to SoftwareApplication schema (requires pricing tier details)
- Missing: Person schema for founder(s)

### Remaining Work

- Add speakable WebPage JSON-LD targeting `.hero-headline`, `.hero-subheadline`, `.value-proposition` CSS selectors
- Replace SoftwareApplication Offer with AggregateOffer including all 3 pricing tiers
- Add Person schema for founder(s) once team bios are finalized (GEO-04)
- Validate all schemas with Google Rich Results Test

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

- [ ] 6+ JSON-LD schema blocks on homepage (Organization, SoftwareApplication, FAQPage, WebSite, WebPage+speakable, Person)
- [ ] All schemas validate with zero errors on Google Rich Results Test
- [ ] SoftwareApplication shows AggregateOffer with all pricing tiers
- [ ] speakable property targets hero headline and FAQ sections
- [ ] Schema score improves from 52/100 to 75+/100

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

**Status:** NOT STARTED
**Priority:** HIGH
**Dependencies:** GEO-01 (SSR)
**Estimated Points:** 13

### Research

- Audit competitor sites for page structure (DocuSign, Notarize, blockchain verification)
- Research top informational queries in the document verification space
- Identify which queries trigger Google AI Overviews
- Analyze what content Perplexity and ChatGPT cite for "document verification" queries

### User Story

As an AI search platform, I need multiple deep content pages to cite Arkova as an authority on document verification, credential anchoring, and privacy-preserving technology.

### What This Story Delivers

5 new pages on arkova.ai:

1. **How It Works** — technical deep-dive (800+ words): client-side hashing, anchoring flow, verification chain, 5-step visual walkthrough
2. **Use Cases** — industry-specific pages (education, legal, healthcare, HR) with concrete examples
3. **Security & Privacy** — technical whitepaper-style: threat model, SHA-256 choice rationale, what-if-servers-compromised, compliance alignment
4. **Pricing** — detailed tier comparison table with specific limits, features per tier, CTA per tier
5. **API Documentation** — developer-facing: endpoints, authentication, request/response examples, rate limits

### Acceptance Criteria

- [ ] 5 new pages exist and are server-rendered
- [ ] Each page is 800+ words with proper H2/H3 heading hierarchy
- [ ] Sitemap.xml updated with all new pages
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

**Status:** NOT STARTED
**Priority:** MEDIUM
**Dependencies:** None
**Estimated Points:** 2

### Research

- Review IndexNow protocol specification (indexnow.org)
- Check Vercel/Cloudflare support for IndexNow key hosting
- Research if IndexNow can be automated on deploy (CI/CD integration)
- Verify Bing Webmaster Tools verification options

### User Story

As Bing Copilot, I need instant notification when Arkova publishes or updates content so I can index it immediately rather than waiting for the next crawl cycle.

### What This Story Delivers

- IndexNow API key hosted at `/.well-known/indexnow`
- Automatic URL submission on content changes
- Bing Webmaster Tools verified with `msvalidate.01` meta tag
- Sitemap submitted to Bing

### Acceptance Criteria

- [ ] IndexNow key file resolves at `https://arkova.ai/{key}.txt`
- [ ] URL submission works via IndexNow API
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

**Status:** NOT STARTED
**Priority:** MEDIUM
**Dependencies:** None
**Estimated Points:** 3

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

- [ ] securityheaders.com score is A or A+
- [ ] All 5 security headers present in HTTP response
- [ ] HSTS includes `includeSubDomains; preload`
- [ ] CORS is not wildcard (`*`)
- [ ] No functional regressions (fonts, images, API calls still work)
- [ ] Technical SEO score improves from 52/100 to 80+/100
