# Jira Epic Hygiene Audit — 2026-04-21

**Context:** User flagged two empty epics ([SCRUM-712 TRUST](https://arkova.atlassian.net/browse/SCRUM-712) and [SCRUM-918 MCP-SEC](https://arkova.atlassian.net/browse/SCRUM-918)) and pushed for full user-story coverage on all open epics. This doc records the audit + cleanup done against live Jira on 2026-04-21.

## Summary

| State | Count |
|-------|-------|
| Open epics audited | 22 |
| Epics with zero children before audit | 2 (TRUST SCRUM-712, MCP-SEC SCRUM-918) |
| Epics under-populated vs scope (child count < planned sub-phases) | 4 (GME7, GME8, CONT, FEDCONT) |
| New child stories filed | 23 |
| Re-linked existing stories to correct parent | 7 (MCP-SEC-01..06 + -10) |
| Sarah Sprint 1 release net items | 19 (was 1, now includes 15 TRUST + 3 MCP-SEC + SCRUM-727) |

## What was empty

**SCRUM-712 TRUST — Trust Framework Expansion** — had 0 children. Epic description covered Q1–Q4 roadmap (SOC 2 Type II + ISO 27001 + 27701 + Cyber Essentials Plus + CSA STAR L1/L2 + cyber insurance + CREST pen test + EU-US DPF + HITRUST i1 + StateRAMP). All of it was in prose, none was filed as work items.

**SCRUM-918 MCP-SEC — MCP server rogue-agent hardening** — had 0 children per JQL. MCP-SEC-01..06 + -10 existed as individual Jira stories (SCRUM-919..924 + -929) but were filed with `parent=NONE` instead of `parent=SCRUM-918`. Epic and children were disconnected.

## What was under-populated vs scope

- **SCRUM-827 GME7** (3 children) — per-type confidence calibration pipeline but no CI guard + no monitoring dashboard. Added GME7.4 + GME7.5.
- **SCRUM-828 GME8** (4 children) — domain router + schema + verification registry + validation algos but no production cutover + no observability. Added GME8.5 + GME8.6.
- **SCRUM-874 CONT** (4 children) — contract expertise but missing contract doctrine fundamentals (formation elements) + arbitration/choice-of-law clause detection. Added CONT-01 + CONT-05.
- **SCRUM-875 FEDCONT** (3 children) — federal contracting epic named "FAR/DFARS, SAM.gov, SBA, **CMMC**, **2 CFR 200**" but CMMC and 2 CFR 200 had no child stories. Added FEDCONT-04 + FEDCONT-05.

## What was filed today

### TRUST (SCRUM-712) → 15 children

Q1 2026:
- [SCRUM-959 TRUST-01](https://arkova.atlassian.net/browse/SCRUM-959) SOC 2 Type II observation window
- [SCRUM-960 TRUST-02](https://arkova.atlassian.net/browse/SCRUM-960) CSA STAR Level 1 self-assessment
- [SCRUM-961 TRUST-03](https://arkova.atlassian.net/browse/SCRUM-961) Cyber insurance policy binding
- [SCRUM-962 TRUST-04](https://arkova.atlassian.net/browse/SCRUM-962) CREST-accredited pen test
- [SCRUM-963 TRUST-05](https://arkova.atlassian.net/browse/SCRUM-963) EU-US DPF certification

Q2 2026:
- [SCRUM-964 TRUST-06](https://arkova.atlassian.net/browse/SCRUM-964) Compliance automation tool selection
- [SCRUM-979 TRUST-12](https://arkova.atlassian.net/browse/SCRUM-979) SOC 2 Type II audit execution
- [SCRUM-981 TRUST-13](https://arkova.atlassian.net/browse/SCRUM-981) SOC 3 public-facing bundle

Q2–Q3 2026:
- [SCRUM-965 TRUST-08](https://arkova.atlassian.net/browse/SCRUM-965) ISO 27001 gap analysis
- [SCRUM-966 TRUST-09](https://arkova.atlassian.net/browse/SCRUM-966) ISO 27001 implementation roadmap
- [SCRUM-967 TRUST-10](https://arkova.atlassian.net/browse/SCRUM-967) ISO 27701 privacy extension

Q3 2026:
- [SCRUM-978 TRUST-07](https://arkova.atlassian.net/browse/SCRUM-978) UK Cyber Essentials Plus assessment

Q4 2026:
- [SCRUM-968 TRUST-11](https://arkova.atlassian.net/browse/SCRUM-968) CSA STAR L2 third-party audit

Conditional (vertical-triggered):
- [SCRUM-982 TRUST-14](https://arkova.atlassian.net/browse/SCRUM-982) HITRUST i1 — healthcare
- [SCRUM-983 TRUST-15](https://arkova.atlassian.net/browse/SCRUM-983) StateRAMP — public sector

### MCP-SEC (SCRUM-918) → 10 children

Re-linked existing:
- SCRUM-919 MCP-SEC-01 rate limiting
- SCRUM-920 MCP-SEC-02 HMAC signing
- SCRUM-921 MCP-SEC-03 scoped role / JWT forwarding
- SCRUM-922 MCP-SEC-04 idempotency keys
- SCRUM-923 MCP-SEC-05 prompt-injection framing
- SCRUM-924 MCP-SEC-06 audit logging
- SCRUM-929 MCP-SEC-10 feature-flag kill switch

New (gap fills):
- [SCRUM-984 MCP-SEC-07](https://arkova.atlassian.net/browse/SCRUM-984) Tool-argument Zod validation
- [SCRUM-985 MCP-SEC-08](https://arkova.atlassian.net/browse/SCRUM-985) IP allowlist + Cloudflare bot-management
- [SCRUM-987 MCP-SEC-09](https://arkova.atlassian.net/browse/SCRUM-987) Anomaly detection + Sentry alerting

### GME7 (SCRUM-827), GME8 (SCRUM-828), CONT (SCRUM-874), FEDCONT (SCRUM-875) → 2 new each

- [SCRUM-998 GME7.4](https://arkova.atlassian.net/browse/SCRUM-998) Calibration knot validation + CI guard
- [SCRUM-999 GME7.5](https://arkova.atlassian.net/browse/SCRUM-999) Per-type calibration monitoring dashboard
- [SCRUM-992 GME8.5](https://arkova.atlassian.net/browse/SCRUM-992) Domain router production cutover + A/B rollout
- [SCRUM-993 GME8.6](https://arkova.atlassian.net/browse/SCRUM-993) Domain router observability + metrics dashboard
- [SCRUM-994 CONT-01](https://arkova.atlassian.net/browse/SCRUM-994) Contract doctrine fundamentals
- [SCRUM-995 CONT-05](https://arkova.atlassian.net/browse/SCRUM-995) Arbitration + choice-of-law clause detection
- [SCRUM-996 FEDCONT-04](https://arkova.atlassian.net/browse/SCRUM-996) CMMC Level 1/2/3 control mapping
- [SCRUM-997 FEDCONT-05](https://arkova.atlassian.net/browse/SCRUM-997) 2 CFR 200 Uniform Guidance

## Sarah Sprint 1 release — final composition

19 stories, fixVersion = "Sarah Sprint 1":

| Area | Count | Sample |
|------|-------|--------|
| TRUST (compliance + procurement) | 15 | TRUST-01 SOC 2 observation, TRUST-07 CE+, TRUST-12 SOC 2 audit |
| MCP-SEC (edge worker security) | 3 | MCP-SEC-07 Zod validation, MCP-SEC-08 IP allowlist, MCP-SEC-09 anomaly detection |
| SEC IAPD | 1 | SCRUM-727 fetcher (parser shipped in #459) |

This replaces the stale 34-ticket first draft where all items turned out to be already Done. Items are all verified-open-in-Jira as of 2026-04-21.

## How to audit epic hygiene going forward

1. Quarterly: run `jql = project = SCRUM AND issuetype = Epic AND statusCategory != Done` and for each, count children via `jql = parent = <EPIC>`.
2. Flag any epic with zero children or fewer children than the epic description implies.
3. File missing child stories using the CLAUDE.md §0 STORY-FORMAT MANDATE template.
4. For every new epic, require ≥1 child story as part of Definition of Ready.

## Rules added to the process

- **Epics without children are DoR failures.** An epic should never move out of "To Do" with 0 children. This is now treated as a gate.
- **Child stories must set `parent = <EPIC-KEY>` at creation time.** Separate "create then link" flow is error-prone — the MCP-SEC disconnect happened because children were filed without a parent reference.
- **"Summary contains <label>" is not the same as "child of <epic>".** Use the `parent` field, not JQL text matching, to enumerate epic children.

## Follow-ups

- The 23 new stories need their Definition of Ready checklists filled in. Carson/Sarah own that — engineering doesn't file DoR for work it hasn't scoped.
- `docs/BACKLOG.md` should be regenerated from the new epic tree (next session).
- `CLAUDE.md` Section 5 story-status table is structurally stale (all 34 items the first Sarah draft listed turned out to be already Done). A separate ticket should be filed to automate this.
