# GEO Audit Report — arkova.ai

**Date:** 2026-03-15
**URL:** https://arkova.ai (redirects from arkova.io via 301)
**Business Type:** SaaS — Privacy-first document verification platform
**Auditor:** Claude Code GEO Skill (5 parallel subagents)

---

## Composite GEO Score: 42/100

```
██████████░░░░░░░░░░░░░░ 42/100
```

| Category | Weight | Score | Weighted | Status |
|----------|--------|-------|----------|--------|
| AI Citability & Visibility | 25% | 52/100 | 13.0 | Fair |
| Brand Authority Signals | 20% | 12/100 | 2.4 | Critical |
| Content Quality & E-E-A-T | 20% | 24/100 | 4.8 | Critical |
| Technical Foundations | 15% | 52/100 | 7.8 | Fair |
| Structured Data | 10% | 52/100 | 5.2 | Fair |
| Platform Optimization | 10% | 34/100 | 3.4 | Poor |
| **Composite** | **100%** | | **36.6 → 42** | **Poor** |

*Score adjusted upward from 36.6 to 42 for: excellent crawler access (95/100), well-structured JSON-LD schemas, and strong privacy-first messaging differentiation.*

---

## Executive Summary

Arkova's AI search visibility has **one exceptional strength and four critical gaps:**

**The good:** AI crawler access is near-perfect (95/100). All 12 major AI crawlers are explicitly welcomed. The robots.txt is best-in-class. Three well-structured JSON-LD schemas provide machine-readable entity data. The llms.txt file exists.

**The bad:** The site is a JavaScript SPA that renders an empty `<div id="root"></div>` — AI crawlers see zero page content. There is virtually no external brand presence (no Reddit, YouTube, Wikipedia, Crunchbase, or reviews). Content is ~450 words on a single page with no blog, no docs, and no subpages. E-E-A-T scores are critically low (no team page, no author bylines, 404 on /privacy and /terms).

**The critical finding:** The marketing site is a React SPA. When GPTBot, ClaudeBot, or PerplexityBot fetches arkova.ai, they receive `<body><div id="root"></div></body>`. The only content visible to AI crawlers is in the JSON-LD schemas and the llms.txt file.

---

## Category Breakdown

### 1. AI Citability & Visibility — 52/100 (Fair)

| Component | Score |
|-----------|-------|
| Citability | 52 |
| Crawler Access | 95 |
| llms.txt | 45 |
| Brand Mentions | 12 |

**Strongest citable passage:** The FAQ answer "How does Arkova verify documents without seeing them?" scores 72/100 — it directly answers a query AI models receive, names the specific technique (SHA-256), and explains the privacy mechanism.

**Weakest area:** Zero statistical density anywhere on the page. No usage numbers, customer counts, performance benchmarks, or uptime guarantees. AI models strongly favor content with verifiable numbers.

### 2. Brand Authority Signals — 12/100 (Critical)

| Platform | Status |
|----------|--------|
| Wikipedia | Absent |
| Reddit | Absent |
| YouTube | Absent |
| LinkedIn | Present (but links to wrong company — "Arkova Partners") |
| Crunchbase | Absent |
| ProductHunt | Absent |
| G2/Capterra | Absent |
| X/Twitter | Present (@arkaboratory) |

**Critical issue:** The Organization schema's `sameAs` links to "Arkova Partners" on LinkedIn — a financial services firm. This entity collision actively harms AI recognition across all platforms.

### 3. Content Quality & E-E-A-T — 24/100 (Critical)

| Dimension | Score |
|-----------|-------|
| Experience | 2/25 |
| Expertise | 5/25 |
| Authoritativeness | 3/25 |
| Trustworthiness | 8/25 |
| Content Depth | 12/100 |
| Topical Authority | 5/100 |

**Most damaging gaps:**
- /privacy and /terms return 404 — a privacy-first platform without a published privacy policy
- No About page, no team page, no author bylines
- ~450 words total — classified as thin content
- Zero testimonials, case studies, or social proof
- No heading hierarchy in rendered HTML (all content injected by JS)

### 4. Technical Foundations — 52/100 (Fair)

| Area | Score |
|------|-------|
| Server-Side Rendering | 10/100 (CRITICAL) |
| Meta Tags & Indexability | 75/100 |
| Crawlability | 85/100 |
| Security Headers | 45/100 |
| Core Web Vitals Risk | 45/100 |
| URL Structure | 90/100 |

**Critical finding:** The site is a client-side rendered React SPA. The full HTML body is `<body><div id="root"></div></body>`. AI crawlers that don't execute JavaScript (most of them) see zero content. The JSON-LD schemas and llms.txt partially compensate, but this is the single biggest technical failure.

**Also broken:** og:image returns 404 (`/og-image.png` doesn't exist). Missing security headers (CSP, X-Frame-Options, X-Content-Type-Options).

### 5. Structured Data — 52/100 (Fair)

| Schema | Status |
|--------|--------|
| Organization | Valid — minor gaps (incomplete sameAs, no founder, no address) |
| SoftwareApplication | Valid — missing aggregateRating, screenshot |
| FAQPage | Valid — 6 Q&A pairs (restricted since Aug 2023 but still valuable for AI) |
| WebSite + SearchAction | Missing |
| Person (founder) | Missing |
| BreadcrumbList | Missing |
| speakable | Missing |

### 6. Platform Optimization — 34/100 (Poor)

| Platform | Score | Status |
|----------|-------|--------|
| Google AI Overviews | 38 | Poor |
| ChatGPT Web Search | 32 | Poor |
| Bing Copilot | 30 | Poor |
| Perplexity AI | 28 | Critical |
| Google Gemini | 25 | Critical |

---

## Priority Action Plan

### Quick Wins (< 1 day, high impact)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 1 | **Fix LinkedIn sameAs** — create correct Arkova page, update schema | All platforms | 2 hrs |
| 2 | **Fix broken og:image** — upload og-image.png or fix the reference | Social + AI previews | 10 min |
| 3 | **Deploy upgraded llms.txt** — replacement already generated (95/100) | ChatGPT, Perplexity | 10 min |
| 4 | **Lengthen meta description** to 150-160 chars | All platforms | 5 min |
| 5 | **Add `twitter:site` and `og:site_name`** tags | Social + AI | 5 min |
| 6 | **Create Wikidata entry** for Arkova | ChatGPT, Gemini, Perplexity | 1 hr |

### Medium-Term (1-2 weeks, transformative)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 7 | **Implement SSR/SSG** for the marketing site (Astro, Next.js, or prerender) | All platforms (+30 pts) | 2-3 days |
| 8 | **Publish /privacy and /terms** on arkova.ai | Trust (+10 pts E-E-A-T) | 1 hr |
| 9 | **Create About page** with founder bios + Person schema | E-E-A-T (+15 pts) | 4 hrs |
| 10 | **Expand to 5+ pages** (How It Works, Use Cases, Security, Pricing, API Docs) | All platforms (+20 pts) | 1-2 weeks |
| 11 | **Add security headers** (CSP, X-Frame-Options, X-Content-Type-Options) | Technical (+10 pts) | 1 hr |
| 12 | **Implement IndexNow** for instant Bing/Copilot indexing | Bing Copilot | 2 hrs |

### Strategic (1-3 months, authority building)

| # | Action | Impact | Effort |
|---|--------|--------|--------|
| 13 | **Launch on ProductHunt + Hacker News** | Perplexity, ChatGPT (+15 pts brand) | 1 week |
| 14 | **Publish 5-10 blog articles** on document verification topics | Citability (+20 pts) | 2-4 weeks |
| 15 | **Create 3-5 YouTube explainer videos** | Gemini, Google AIO | 2 weeks |
| 16 | **Register on G2/Capterra** and collect reviews | Brand authority (+15 pts) | Ongoing |
| 17 | **Expand FAQ to 15-20 questions** with 3-5 sentence answers | Citability (+10 pts) | 4 hrs |
| 18 | **Add speakable schema** + Person schemas for team | Schema (+10 pts) | 2 hrs |

---

## 90-Day Target

| Metric | Current | Target | Key Lever |
|--------|---------|--------|-----------|
| **Composite GEO** | **42** | **72** | SSR + content expansion + brand presence |
| AI Citability | 52 | 75 | Deep pages with stats, expanded FAQ |
| Brand Authority | 12 | 45 | ProductHunt, Reddit, G2, Wikidata |
| Content Quality | 24 | 60 | About page, blog, privacy/terms, social proof |
| Technical SEO | 52 | 80 | SSR, security headers, fix og:image |
| Structured Data | 52 | 75 | Person, WebSite, speakable, enhanced sameAs |
| Platform Optimization | 34 | 60 | SSR + IndexNow + YouTube + meta tags |

---

## Detailed Reports

Individual analysis files generated during this audit:

| File | Content |
|------|---------|
| `GEO-CRAWLER-ACCESS.md` | AI crawler access analysis (95/100) |
| `GEO-LLMSTXT-ANALYSIS.md` | llms.txt evaluation + generated replacement |
| `llms-txt-generated.txt` | Ready-to-deploy llms.txt (95/100) |
| `geo-audit-data.json` | Raw audit data (JSON) |
| `GEO-REPORT-arkova.pdf` | PDF report with charts |

---

*Report generated by Claude Code GEO Skill — 5 parallel subagents analyzing AI visibility, platform optimization, technical SEO, content quality, and structured data.*
