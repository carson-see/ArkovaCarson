# Platform Readiness Analysis
_Generated: 2026-03-18 EST | Target: https://arkova.ai_

**Platform Readiness Average: 38/100**

## Platform Scores Overview

| Platform | Score | Status |
|---|---|---|
| Google AI Overviews | 41/100 | Fair |
| ChatGPT Web Search | 29/100 | Poor |
| Perplexity AI | 32/100 | Poor |
| Google Gemini | 39/100 | Poor |
| Bing Copilot | 27/100 | Poor |

**Strongest Platform:** Google AI Overviews -- Strong content structure (FAQ schema, question-based headings, answer-target patterns) gives AIO the most material to extract. Technical signals are solid with clean heading hierarchy and multiple JSON-LD blocks.

**Weakest Platform:** Bing Copilot -- No IndexNow support, no Bing Webmaster Tools verification detected, arkova.ai not indexed in Bing, no Microsoft ecosystem presence (LinkedIn company page is near-empty, no GitHub org visibility).

---

## Google AI Overviews

**Score: 41/100**

| Signal Category | Score | Key Findings |
|---|---|---|
| Content Structure | 28/40 | Strong FAQ section with 6 question-answer pairs in FAQPage schema. Question-based H3 headings ("How does Arkova verify documents without seeing them?"). Clear definition patterns ("Arkova creates tamper-proof, independently verifiable records..."). Answer-target pattern present (question heading followed by concise ~40-word answer). Missing: comparison tables, ordered process lists for "how it works" steps (currently uses cards, not numbered lists). |
| Source Authority | 5/30 | CRITICAL: `site:arkova.ai` returns zero results in Google. The domain appears not indexed. Google returns arkova.io results instead. No backlinks from authoritative third-party sources found. No Google News inclusion. No press coverage. Outbound citations on research articles reference PCAOB/Audit Analytics but do not hyperlink to sources. |
| Technical Signals | 8/30 | Clean heading hierarchy (H1 > H2 > H3, no skipped levels). Four JSON-LD blocks (Organization, SoftwareApplication, FAQPage, WebSite). Article schema on research pages with proper datePublished/dateModified. SSR prerender delivers content in initial HTML. However: arkova.ai is NOT INDEXED by Google, rendering all technical optimization moot until indexing is resolved. Sitemap exists at /sitemap.xml with 10 URLs and lastmod dates. |

**Optimization Actions:**

1. **[CRITICAL] Resolve arkova.ai Google indexing failure.** Submit arkova.ai to Google Search Console immediately. The domain returns zero results for `site:arkova.ai`. Verify DNS, check for any `noindex` meta tags in production HTML, confirm Google Search Console property is verified for arkova.ai (not just arkova.io). Submit sitemap. Until this is fixed, no AIO optimization matters.

2. **Add comparison tables to the homepage.** Create an HTML `<table>` comparing Arkova vs. e-signature tools (DocuSign, Adobe Sign) vs. traditional notarization vs. blockchain-only solutions. AIO preferentially extracts structured comparison tables. The FAQ already contains the DocuSign differentiation -- expand it into a scannable table with columns: Feature | Arkova | E-Signature Tools | Traditional Notarization.

3. **Hyperlink all statistical citations in research articles.** The audit cost article cites "$3.01M average audit fee (PCAOB / Audit Analytics)" but does not link to the source. Add `<a href>` to every statistic's source. AIO strongly favors content with verifiable citations, and linked sources increase the probability of being selected as an AIO source.

---

## ChatGPT Web Search

**Score: 29/100**

| Signal Category | Score | Key Findings |
|---|---|---|
| Entity Recognition | 5/35 | No Wikipedia article for Arkova. No Wikidata entry. No Crunchbase profile found. The LinkedIn company page (linkedin.com/company/arkovatech) exists but appears minimal -- search results conflate Arkova with "Arkova Technologies" (an unrelated Indian research solutions company at arkovatechnologies.com) and "Arkova Partners" (financial services). Entity collision is active and damaging. Organization schema includes sameAs links to LinkedIn, X, YouTube, and GitHub, but without Wikipedia/Wikidata anchors, ChatGPT cannot reliably resolve the entity. |
| Content Preferences | 16/40 | Good: Factual, concise definition statements quotable by ChatGPT ("Arkova uses cryptographic fingerprinting (SHA-256) that runs entirely in your browser"). Team bios with credentials (Carson: 10yr tech rescue, Sarah: 20yr supply chain, Yaacov: NAI Senior Member, 14.5K Scholar citations). Visible publication dates on all research articles. FAQ answers are direct and quotable. Gaps: No author credential schema (Person schema with jobTitle, affiliation, sameAs). No visible "last updated" dates on homepage. Statistics lack hyperlinked source URLs. |
| Crawler Access | 8/25 | robots.txt allows GPTBot and ChatGPT-User. However, OAI-SearchBot is NOT explicitly listed (this is the crawler that powers ChatGPT's web search feature, distinct from GPTBot which is for training). While the wildcard `Allow: /` covers it, explicit declaration is a stronger signal. Sitemap is declared. No crawl-delay specified (good). |

**Optimization Actions:**

1. **Create a Wikipedia article for Arkova.** This is the single highest-impact action for ChatGPT entity recognition. Draft a stub article meeting notability guidelines -- cite the PCAOB audit cost data, the Operation Nightingale fraud case (both referenced in the whitepaper), and any press coverage. Without Wikipedia, ChatGPT has no authoritative entity anchor and will confuse Arkova with similarly-named entities. Alternatively, start with a Wikidata entry (lower notability bar): instance of = "business enterprise", industry = "software", website = arkova.ai, founded = 2025.

2. **Add Person schema for all team members.** On the homepage team section, add JSON-LD `Person` schema for Carson Seeger, Sarah Rushton, and Yaacov Petscher with: `jobTitle`, `affiliation` (Arkova), `sameAs` (LinkedIn, Google Scholar), `alumniOf`, and `knowsAbout`. Yaacov's Google Scholar profile (14,505 citations, NAI Senior Member, FSU faculty, Harvard Reach Every Reader) is a powerful E-E-A-T signal that is currently invisible to structured data consumers. Example:
   ```json
   {
     "@type": "Person",
     "name": "Dr. Yaacov Petscher",
     "jobTitle": "Founder & Advisor",
     "affiliation": {"@type": "Organization", "name": "Arkova"},
     "sameAs": [
       "https://scholar.google.com/citations?user=MUGWLDoAAAAJ",
       "https://reacheveryreader.gse.harvard.edu/team/yaacov-petshcer/"
     ],
     "knowsAbout": ["Data Science", "Psychometrics", "Applied Statistics"]
   }
   ```

3. **Add OAI-SearchBot explicitly to robots.txt.** While the wildcard covers it, explicitly listing `User-agent: OAI-SearchBot / Allow: /` sends a stronger signal to OpenAI's search crawler and distinguishes it from GPTBot (training). This is a 30-second change with outsized signal value.

---

## Perplexity AI

**Score: 32/100**

| Signal Category | Score | Key Findings |
|---|---|---|
| Community Validation | 2/30 | Zero Reddit mentions of Arkova (document verification). Zero Stack Overflow or Quora discussions. No third-party reviews on G2, Capterra, TrustPilot, or Product Hunt. No forum discussions. The only community signal is the LinkedIn company page. Perplexity heavily indexes Reddit and community sources -- this is a critical blind spot. |
| Source Directness | 18/30 | Strong: The whitepaper (4,500+ words) contains original technical architecture detail (SHA-256, OP_RETURN, pgvector, MCP). Research articles provide primary analysis with original data (time cost table: 1,080-1,920 hours/year for audit verification). The API documentation is a primary source. Gaps: No original research data (surveys, case studies with named clients). Statistics cite external sources rather than presenting proprietary data. |
| Content Freshness | 8/20 | Publication dates visible on all research articles (Nov 2025 - Mar 2026). Whitepaper marked "Version 2.0, March 2026." Sitemap lastmod dates are current (2026-03-16). Gaps: Homepage has no visible publication or last-updated date. Research articles span only 5 months -- cadence is good but the corpus is thin (5 articles). |
| Technical Access | 4/20 | PerplexityBot explicitly allowed in robots.txt (good). SSR prerender delivers content without JavaScript (good). However, arkova.ai appears to have indexing issues -- if Google cannot index it, Perplexity (which also relies on web indexing) may face similar crawl/discovery problems. Page load speed unverifiable from external analysis but SSR suggests reasonable performance. |

**Optimization Actions:**

1. **Launch on Product Hunt and post to relevant subreddits.** Perplexity disproportionately surfaces content that has Reddit/community validation. Target subreddits: r/edtech, r/compliance, r/blockchain, r/SaaS, r/startups. Post genuine value content (not promotional) -- e.g., share the audit cost analysis article in r/compliance or r/accounting with a discussion prompt. A single well-received Reddit thread with 20+ upvotes can make Arkova citable by Perplexity.

2. **Publish original research with proprietary data.** Perplexity cites primary sources. Create a "State of Credential Verification 2026" report with survey data, even if the sample is small (50-100 compliance professionals). This makes Arkova THE primary source for credential verification statistics rather than a secondary commentator on PCAOB data.

3. **Add a "Last updated" timestamp to the homepage footer or hero section.** Perplexity evaluates content freshness. A visible "Last updated: March 2026" on the homepage signals active maintenance. Also ensure HTTP `Last-Modified` headers are set correctly on all pages.

---

## Google Gemini

**Score: 39/100**

| Signal Category | Score | Key Findings |
|---|---|---|
| Google Ecosystem | 10/35 | YouTube channel exists (linked in sameAs) but search for "Arkova credential verification" on YouTube returns zero results -- the channel appears empty or has no relevant content. No Google Business Profile detected. Yaacov Petscher has a strong Google Scholar presence (14,505 citations) but his Arkova affiliation is not reflected on his Scholar profile. No Google News inclusion. No Google Books presence. The YouTube channel is a placeholder, not an asset. |
| Knowledge Graph | 5/30 | No Google Knowledge Panel for "Arkova" queries. Entity is not in Google's Knowledge Graph. sameAs schema links to LinkedIn, X, YouTube, GitHub -- but no Wikipedia or Wikidata links (the two strongest Knowledge Graph triggers). Founder names do not trigger Knowledge Panels either. The arkova.ai domain is not indexed by Google, which prevents any Knowledge Graph association. |
| Content Quality | 24/35 | Whitepaper is comprehensive long-form content (4,500+ words) covering technical architecture, business model, competitive landscape, and roadmap. Research section has 5 articles with topical clustering around compliance, blockchain verification, and agentic AI. Internal linking between research articles and whitepaper is present. Homepage has multi-section depth (features, API, use cases, team, FAQ). Gaps: No images with descriptive alt text visible in analysis. No video content referenced on pages. Topical depth is good but breadth is narrow (5 articles covering 3-4 subtopics). |

**Optimization Actions:**

1. **Publish 3-5 YouTube videos and optimize for Gemini.** Gemini pulls heavily from YouTube. Create: (a) "How Arkova Works" explainer (2-3 min), (b) whitepaper walkthrough, (c) demo of credential verification flow. Use Arkova-branded thumbnails. Add chapters/timestamps. Ensure video titles match target queries ("How to verify credentials without exposing documents," "Bitcoin-anchored document verification explained"). An empty YouTube channel is worse than no channel -- it signals abandonment.

2. **Update Yaacov Petscher's Google Scholar profile to reference Arkova.** His 14,505-citation Scholar profile is a significant authority signal for Gemini (which draws from Google's full ecosystem). If his Scholar profile listed "Arkova" as a current affiliation, Gemini would associate that academic authority with the company. This is a manual Scholar profile edit.

3. **Create a Google Business Profile for Arkova.** Even as a software company, a GBP establishes entity presence in Google's ecosystem. Set category to "Software company," add the arkova.ai website, add the team photos, and link to the LinkedIn company page. This triggers Knowledge Panel eligibility and helps Gemini resolve the entity.

---

## Bing Copilot

**Score: 27/100**

| Signal Category | Score | Key Findings |
|---|---|---|
| Bing Index Signals | 3/30 | No IndexNow protocol support detected (no IndexNow API key file or meta tag). No `msvalidate.01` meta tag found (indicates Bing Webmaster Tools is not verified). Sitemap exists at /sitemap.xml but may not be submitted to Bing. The `site:arkova.ai` Google search returning zero results suggests potential indexing issues that likely affect Bing as well. No evidence of Bing-specific optimization. |
| Content Preferences | 16/30 | Content is well-structured with clear headings and direct answers. Professional tone appropriate for enterprise/workplace queries (Copilot's primary context). FAQ answers are concise and quotable. Whitepaper demonstrates deep expertise. Research articles have professional formatting with author attribution. Gaps: No comparison tables. Statistics lack hyperlinked sources. No "TL;DR" or executive summary sections that Copilot can extract for quick answers. |
| Microsoft Ecosystem | 3/20 | LinkedIn company page exists at linkedin.com/company/arkovatech but appears minimal (no detailed description, employee count, or regular posts found in search). No GitHub organization page (individual user repo at github.com/carson-see/ArkovaCarson, which is not a company org). No Microsoft-related integrations or partnerships mentioned. |
| Technical Signals | 5/20 | SSR prerender suggests fast initial load. Clean HTML semantics with proper heading hierarchy. Multiple JSON-LD structured data blocks. Mobile optimization status unverifiable from external analysis. Gaps: No IndexNow, no Bing Webmaster Tools verification, potential indexing issues mirroring Google's. |

**Optimization Actions:**

1. **Implement IndexNow protocol.** Add IndexNow support to arkova.ai. This is Bing's preferred URL submission method and gives Copilot faster access to new/updated content. Steps: (a) generate an API key, (b) host the key file at `https://arkova.ai/{key}.txt`, (c) ping `https://api.indexnow.org/indexnow?url=https://arkova.ai/&key={key}` on every content publish. This also benefits Yandex and other IndexNow-supporting engines.

2. **Verify arkova.ai in Bing Webmaster Tools.** Add the `msvalidate.01` meta tag to the site `<head>`. Submit the sitemap directly to Bing. This is a prerequisite for Bing indexing diagnostics and signals legitimacy to Copilot. Without Bing Webmaster Tools verification, there is no way to diagnose or fix Bing indexing issues.

3. **Build out the LinkedIn company page.** Copilot draws from the Microsoft ecosystem, and LinkedIn is its strongest company data source. The current page appears nearly empty. Add: company description (matching the homepage meta description), industry (Software Development), company size, specialties (credential verification, document authentication, blockchain anchoring, compliance), featured posts, and regular content posting cadence (1-2 posts/week). Encourage team members to list Arkova as their employer.

---

## Cross-Platform Synergies

Actions that improve multiple platforms simultaneously:

1. **Fix arkova.ai Google/Bing indexing** -- Impacts: Google AI Overviews, Google Gemini, Bing Copilot, Perplexity AI, ChatGPT Web Search. This is the single most critical issue. If search engines cannot index the domain, no amount of content optimization matters. All five platforms rely on web indexing for content discovery.

2. **Create Wikipedia/Wikidata entries for Arkova** -- Impacts: ChatGPT Web Search, Perplexity AI, Google Gemini, Google AI Overviews. Wikipedia is the strongest entity resolution signal across all AI platforms. A Wikidata entry (lower bar) immediately improves structured entity recognition for ChatGPT and Gemini's Knowledge Graph.

3. **Add Person schema for team members (especially Yaacov Petscher)** -- Impacts: ChatGPT Web Search, Google AI Overviews, Google Gemini. A NAI Senior Member with 14,505 Google Scholar citations is a powerful E-E-A-T signal. Currently this authority is invisible to structured data consumers. Person schema with sameAs links to Scholar, LinkedIn, and institutional pages connects this authority to Arkova across platforms.

4. **Publish YouTube content** -- Impacts: Google Gemini, Google AI Overviews, Perplexity AI. Gemini draws heavily from YouTube. AIO increasingly includes video results. Perplexity cites YouTube transcripts. An empty YouTube channel is a negative signal.

5. **Build Reddit/community presence** -- Impacts: Perplexity AI, ChatGPT Web Search, Google AI Overviews. Perplexity disproportionately indexes Reddit. ChatGPT surfaces community-validated content. Google AIO includes Reddit discussions in overviews.

---

## Priority Actions (All Platforms)

1. **[CRITICAL] Fix arkova.ai search engine indexing** -- Affects: ALL 5 PLATFORMS -- Effort: Low. Verify Google Search Console and Bing Webmaster Tools properties for arkova.ai. Submit sitemap. Check for DNS/redirect issues between arkova.ai and arkova.io that may confuse crawlers. Check for `noindex` directives in production HTML. This is a total blocker.

2. **[CRITICAL] Create Wikidata entry for Arkova** -- Affects: ChatGPT, Perplexity, Gemini, AIO -- Effort: Low. Create a Wikidata item with: instance of (Q4830453, business enterprise), industry (Q7397, software industry), official website (https://arkova.ai), inception (2025), founder entries. This is a 15-minute task with outsized entity recognition impact.

3. **[HIGH] Add Person schema for founders with sameAs links** -- Affects: ChatGPT, AIO, Gemini -- Effort: Low. Add JSON-LD Person schema for Carson Seeger, Sarah Rushton, Yaacov Petscher. Include jobTitle, affiliation, sameAs (LinkedIn, Scholar), knowsAbout. Yaacov's Scholar authority (14.5K citations) is currently invisible to AI platforms.

4. **[HIGH] Implement IndexNow + verify Bing Webmaster Tools** -- Affects: Bing Copilot, Perplexity -- Effort: Low. Host IndexNow key file, add msvalidate.01 meta tag. 30-minute implementation with permanent indexing benefits.

5. **[HIGH] Build Reddit/Product Hunt community presence** -- Affects: Perplexity, ChatGPT, AIO -- Effort: Medium. Launch on Product Hunt. Post research articles to r/edtech, r/compliance, r/SaaS with discussion prompts. Zero community mentions is the single biggest gap for Perplexity optimization.

6. **[HIGH] Publish YouTube video content (minimum 3 videos)** -- Affects: Gemini, AIO, Perplexity -- Effort: Medium. "How Arkova Works" explainer, whitepaper walkthrough, live demo. An empty YouTube channel linked in sameAs is a negative signal.

7. **[MEDIUM] Add comparison tables to homepage** -- Affects: AIO, Bing Copilot -- Effort: Low. HTML table comparing Arkova vs. DocuSign vs. traditional notarization. AIO preferentially extracts structured tables.

8. **[MEDIUM] Hyperlink all statistical citations in research articles** -- Affects: AIO, ChatGPT, Perplexity -- Effort: Low. Every statistic (e.g., "$3.01M average audit fee") should link to its primary source. Currently referenced by name only (PCAOB/Audit Analytics) without URLs.

9. **[MEDIUM] Build out LinkedIn company page** -- Affects: Bing Copilot, ChatGPT, Gemini -- Effort: Low. Add full description, specialties, employee listings, regular posting cadence. Currently near-empty.

10. **[MEDIUM] Add OAI-SearchBot to robots.txt explicitly** -- Affects: ChatGPT -- Effort: Trivial. 30-second change. Explicit declaration is stronger than wildcard coverage.

---

## Detailed Signal Analysis Notes

### Indexing Crisis (Affects All Platforms)

The most alarming finding is that `site:arkova.ai` returns **zero results** in Google search. When searching for "arkova.ai" without the site operator, Google returns arkova.io, ArkoAI (arko.ai), and unrelated entities -- but not arkova.ai. This means:

- Google has not indexed arkova.ai at all, OR
- There is a canonical/redirect issue where arkova.ai is being treated as a duplicate of arkova.io, OR
- There is a `noindex` directive in production HTML that was not visible in the content extraction

Possible causes to investigate:
1. DNS misconfiguration -- is arkova.ai properly resolving?
2. Canonical tags -- does arkova.ai pages have `<link rel="canonical">` pointing to arkova.io?
3. Google Search Console -- is the property verified for arkova.ai?
4. Redirect chains -- does arkova.ai redirect to arkova.io at any level?
5. Cloudflare settings -- is there a page rule or redirect that affects crawlers?

**Until this is resolved, the effective platform readiness score is near zero for all platforms that depend on search indexing (all five).**

### Entity Collision (Affects ChatGPT, Perplexity, Gemini)

"Arkova" is not a unique term. Search results conflate:
- **Arkova** (document verification, arkova.ai/arkova.io) -- the target entity
- **Arkova Technologies** (arkovatechnologies.com) -- Indian PhD research solutions company
- **Arkova Partners** -- financial services firm
- **Arkona** -- ancient Slavic historical site
- **ArkoAI** (arko.ai) -- AI rendering tool

Without Wikipedia/Wikidata disambiguation, AI platforms will continue conflating these entities. The sameAs schema helps but is insufficient without authoritative third-party entity anchors.

### Content Quality Assessment

The content itself is well-structured for AI consumption:
- FAQ schema with 6 question-answer pairs is a strong AIO signal
- Research articles have proper Article schema with dates, authors, word counts
- Definition patterns are clear and quotable
- Technical depth in the whitepaper is genuine (not superficial)
- Team credentials are verifiable (Yaacov's Scholar profile confirms NAI membership, 14.5K citations)

The problem is not content quality -- it is **content discoverability**. The content exists but cannot be found by any platform.

### Crawler Access (The One Bright Spot)

Crawler access is excellent:
- All major AI crawlers explicitly allowed in robots.txt
- SSR prerender ensures content is in initial HTML
- Sitemap with lastmod dates is properly declared
- No crawl-delay restrictions

This means that once indexing is fixed, crawlers will have full access to well-structured content. The infrastructure is ready -- the content just needs to be discoverable.
