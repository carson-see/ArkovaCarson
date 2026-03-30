# GEO Audit Report: Arkova

**Audit Date:** 2026-03-28
**URL:** https://arkova.ai/
**Business Type:** SaaS (Document Verification Platform)
**Pages Analyzed:** 12

---

## Executive Summary

**Overall GEO Score: 51/100 (Poor)**

Arkova has built an unusually strong *technical* foundation for AI visibility -- perfect crawler access, a well-structured llms.txt, rich schema markup, and pre-rendered content. However, the site is severely held back by near-zero brand presence on platforms that AI models use for entity recognition and citation. The content quality is solid but thin (12 pages total), and the complete absence of external validation (no Wikipedia, no Reddit, no product review sites, no media coverage) means AI models have no basis to recognize Arkova as a notable entity. The path from 51 to 75+ requires distribution and content volume, not code changes.

### Score Breakdown

| Category | Score | Weight | Weighted Score |
|---|---|---|---|
| AI Citability | 62/100 | 25% | 15.5 |
| Brand Authority | 8/100 | 20% | 1.6 |
| Content E-E-A-T | 62/100 | 20% | 12.4 |
| Technical GEO | 82/100 | 15% | 12.3 |
| Schema & Structured Data | 78/100 | 10% | 7.8 |
| Platform Optimization | 15/100 | 10% | 1.5 |
| **Overall GEO Score** | | | **51/100** |

---

## Critical Issues (Fix Immediately)

### 1. Zero Brand Presence on AI-Cited Platforms
**Severity:** Critical
**Impact:** AI models cannot cite or recommend what they have never seen referenced by third parties.

| Platform | Status |
|---|---|
| Wikipedia | Absent -- no article, searches return unrelated results |
| Reddit | Absent -- zero mentions in r/legaltech, r/compliance, r/SaaS |
| Hacker News | Absent -- no Show HN, no comments |
| G2/Capterra/Trustpilot | Absent -- no product listings |
| Product Hunt | Absent -- no launch page |
| Google Scholar | Absent -- research articles not indexed |
| Industry Publications | Absent -- no third-party coverage |

**Fix:** Create Wikidata entity (already exists at Q138765025 -- verify completeness), launch on Product Hunt, submit to G2/Capterra, post Show HN, submit research to Google Scholar with academic metadata tags.

### 2. No Customer Case Studies or Testimonials
**Severity:** Critical
**Impact:** The E-E-A-T "Experience" dimension scores 11/25 -- the single largest content gap.

With 195K+ anchors and 166K SECURED records on mainnet, there must be usage data that can support case studies. Even anonymized narratives ("A mid-size audit firm reduced verification time by X%") would dramatically improve AI citation likelihood.

**Fix:** Publish at least 2 case studies with specific metrics (time saved, cost reduction, records anchored).

### 3. No Dedicated About Page
**Severity:** Critical
**Impact:** Both search engines and AI models use About pages as primary authority signals. Team bios on the homepage are not a substitute.

**Fix:** Create `/about` with company history, mission, team with full bios, advisory board, corporate registration, and partnerships.

---

## High Priority Issues

### 4. Research Articles Missing from Sitemap
Six research article URLs are pre-rendered and linked from `/research` but absent from `sitemap.xml`. AI crawlers that use sitemaps for discovery may miss these high-value pages.

**Fix:** Add all research article URLs to sitemap.xml.

### 5. No Physical Address or Phone Number
For a company in the compliance/legal verification space (YMYL-adjacent), contact completeness is a core trust signal. Only email is provided.

**Fix:** Add registered business address (Tallahassee, FL) and phone number to contact page and footer.

### 6. Schema Inconsistency Between App and Marketing Site
Organization schema on `app.arkova.ai` and `arkova.ai` have divergent data (address, sameAs, numberOfEmployees, logo format). AI models may see conflicting entity data.

**Fix:** Synchronize schemas -- use marketing site's @id structure with app's complete address and numberOfEmployees.

### 7. TechArticle Schema Not Linked via @id
Whitepaper TechArticle uses inline Person/Organization objects instead of referencing the @id-based entities already on the page. AI models see two separate entities instead of one connected graph.

**Fix:** Change to `"author": [{"@id": "https://arkova.ai/#carson-seeger"}]` and `"publisher": {"@id": "https://arkova.ai/#org"}`.

### 8. Missing Speakable on Article Pages
Only the homepage has `speakable` markup. Research articles and whitepaper lack it, reducing voice AI and AI Overview extraction signals.

**Fix:** Add `SpeakableSpecification` to all content pages targeting headlines and opening paragraphs.

### 9. No Author Pages
Team bios exist on homepage but no standalone author pages with full biographies, publication lists, and external links. This limits author entity profile building.

**Fix:** Create `/team/carson-seeger`, `/team/sarah-rushton`, etc. with full bios, linked from every article byline.

### 10. Missing Crunchbase Profile
Crunchbase is one of the most-cited sources for company information by AI models. Not listed in sameAs.

**Fix:** Create Crunchbase profile and add to Organization sameAs array.

---

## Medium Priority Issues

### 11. Content Volume Too Thin for Topical Authority
Only ~12 indexable pages across the entire site. Competitors in the compliance/verification space likely have 50-200+ pages. No topic clustering or hub-and-spoke structure.

**Fix:** Build topic clusters around each use case (talent verification, compliance, education, legal) with dedicated landing pages and 3-5 supporting articles each. Target 25-30+ pages.

### 12. Images Missing Alt Text and Dimensions
All images (logo, team photos) lack explicit `alt` text attributes and `width`/`height` HTML attributes, creating both accessibility and CLS (Cumulative Layout Shift) issues.

**Fix:** Add descriptive alt text and explicit dimensions to all `<img>` tags.

### 13. Google Fonts Render-Blocking
External Google Fonts stylesheet blocks first contentful paint, impacting LCP.

**Fix:** Self-host fonts or use `<link rel="preload" as="style">` pattern.

### 14. Footer Navigation Uses Buttons Instead of Links
"How It Works", "Features", "API", "Use Cases" in the footer use `<button>` elements instead of `<a>` tags. These are invisible to crawlers.

**Fix:** Convert to `<a href="#section-id">` elements.

### 15. No Editorial Standards Page
For a site publishing research articles, there's no visible policy on content review or fact-checking.

**Fix:** Create a brief editorial standards page describing review process.

### 16. FAQ Section Too Small
Only 7 FAQ entries. Expanding to 20+ would dramatically increase AI citation surface area, especially for long-tail queries.

**Fix:** Add questions matching real user queries: pricing, HIPAA compliance, competitor comparisons, offline scenarios, etc.

### 17. No Glossary/Definitions Page
Terms like "cryptographic fingerprinting," "Bitcoin anchoring," and "Merkle tree verification" are highly citable definitional content that AI models love to quote.

**Fix:** Create `/glossary` with 2-3 sentence definitions for key terms.

### 18. Sparse Internal Cross-Linking
Research articles don't cross-reference each other or link to specific whitepaper sections. No hub-and-spoke structure.

**Fix:** Add contextual internal links between related articles and whitepaper sections.

### 19. llms.txt Missing Version Dates and Examples
No version control, no update dates, no example request/response payloads.

**Fix:** Add version date, update cadence, and at least 2 API example payloads.

### 20. Missing BreadcrumbList on Most Subpages
Only the whitepaper has BreadcrumbList schema. Missing on research articles, contact, privacy, terms, roadmap.

**Fix:** Add BreadcrumbList to all subpages.

---

## Low Priority Issues

### 21. No `og:locale` Meta Tag
Minor international content signal missing.

### 22. No Responsive Image Strategy
No `srcset`, `<picture>`, or responsive images. All devices download same files.

### 23. Cache-Control `max-age=0`
Every request revalidates with origin. A short TTL (300s) would improve repeat-visit performance.

### 24. No `fetchpriority` Attributes
Hero content lacks `fetchpriority="high"` for browser prioritization.

### 25. HowTo Schema Deprecated
HowTo rich results removed by Google (Sep 2023). Schema provides marginal AI semantic value but zero search benefit.

### 26. SearchAction Target Requires Auth
WebSite SearchAction points to `app.arkova.ai/search` which requires login. Google won't enable sitelinks search box.

### 27. CSP Uses `unsafe-inline`
Common for Vite/React but weakens XSS protection on the marketing site.

---

## Category Deep Dives

### AI Citability (62/100)

**Strengths:**
- Privacy architecture statement is highly quotable: "Your files never leave your device -- zero bytes transmitted to any server"
- Audit cost research article has strong statistical density ($3M avg fees, 1,000+ hrs/year)
- FAQ schema markup provides structured Q&A extraction for AI models
- Competitive landscape section in whitepaper is excellent for comparison queries

**Top Citation-Ready Passages:**

| Passage | Score | Why |
|---|---|---|
| Meta description / privacy statement | 78/100 | Self-contained, distinctive, directly answers "What is Arkova?" |
| Audit cost statistics | 74/100 | High statistical density, specific dollar amounts and time figures |
| Whitepaper competitive analysis | 71/100 | Original positioning against named competitors |
| FAQ answers | 68/100 | Structured Q&A format ideal for AI extraction |
| Operation Nightingale reference | 65/100 | Real-world narrative anchor with regulatory context |

**Weaknesses:**
- Hero taglines ("Issue Once. Verify Forever.") score 22/100 -- marketing slogans are not citable
- Feature bullets without context score 28/100 -- too terse for AI extraction
- Team bios lack specific credentials and publication counts

**Recommendations:**
- Add statistical anchors to every content block (processing time, cost per anchor, formats supported, uptime SLA)
- Expand feature descriptions from bullet points to 2-3 sentence explanations
- Create `llms-full.txt` companion with complete product documentation
- Add a glossary page with definitional content for key terms

### Brand Authority (8/100)

This is the critical weakness. AI models build entity understanding from corroboration across multiple independent sources.

| Platform | Present? | Impact |
|---|---|---|
| Wikipedia | No | Highest-impact gap -- primary entity recognition source for all major AI models |
| Wikidata | Yes (Q138765025) | Positive but insufficient alone |
| Reddit | No | No discussions in any relevant subreddit |
| Hacker News | No | Missed opportunity for technical SaaS |
| Product Hunt | No | No launch or product page |
| G2/Capterra | No | No software review listings |
| LinkedIn | Minimal | Page exists but brand confusion with unrelated "Arkova" entities |
| YouTube | No content | Channel exists but no indexed videos |
| Google Scholar | No | Research articles not academically indexed |
| Industry media | No | No third-party coverage |

**The path forward:** This requires no code changes. It requires distribution -- Wikipedia/Wikidata entity completeness, Product Hunt launch, Hacker News post, G2 listing, and seeding discussions in relevant communities.

### Content E-E-A-T (62/100)

| Dimension | Score | Key Finding |
|---|---|---|
| Experience | 11/25 | No case studies, no before/after data, no deployment narratives |
| Expertise | 16/25 | Strong team credentials, technical depth in whitepaper, good schema markup |
| Authoritativeness | 13/25 | 6 research articles but no external citations, no media mentions, no About page |
| Trustworthiness | 18/25 | Excellent privacy policy, HTTPS, but no physical address, no editorial standards |

**Strongest asset:** Privacy policy -- genuinely distinctive, technically specific commitments that are not generic AI-generated content.

**Biggest gap:** Zero case studies despite 195K+ production records. This is the highest-ROI content investment.

### Technical GEO (82/100)

| Component | Score | Status |
|---|---|---|
| Server-Side Rendering | 85/100 | PASS -- full pre-rendered HTML, AI crawlers see 100% of content |
| Meta Tags & Indexability | 95/100 | PASS -- title, description, canonical, OG, Twitter Cards all present |
| Crawlability | 95/100 | PASS -- permissive robots.txt, sitemap, all AI crawlers welcomed |
| Security Headers | 95/100 | PASS -- HSTS, CSP, X-Frame-Options, all 7 critical headers |
| Core Web Vitals Risk | 55/100 | WARN -- no image dimensions (CLS risk), render-blocking fonts (LCP risk) |
| Mobile Optimization | 80/100 | PASS -- responsive design, but no responsive images |
| URL Structure | 90/100 | PASS -- clean, logical, short URLs |
| Response & Status | 90/100 | PASS -- 200 OK, Vercel edge cache, ETag validation |

**Standout:** The marketing site is fully pre-rendered (SSG via Vite), not a client-side SPA. All content visible to crawlers without JavaScript. This is best-practice for a marketing site backed by a React app.

### Schema & Structured Data (78/100)

| Schema Type | Status | Rich Result Eligible? |
|---|---|---|
| Organization (with sameAs to 5 platforms) | Valid | Yes (Knowledge Panel) |
| SoftwareApplication | Valid | Yes |
| FAQPage (7 Q&As) | Valid | Restricted (since Aug 2023) |
| WebSite + SearchAction | Valid | Yes (but search requires auth) |
| WebPage + speakable | Valid | N/A (GEO signal) |
| Person (3 founders) | Valid | Yes (Knowledge Panel) |
| HowTo (3 steps) | Valid | REMOVED (Sep 2023) |
| TechArticle (whitepaper) | Valid | Yes |
| BreadcrumbList | Valid | Yes |

**Standout:** Wikidata sameAs link in Organization schema is excellent for knowledge graph entity resolution.

**Key gaps:** TechArticle not linked via @id, speakable missing on article pages, BreadcrumbList only on whitepaper, schema divergence between app and marketing site.

### Platform Optimization (15/100)

| Platform | Readiness | Notes |
|---|---|---|
| Google AI Overviews | Low | Content exists but thin; FAQ schema helps but no featured snippets history |
| ChatGPT Web Search | Very Low | Zero external mentions means ChatGPT has no citation sources |
| Perplexity AI | Very Low | Same external mention gap; llms.txt helps with direct crawling |
| Google Gemini | Low | Schema helps but no YouTube content for multimodal signals |
| Bing Copilot | Very Low | No Bing-specific optimization, no LinkedIn content amplification |

---

## Quick Wins (Implement This Week)

1. **Add 6 research article URLs to sitemap.xml** -- 10 minutes of work, immediate crawl coverage improvement
2. **Add `width`/`height` attributes to all images** -- fixes CLS risk, 15 minutes
3. **Synchronize Organization schema** between app and marketing site -- 30 minutes
4. **Fix TechArticle to use @id references** for author/publisher -- 15 minutes
5. **Add BreadcrumbList schema to all subpages** -- 1 hour using the template provided

## 30-Day Action Plan

### Week 1: Foundation Fixes
- [ ] Add research articles to sitemap.xml
- [ ] Fix image alt text and dimensions across all pages
- [ ] Synchronize Organization schema between app and marketing site
- [ ] Fix TechArticle @id references
- [ ] Add BreadcrumbList to all subpages
- [ ] Add speakable to article and whitepaper pages
- [ ] Add version dates and examples to llms.txt
- [ ] Convert footer buttons to anchor links

### Week 2: Content Expansion
- [ ] Create dedicated About page (`/about`)
- [ ] Create author pages for Carson Seeger and Sarah Rushton
- [ ] Publish first customer case study (even anonymized)
- [ ] Expand FAQ from 7 to 15+ entries
- [ ] Create glossary/definitions page (`/glossary`)
- [ ] Add editorial standards page
- [ ] Add physical address to contact page and footer

### Week 3: External Distribution
- [ ] Launch on Product Hunt
- [ ] Submit to G2 and Capterra
- [ ] Create Crunchbase profile and add to sameAs
- [ ] Post Show HN about client-side document verification
- [ ] Post in relevant subreddits (r/legaltech, r/compliance, r/cryptography)
- [ ] Add Google Scholar metadata tags to research articles
- [ ] Submit research to Google Scholar

### Week 4: Content Depth
- [ ] Publish second case study
- [ ] Create industry-specific landing page (start with compliance use case)
- [ ] Publish 2 new blog/research articles targeting long-tail queries
- [ ] Add cross-links between all research articles and whitepaper
- [ ] Create llms-full.txt with complete documentation
- [ ] Record and publish first YouTube explainer video
- [ ] Self-host Google Fonts to eliminate render-blocking

---

## Appendix: Pages Analyzed

| URL | Title | GEO Issues |
|---|---|---|
| https://arkova.ai/ | Arkova -- Issue Once. Verify Forever. | Images missing alt/dimensions, footer buttons not crawlable, render-blocking fonts |
| https://arkova.ai/research | Research & Insights | Missing from sitemap (hub page), same base issues |
| https://arkova.ai/research/anchoring-compliance-bitcoin | Anchoring Compliance to Bitcoin | Missing from sitemap, no BreadcrumbList, no speakable |
| https://arkova.ai/research/real-cost-of-audit-verification | The Real Cost of Audit Verification | Missing from sitemap, no BreadcrumbList, no speakable |
| https://arkova.ai/research/agentic-recordkeeping | Agentic Recordkeeping | Missing from sitemap, no BreadcrumbList, no speakable |
| https://arkova.ai/research/convergence-stack | The Convergence Stack | Missing from sitemap, no BreadcrumbList, no speakable |
| https://arkova.ai/research/government-records | Modernizing Government Records | Missing from sitemap, no BreadcrumbList, no speakable |
| https://arkova.ai/whitepaper | The Universal Verification Layer | TechArticle not linked via @id, missing mainEntityOfPage |
| https://arkova.ai/roadmap | Roadmap | No BreadcrumbList |
| https://arkova.ai/contact | Contact | No physical address, no phone |
| https://arkova.ai/privacy | Privacy Policy | No BreadcrumbList |
| https://arkova.ai/terms | Terms of Service | No BreadcrumbList |

---

## Methodology

This audit was conducted on 2026-03-28 using:
- WebFetch for page content retrieval and analysis
- Specialized GEO subagent analysis for AI citability, technical infrastructure, content E-E-A-T, schema validation, and brand authority
- All 12 sitemap URLs analyzed plus robots.txt, llms.txt, and sitemap.xml
- Business type classified as SaaS based on pricing schema, app subdomain, API documentation, and feature comparison content

**Scoring weights:** AI Citability (25%), Brand Authority (20%), Content E-E-A-T (20%), Technical GEO (15%), Schema & Structured Data (10%), Platform Optimization (10%)
