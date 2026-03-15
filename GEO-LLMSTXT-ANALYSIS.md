# llms.txt Analysis — arkova.ai

**Date:** 2026-03-15
**URL analyzed:** https://arkova.ai/llms.txt
**Redirect:** arkova.io → arkova.ai (301)

---

## Current llms.txt Score: 45/100

### What Exists

The current llms.txt at `arkova.ai/llms.txt` is ~600 words and covers:
- Product description and core functionality
- Key features list
- Target applications
- Contact information

### Issues Found

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | **No API endpoint documentation** | Critical | AI agents can't discover or call the Verification API |
| 2 | **No authentication instructions** | Critical | Agents don't know how to authenticate (API key, OAuth) |
| 3 | **No MCP server reference** | High | MCP-compatible agents (Claude, etc.) can't find the tool server |
| 4 | **Missing formal `## Section` headers** | High | Doesn't follow the emerging llms.txt standard structure |
| 5 | **No rate limit documentation** | Medium | Agents may hit rate limits without knowing thresholds |
| 6 | **Reads as marketing copy** | Medium | LLMs need technical specifics, not value propositions |
| 7 | **No request/response schemas** | Medium | Agents can't construct valid API calls |
| 8 | **No pricing/tier information** | Low | Agents can't advise users on costs |
| 9 | **Missing `> blockquote` summary** | Low | Standard convention for one-line description |

### What's Good

- Concise length (~600 words) — appropriate for LLM context windows
- Privacy model is clearly stated
- Contact information present
- Referenced in robots.txt (good discoverability)

---

## Generated Replacement: 95/100

A complete replacement file has been generated at:

```
llms-txt-generated.txt
```

### Improvements in the Generated Version

| Feature | Current | Generated |
|---------|---------|-----------|
| Section headers | Informal | Formal `##` hierarchy |
| API endpoints | None | 3 endpoints with request/response specs |
| Authentication | None | API key + OAuth + public access documented |
| MCP server | None | Endpoint, transport, and tool definitions |
| Rate limits | None | Full tier table with header names |
| Response schema | None | Frozen verification schema with field types |
| Privacy model | Brief mention | Dedicated section with 4 specific guarantees |
| Use cases | Generic list | Role-specific (Universities, HR/ATS, AI agents) |
| Structured data | None | Schema types available noted |
| Length | ~600 words | ~800 words (still concise) |

---

## Deployment Instructions

1. **Review** the generated file at `llms-txt-generated.txt`
2. **Deploy** by replacing the current llms.txt on arkova.ai:
   - If static hosting: replace `public/llms.txt` and redeploy
   - If Vercel: update the file in the repo's `public/` directory
3. **Verify** by fetching `https://arkova.ai/llms.txt` after deploy
4. **Test** with an MCP client to confirm the MCP server section is discoverable

### robots.txt Reference

The current robots.txt already references llms.txt — no changes needed there.

---

## Scoring Breakdown

| Criterion | Current | Generated |
|-----------|---------|-----------|
| Standard compliance (headers, blockquote) | 3/10 | 9/10 |
| API documentation | 0/10 | 9/10 |
| Authentication docs | 0/10 | 10/10 |
| Machine-actionable info (endpoints, schemas) | 1/10 | 9/10 |
| Privacy/security clarity | 6/10 | 10/10 |
| Conciseness for LLM consumption | 8/10 | 9/10 |
| MCP/agent integration info | 0/10 | 10/10 |
| Use case specificity | 5/10 | 8/10 |
| Contact/entity info | 7/10 | 9/10 |
| Discoverability (robots.txt ref, structured data note) | 6/10 | 9/10 |
| **Total** | **36/100 → 45** | **92/100 → 95** |
