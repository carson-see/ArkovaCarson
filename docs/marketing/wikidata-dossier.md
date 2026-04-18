# Wikidata Entity Dossier — Arkova (Q138765025)

**Confluence mirror:** [Top-10 Sprint Batch 3 — 2026-04-17 §3](https://arkova.atlassian.net/wiki/spaces/A/pages/13795329) — "Wikidata Dossier — GEO-02 (SCRUM-479)"
**Jira:** [SCRUM-479 / GEO-02](https://arkova.atlassian.net/browse/SCRUM-479)
**Last updated:** 2026-04-17
**Owner:** Carson (Wikidata submission), Engineering (follow-up `sameAs` PR if Q-ID shifts)
**Engineering status:** Scaffolding complete; Wikidata enrichment submission outstanding. [arkova-marketing/index.html](../../arkova-marketing/index.html) `sameAs` already references `https://www.wikidata.org/wiki/Q138765025`, but that entity is a stub on Wikidata. This dossier is the payload to enrich Q138765025 so LLMs and knowledge panels have structured facts to cite.

---

## How to use this document

Wikidata is edited through the web UI, not the API (for a first-time entity the rate-limit quirks make an API submission fragile). Use this dossier as the canonical source of claims to paste into Q138765025.

Five concrete steps:

1. **Log in** at [wikidata.org](https://www.wikidata.org/) with a Wikidata account that has ≥4 prior edits (new accounts are rate-limited on high-value entity edits).
2. **Open** [Q138765025](https://www.wikidata.org/wiki/Q138765025).
3. **Paste each §Claim** into the entity UI using the "Add statement" button. One property at a time. Provide each §Source for verifiability.
4. **Add language labels + descriptions** in EN first, then ES / JA / FR (§Labels). Wikidata requires at least one English label before the entity is useful.
5. **Validate** — open [Google Knowledge Graph API](https://developers.google.com/knowledge-graph) for `arkova` (requires API key) and confirm the Wikidata Q-ID surfaces. Expect 48-72h propagation.

When Google surfaces Q138765025 in a Knowledge Graph result, transition SCRUM-479 → Done. Until then, keep Blocked.

---

## Labels (copy-paste)

| Language | Label | Description | Aliases |
|----------|-------|-------------|---------|
| en | Arkova | American software company providing privacy-preserving credential and document verification via public-network anchoring | Arkova Technologies, ArkovaTech |
| es | Arkova | Empresa estadounidense de software de verificación de credenciales con anclaje en red pública | Arkova Technologies |
| ja | アーコバ | 米国のクレデンシャル検証ソフトウェア企業 | Arkova, ArkovaTech |
| fr | Arkova | Éditeur américain de logiciels de vérification de justificatifs avec ancrage sur réseau public | Arkova Technologies |

---

## Claims

Each row below is a Wikidata statement. Property IDs are authoritative — do not substitute.

| Property | Property ID | Value | Source |
|----------|-------------|-------|--------|
| instance of | P31 | business (Q4830453) | company registration |
| instance of | P31 | software company (Q1058914) | company registration |
| industry | P452 | software industry (Q880568) | self-description at arkova.ai |
| industry | P452 | information security (Q3510521) | self-description |
| industry | P452 | financial technology (Q28229137) | verification-of-funds use case |
| official website | P856 | https://arkova.ai | direct |
| country | P17 | United States of America (Q30) | company registration |
| headquarters location | P159 | Detroit (Q12439) — **confirm before submitting** | company registration |
| inception | P571 | 2025 (confirm month before submitting) | founder record |
| founder | P112 | Carson Seeger (create Q-item if missing) | LinkedIn profile |
| logo image | P154 | (skip — Wikidata Commons upload required first) | — |
| LinkedIn ID (company) | P4264 | arkovatech | linkedin.com/company/arkovatech |
| Twitter/X username | P2002 | arkovatech | x.com/arkovatech |
| YouTube channel ID | P2397 | UCTTDFFSLxl85omCeJ9DBvrg | youtube.com/channel/UCTTDFFSLxl85omCeJ9DBvrg |
| GitHub username | P2037 | carson-see | github.com/carson-see/ArkovaCarson |
| described at URL | P973 | https://app.arkova.ai | — |

**Do not submit unless confirmed:**

- Exact month of inception (leave blank if unknown; better than wrong).
- Exact HQ city (verify against state registration before P159 is set).

---

## Sources (for each claim)

Wikidata requires a source for each claim or it will be flagged. Use these URLs as `reference URL` (P854) for every statement:

1. `https://arkova.ai` — official website
2. `https://app.arkova.ai` — product
3. `https://www.linkedin.com/company/arkovatech` — LinkedIn company page
4. `https://github.com/carson-see/ArkovaCarson` — GitHub org
5. `https://x.com/arkovatech` — X/Twitter handle

Avoid self-referential blog posts for factual claims (inception date, HQ location, founder) — Wikidata patrollers mark those as "circular reference" and remove them.

---

## Post-submission engineering follow-up

If Wikidata assigns a **different** Q-ID (unlikely, but possible if an admin merges Q138765025 into an existing entity), update the `sameAs` entry in [arkova-marketing/index.html](../../arkova-marketing/index.html) in a small PR:

```diff
 "sameAs": [
-  "https://www.wikidata.org/wiki/Q138765025",
+  "https://www.wikidata.org/wiki/Q<new_id>",
   ...
 ],
```

Re-run the [Google Rich Results Test](https://search.google.com/test/rich-results). If the old Q-ID 404s, leave a redirect comment in the Wikidata talk page for 30 days so crawlers update.

---

## Manual-followup email

Per CLAUDE.md MANUAL-FOLLOWUP EMAIL MANDATE, Carson emails `carson@arkova.ai` on Wikidata submission with: final Q-ID (if different from Q138765025), list of claims added, Google Knowledge Graph API validation result (once the 48-72h propagation window closes), and link to any follow-up `sameAs` PR if Q-ID shifted.

---

## Definition of Done for SCRUM-479

- [ ] Q138765025 populated with EN label + EN description + ≥10 claims from §Claims with at least one source each.
- [ ] EN, ES, JA, FR labels present.
- [ ] LinkedIn company page complete with logo, description, URL (external — already existed per CLAUDE.md).
- [ ] `sameAs` in [arkova-marketing/index.html](../../arkova-marketing/index.html) includes the Wikidata URL (done).
- [ ] Google Knowledge Graph API returns Q138765025 as the `identifier` for `arkova`.
- [ ] SCRUM-479 transitioned Blocked → Done.
