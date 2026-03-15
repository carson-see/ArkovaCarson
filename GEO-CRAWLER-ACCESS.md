# AI Crawler Access Report — arkova.ai

**Date:** 2026-03-15
**URL:** https://arkova.ai (redirects from arkova.io via 301)
**Crawler Access Score: 95/100**

---

## Crawler Access Map

| Crawler | Owner | Purpose | robots.txt | Meta Tags | HTTP Headers | **Status** |
|---------|-------|---------|:----------:|:---------:|:------------:|:----------:|
| GPTBot | OpenAI | Training + search | Allow | None | None | **ALLOW** |
| ChatGPT-User | OpenAI | Live browsing | Allow | None | None | **ALLOW** |
| ClaudeBot | Anthropic | Training | Allow | None | None | **ALLOW** |
| Claude-Web | Anthropic | Live browsing | Allow | None | None | **ALLOW** |
| Google-Extended | Google | Gemini training | Allow | None | None | **ALLOW** |
| Googlebot | Google | Search indexing | Allow (wildcard) | None | None | **ALLOW** |
| PerplexityBot | Perplexity | Search + answers | Allow | None | None | **ALLOW** |
| Bytespider | ByteDance | TikTok/Doubao AI | Allow | None | None | **ALLOW** |
| CCBot | Common Crawl | Open dataset | Allow | None | None | **ALLOW** |
| Applebot-Extended | Apple | Apple Intelligence | Allow | None | None | **ALLOW** |
| cohere-ai | Cohere | AI training | Allow | None | None | **ALLOW** |
| Bingbot | Microsoft | Bing + Copilot | Allow (wildcard) | None | None | **ALLOW** |

**Result: 12/12 AI crawlers allowed (100%)**

---

## robots.txt Analysis

```
User-agent: *
Allow: /
```

- **Wildcard policy:** Allow all — no restrictions on any crawler
- **AI crawlers explicitly listed:** 10 named user-agents with individual `Allow: /` directives
- **Sitemap reference:** `https://arkova.ai/sitemap.xml`
- **llms.txt reference:** Comment pointing to `https://arkova.ai/llms.txt`
- **Crawl-delay:** None set (crawlers use default pace)
- **Disallow rules:** None

### Assessment
The robots.txt is exemplary for AI visibility. Explicitly welcoming AI crawlers (rather than relying on the wildcard alone) sends a clear signal that the site wants to be included in AI training data and search results. The llms.txt comment is a nice discovery aid.

---

## Meta Tag Analysis

| Directive | Present | Value |
|-----------|:-------:|-------|
| `<meta name="robots">` | No | Not set (defaults to index, follow) |
| `X-Robots-Tag` HTTP header | No | Not set |
| `noindex` | No | Pages are indexable |
| `nofollow` | No | Links are followable |
| `noarchive` | No | Caching allowed |
| `nosnippet` | No | Snippets allowed |
| `data-nosnippet` | No | All content is snippet-eligible |
| `max-snippet` | No | No snippet length restriction |
| `<link rel="canonical">` | No | **Missing — should be added** |

### Assessment
No restrictive meta tags — all content is fully available for indexing, caching, and snippet extraction. The absence of a canonical tag is the only issue (minor, since there's only one page currently).

---

## HTTP Header Analysis

| Header | Value | AI Impact |
|--------|-------|-----------|
| `Server` | Vercel | Modern hosting, good uptime |
| `Content-Type` | text/html; charset=utf-8 | Standard, parseable |
| `Cache-Control` | public, max-age=0, must-revalidate | Always fresh content for crawlers |
| `Strict-Transport-Security` | max-age=63072000 | HTTPS enforced (2 years) |
| `X-Robots-Tag` | Not present | No header-level restrictions |

### Assessment
Clean headers. No crawler restrictions. HSTS enforced. The `must-revalidate` cache policy means crawlers always get the latest content.

---

## llms.txt Discovery

| Check | Status |
|-------|--------|
| File exists at `/llms.txt` | Yes |
| Referenced in robots.txt | Yes (comment) |
| Formal standard compliance | Partial (see `/geo llmstxt` report) |

---

## Sitemap Analysis

| Check | Status |
|-------|--------|
| sitemap.xml exists | Yes |
| Referenced in robots.txt | Yes |
| URLs listed | 1 (homepage only) |
| Last modified | 2026-03-15 |

**Issue:** Sitemap contains only the homepage. As pages are added (blog, about, docs), the sitemap should be expanded.

---

## Recommendations

### Already Excellent (keep as-is)
- All AI crawlers explicitly allowed in robots.txt
- No restrictive meta tags or HTTP headers
- llms.txt exists and is referenced
- HTTPS enforced with HSTS

### Should Fix (5 points to 100/100)
1. **Add `<link rel="canonical">`** to the homepage (`<link rel="canonical" href="https://arkova.ai/" />`)
2. **Expand sitemap.xml** as new pages are added
3. **Upgrade llms.txt** to formal standard (see generated replacement in `/geo llmstxt` report)
4. **Add IndexNow protocol** for instant Bing/Copilot indexing on content changes
5. **Consider adding `X-Robots-Tag: all`** HTTP header for explicit allowance signal

---

## Score Breakdown

| Criterion | Score | Notes |
|-----------|-------|-------|
| robots.txt completeness | 10/10 | All AI crawlers explicitly allowed |
| Meta tag openness | 9/10 | No restrictions; missing canonical |
| HTTP header compliance | 10/10 | No restrictive headers |
| llms.txt presence | 8/10 | Exists but needs standard upgrade |
| Sitemap coverage | 6/10 | Only 1 URL listed |
| HTTPS / security | 10/10 | HSTS enforced, 2-year max-age |
| **Total** | **53/60 → 95/100** | |
