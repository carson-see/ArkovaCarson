# Arkova Feature Flag Register

Date: 2026-05-01
Status: Active audit artifact
Owner: Launch control / engineering

## Executive Summary

Found **62** distinct feature-flag or environment-safety references across code, migrations, docs, deploy config, and examples.

The important hygiene finding is that Arkova does not currently have one flag system. Flags are split across worker env config, DB switchboard rows, frontend defaults, integration kill switches, edge env, deploy scripts, and docs. That is manageable only if a canonical register becomes the operating source of truth.

## P0/P1 Drift Findings

| Priority | Finding | Evidence | Required action |
| --- | --- | --- | --- |
| P1 | ENABLE_MCP_SERVER absent from worker flagRegistry | flagRegistry.ts claims to centralize worker feature flags, but this launch-critical flag is not loaded/logged there. | Add to canonical registry or update architecture so operators know this flag is controlled elsewhere. |
| P1 | ENABLE_X402_FACILITATOR absent from worker flagRegistry | flagRegistry.ts claims to centralize worker feature flags, but this launch-critical flag is not loaded/logged there. | Add to canonical registry or update architecture so operators know this flag is controlled elsewhere. |
| P1 | ENABLE_AI_EXTRACTION has conflicting parsed defaults | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |
| P1 | ENABLE_AI_FRAUD has conflicting parsed defaults | docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |
| P1 | ENABLE_AI_REPORTS has conflicting parsed defaults | docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |
| P1 | ENABLE_SEMANTIC_SEARCH has conflicting parsed defaults | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |
| P0 | ENABLE_VERIFICATION_API has conflicting parsed defaults | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |
| P1 | ENABLE_X402_PAYMENTS has conflicting parsed defaults | frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=false | Define environment-specific defaults in the canonical register and stop relying on scattered fallback values. |

## Launch-Critical Flags

| Priority | Flag | Classification | Why it matters | Parsed defaults | Sources |
| --- | --- | --- | --- | --- | --- |
| P0 | `ENABLE_DOCUSIGN_OAUTH` | launch-critical | DocuSign organization account connection | docs/reference/ENV.md=false | env-doc, integration-kill-switch, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_DOCUSIGN_WEBHOOK` | launch-critical | DocuSign completed-contract automation | docs/reference/ENV.md=false | env-doc, integration-kill-switch, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_DRIVE_OAUTH` | launch-critical | Google Drive account connection | docs/reference/ENV.md=false | docs, env-doc, integration-kill-switch, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_DRIVE_WEBHOOK` | launch-critical | Google Drive watched-folder automation | docs/reference/ENV.md=false | env-doc, integration-kill-switch, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_GRC_INTEGRATIONS` | launch-critical | GRC config/switchboard name currently used elsewhere | docs/reference/ENV.md=false; supabase-seed-default=false; supabase-seed-value=false; worker-config=false | db-seed-or-migration, docs, env-doc, integration-kill-switch, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_ORG_CREDIT_ENFORCEMENT` | launch-critical | Bitcoin cost-control credits | docs/reference/ENV.md=false | env-doc, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_PROD_NETWORK_ANCHORING` | launch-critical | Real anchoring vs mock anchoring | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=false; supabase-seed-default=false; supabase-seed-value=false | db-seed-or-migration, deploy-config, docs, env-doc, env-example, frontend-admin-ui, frontend-code, frontend-switchboard, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_QUEUE_REMINDERS` | launch-critical | Queue reminder/digest behavior | docs/reference/ENV.md=true; worker-config=true | env-doc, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_RULES_ENGINE` | launch-critical | Rule evaluation for automation | docs/reference/ENV.md=true; worker-config=true | docs, env-doc, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_RULE_ACTION_DISPATCHER` | launch-critical | Rule action fan-out | docs/reference/ENV.md=true; worker-config=true | env-doc, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_VERIFICATION_API` | launch-critical | External API beta access | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | db-seed-or-migration, deploy-config, docs, env-doc, env-example, frontend-admin-ui, frontend-switchboard, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_WEBHOOK_HMAC` | launch-critical | Inbound webhook security | docs/reference/ENV.md=true; worker-config=true | env-doc, other, worker-code, worker-config, worker-registry |
| P0 | `ENABLE_WORKSPACE_RENEWAL` | launch-critical | Drive watch renewal | docs/reference/ENV.md=false; worker-config=false | env-doc, other, worker-code, worker-config, worker-registry |
| P0 | `MAINTENANCE_MODE` | environment-safety | Environment-wide runtime behavior; must be explicit in launch config. | frontend-switchboard=false; supabase-seed-default=false; supabase-seed-value=false | db-seed-or-migration, frontend-admin-ui, frontend-code, frontend-switchboard, worker-registry |
| P0 | `USE_MOCKS` | environment-safety | Environment-wide runtime behavior; must be explicit in launch config. | .env.example=false; docs/reference/ENV.md=false | deploy-config, env-doc, env-example, other, worker-code, worker-config, worker-registry |
| P1 | `ENABLE_ALLOCATION_ROLLOVER` | launch-critical | Monthly credit rollover policy | docs/reference/ENV.md=false; worker-config=false | docs, env-doc, other, worker-code, worker-config, worker-registry |
| P1 | `ENABLE_MCP_SERVER` | launch-critical | MCP server exposure | docs/reference/ENV.md=false | docs, edge-code, env-doc |
| P1 | `ENABLE_TREASURY_ALERTS` | launch-critical | Spend/treasury alerting | docs/reference/ENV.md=true; worker-config=true | env-doc, other, worker-code, worker-config, worker-registry |
| P1 | `ENABLE_X402_FACILITATOR` | launch-critical | x402 facilitator endpoint | docs/reference/ENV.md=false | edge-code, env-doc |
| P1 | `ENABLE_X402_PAYMENTS` | launch-critical | Agentic payment enforcement | frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=false | db-seed-or-migration, docs, frontend-admin-ui, frontend-switchboard, worker-code, worker-registry |

## Registry Coverage

| Registry / surface | Flags currently known there |
| --- | --- |
| db_seed | `ENABLE_AI_EXTRACTION`, `ENABLE_AI_FRAUD`, `ENABLE_AI_REPORTS`, `ENABLE_GRC_INTEGRATIONS`, `ENABLE_NEW_CHECKOUTS`, `ENABLE_OUTBOUND_WEBHOOKS`, `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_REPORTS`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_VERIFICATION_API`, `ENABLE_X402_PAYMENTS`, `MAINTENANCE_MODE` |
| frontend_switchboard | `ENABLE_AI_EXTRACTION`, `ENABLE_AI_FRAUD`, `ENABLE_AI_REPORTS`, `ENABLE_ATTESTATION_ANCHORING`, `ENABLE_BATCH_ANCHORING`, `ENABLE_NEW_CHECKOUTS`, `ENABLE_OUTBOUND_WEBHOOKS`, `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_PUBLIC_RECORDS_INGESTION`, `ENABLE_PUBLIC_RECORD_ANCHORING`, `ENABLE_PUBLIC_RECORD_EMBEDDINGS`, `ENABLE_REPORTS`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_VERIFICATION_API`, `ENABLE_X402_PAYMENTS`, `MAINTENANCE_MODE` |
| integration_killswitch | `ENABLE_ATS_WEBHOOK`, `ENABLE_DOCUSIGN_OAUTH`, `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`, `ENABLE_GRC_INTEGRATIONS` |
| platform_controls | `ENABLE_AI_EXTRACTION`, `ENABLE_AI_FRAUD`, `ENABLE_AI_REPORTS`, `ENABLE_ATTESTATION_ANCHORING`, `ENABLE_BATCH_ANCHORING`, `ENABLE_NEW_CHECKOUTS`, `ENABLE_OUTBOUND_WEBHOOKS`, `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_PUBLIC_RECORDS_INGESTION`, `ENABLE_PUBLIC_RECORD_ANCHORING`, `ENABLE_PUBLIC_RECORD_EMBEDDINGS`, `ENABLE_REPORTS`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_VERIFICATION_API`, `ENABLE_X402_PAYMENTS`, `MAINTENANCE_MODE` |
| worker_config_comments | `ENABLE_ADES_SIGNATURES`, `ENABLE_AI_FALLBACK`, `ENABLE_ALLOCATION_ROLLOVER`, `ENABLE_ATS_WEBHOOK`, `ENABLE_CLOUD_LOGGING_SINK`, `ENABLE_CONSTRAINED_DECODING`, `ENABLE_DEMO_INJECTOR`, `ENABLE_DOCUSIGN_OAUTH`, `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`, `ENABLE_GRC_INTEGRATIONS`, `ENABLE_MULTIMODAL_EMBEDDINGS`, `ENABLE_NESSIE_RAG_RECOMMENDATIONS`, `ENABLE_ORG_CREDIT_ENFORCEMENT`, `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_QUEUE_REMINDERS`, `ENABLE_RULES_ENGINE`, `ENABLE_RULE_ACTION_DISPATCHER`, `ENABLE_SYNTHETIC_DATA`, `ENABLE_TREASURY_ALERTS`, `ENABLE_VEREMARK_WEBHOOK`, `ENABLE_VERIFICATION_API`, `ENABLE_VERTEX_AI`, `ENABLE_VISUAL_FRAUD_DETECTION`, `ENABLE_WEBHOOK_HMAC`, `ENABLE_WORKSPACE_RENEWAL`, `USE_MOCKS` |
| worker_registry | `ENABLE_ADES_SIGNATURES`, `ENABLE_AI_EXTRACTION`, `ENABLE_AI_FALLBACK`, `ENABLE_AI_FRAUD`, `ENABLE_AI_REPORTS`, `ENABLE_ALLOCATION_ROLLOVER`, `ENABLE_ATS_WEBHOOK`, `ENABLE_ATTESTATION_ANCHORING`, `ENABLE_BATCH_ANCHORING`, `ENABLE_CLOUD_LOGGING_SINK`, `ENABLE_COMPLIANCE_ENGINE`, `ENABLE_DEMO_INJECTOR`, `ENABLE_DOCUSIGN_OAUTH`, `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`, `ENABLE_EXPIRY_ALERTS`, `ENABLE_GRC_INTEGRATIONS`, `ENABLE_MULTIMODAL_EMBEDDINGS`, `ENABLE_NESSIE_RAG_RECOMMENDATIONS`, `ENABLE_NEW_CHECKOUTS`, `ENABLE_ORG_CREDIT_ENFORCEMENT`, `ENABLE_OUTBOUND_WEBHOOKS`, `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_PUBLIC_RECORDS_INGESTION`, `ENABLE_PUBLIC_RECORD_ANCHORING`, `ENABLE_PUBLIC_RECORD_EMBEDDINGS`, `ENABLE_QUEUE_REMINDERS`, `ENABLE_REPORTS`, `ENABLE_RULES_ENGINE`, `ENABLE_RULE_ACTION_DISPATCHER`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_SYNTHETIC_DATA`, `ENABLE_TREASURY_ALERTS`, `ENABLE_VEREMARK_WEBHOOK`, `ENABLE_VERIFICATION_API`, `ENABLE_VERTEX_AI`, `ENABLE_VISUAL_FRAUD_DETECTION`, `ENABLE_WEBHOOK_HMAC`, `ENABLE_WORKSPACE_RENEWAL`, `ENABLE_X402_PAYMENTS`, `MAINTENANCE_MODE`, `USE_MOCKS` |

## Full Inventory

| Flag | Priority | Classification | Parsed defaults | Example references |
| --- | --- | --- | --- | --- |
| `ENABLE_ADES_SIGNATURES` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:352, scripts/ci/snapshots/worker-env-adhoc-baseline.json:31, docs/stories/23_phase3_esignatures.md:903 |
| `ENABLE_AI_EXTRACTION` | P2 | roadmap-or-optional | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | .env.example:105, scripts/deploy-worker.sh:35, docs/reference/ENV.md:401 |
| `ENABLE_AI_FALLBACK` | P3 | unclassified | .env.example=false; docs/reference/ENV.md=false; worker-config=false | .env.example:97, docs/reference/ENV.md:147, docs/wiki/TECHNICAL_SECURITY_WIKI.md:389 |
| `ENABLE_AI_FRAUD` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | docs/reference/ENV.md:403, docs/reference/ENV.md:407, supabase/seed.sql:204 |
| `ENABLE_AI_REPORTS` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | docs/reference/ENV.md:404, supabase/seed.sql:206, .github/workflows/deploy-worker.yml:140 |
| `ENABLE_ALLOCATION_ROLLOVER` | P1 | launch-critical | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:298, docs/runbooks/billing/phase-3-rollover-grace.md:32, scripts/ci/snapshots/worker-env-adhoc-baseline.json:33 |
| `ENABLE_ATS_WEBHOOK` | P2 | roadmap-or-optional | docs/reference/ENV.md=false | docs/reference/ENV.md:346, services/worker/src/config.test.ts:484, services/worker/src/config.ts:552 |
| `ENABLE_ATTESTATION_ANCHORING` | P2 | platform-switchboard | frontend-switchboard=true | src/pages/PlatformControlsPage.tsx:52, docs/runbooks/anchor-disk-hygiene.md:82, docs/stories/22_phase2_agentic_layer.md:61 |
| `ENABLE_BATCH_ANCHORING` | P2 | platform-switchboard | frontend-switchboard=false | src/pages/PlatformControlsPage.tsx:60, services/worker/src/jobs/batch-anchor.ts:10, services/worker/src/jobs/batch-anchor.ts:14 |
| `ENABLE_CLOUD_LOGGING_SINK` | P3 | unclassified | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:377, scripts/ci/snapshots/worker-env-adhoc-baseline.json:34, docs/runbooks/gcp-max-setup.md:93 |
| `ENABLE_COMPLIANCE_ENGINE` | P2 | roadmap-or-optional | No parsed default | supabase/migrations/0196_compliance_engine_flags.sql:3, supabase/migrations/0196_compliance_engine_flags.sql:20, supabase/migrations/0196_compliance_engine_flags.sql:24 |
| `ENABLE_CONSTRAINED_DECODING` | P3 | unclassified | docs/reference/ENV.md=false | docs/reference/ENV.md:189, scripts/ci/snapshots/worker-env-adhoc-baseline.json:35, services/worker/src/config.ts:534 |
| `ENABLE_DEMO_INJECTOR` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:390, scripts/ci/snapshots/worker-env-adhoc-baseline.json:36, services/worker/src/config.test.ts:479 |
| `ENABLE_DOCUSIGN_OAUTH` | P0 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:282, services/worker/src/config.test.ts:482, services/worker/src/config.ts:389 |
| `ENABLE_DOCUSIGN_WEBHOOK` | P0 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:287, services/worker/src/config.test.ts:483, services/worker/src/config.ts:403 |
| `ENABLE_DRIVE_OAUTH` | P0 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:334, docs/runbooks/oauth-state-secret-rotation.md:94, services/worker/src/config.test.ts:203 |
| `ENABLE_DRIVE_WEBHOOK` | P0 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:335, services/worker/src/config.test.ts:481, services/worker/src/config.ts:544 |
| `ENABLE_DSAR_UI` | P3 | unclassified | No parsed default | src/lib/env.ts:44 |
| `ENABLE_EMAIL_NOTIFICATIONS` | P3 | unclassified | No parsed default | docs/stories/16_beta_readiness.md:157 |
| `ENABLE_EXPIRY_ALERTS` | P3 | unclassified | No parsed default | services/worker/src/routes/cron.ts:718, services/worker/src/routes/cron.ts:719, docs/stories/27_nessie_compliance_engine.md:337 |
| `ENABLE_FRAUD_SIGNALS` | P3 | unclassified | No parsed default | services/worker/src/api/v1/verify.test.ts:442 |
| `ENABLE_GEMB2` | P3 | unclassified | No parsed default | docs/design/gemb2/gemb2-01-spike.md:37, docs/design/gemb2/gemb2-01-spike.md:155, services/worker/src/ai/embeddings/gemini2.ts:16 |
| `ENABLE_GEMB2_BACKFILL` | P3 | unclassified | No parsed default | docs/design/gemb2/gemb2-02-rag-swap.md:54, docs/design/gemb2/gemb2-02-rag-swap.md:55 |
| `ENABLE_GEMB2_RAG` | P3 | unclassified | No parsed default | docs/design/gemb2/gemb2-02-rag-swap.md:48, docs/design/gemb2/gemb2-02-rag-swap.md:50, docs/design/gemb2/gemb2-02-rag-swap.md:56 |
| `ENABLE_GRACE_EXPIRY_SWEEP` | P3 | unclassified | docs/reference/ENV.md=true | docs/reference/ENV.md:302, docs/runbooks/billing/phase-3-rollover-grace.md:33 |
| `ENABLE_GRC_INTEGRATIONS` | P0 | launch-critical | docs/reference/ENV.md=false; supabase-seed-default=false; supabase-seed-value=false; worker-config=false | docs/reference/ENV.md:345, supabase/seed.sql:208, scripts/ci/snapshots/worker-env-adhoc-baseline.json:37 |
| `ENABLE_INT10_WORKSPACE` | P3 | unclassified | No parsed default | services/worker/src/integrations/connectors/schemas.ts:17 |
| `ENABLE_INT12_ESIGN` | P3 | unclassified | No parsed default | services/worker/src/integrations/connectors/schemas.ts:18 |
| `ENABLE_INT13_ATS` | P3 | unclassified | No parsed default | services/worker/src/integrations/connectors/schemas.ts:19 |
| `ENABLE_MCP_SERVER` | P1 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:104, docs/runbooks/mcp-kill-switch.md:30, docs/runbooks/mcp-kill-switch.md:50 |
| `ENABLE_MULTIMODAL_EMBEDDINGS` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:388, scripts/ci/snapshots/worker-env-adhoc-baseline.json:38, docs/stories/28_gemini_migration_evolution.md:362 |
| `ENABLE_NESSIE_RAG_RECOMMENDATIONS` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:389, docs/runbooks/nca-audit-uat.md:77, docs/runbooks/nca-audit-uat.md:124 |
| `ENABLE_NEW_CHECKOUTS` | P2 | platform-switchboard | frontend-switchboard=true; supabase-seed-default=true; supabase-seed-value=true | supabase/seed.sql:199, src/pages/PlatformControlsPage.tsx:78, supabase/migrations/0271_restore_get_flag_again.sql:16 |
| `ENABLE_ORG_CREDIT_ENFORCEMENT` | P0 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:65, services/worker/src/config.ts:518, services/worker/src/middleware/flagRegistry.ts:29 |
| `ENABLE_ORG_KYB` | P3 | unclassified | No parsed default | docs/runbooks/kyb/middesk.md:60, services/worker/src/api/v1/org-kyb.ts:12 |
| `ENABLE_OUTBOUND_WEBHOOKS` | P2 | platform-switchboard | frontend-switchboard=false; supabase-seed-default=false; supabase-seed-value=false | supabase/seed.sql:198, src/pages/PlatformControlsPage.tsx:80, services/worker/src/webhooks/delivery.ts:454 |
| `ENABLE_PAYMENT_TIERS` | P3 | unclassified | No parsed default | services/worker/src/middleware/paymentTierRouter.ts:13 |
| `ENABLE_PROD_NETWORK_ANCHORING` | P0 | launch-critical | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=false; supabase-seed-default=false; supabase-seed-value=false | .env.example:104, docs/BETA_PRODUCTION_READINESS.md:193, scripts/deploy-worker.sh:33 |
| `ENABLE_PUBLIC_RECORDS_INGESTION` | P2 | platform-switchboard | frontend-switchboard=true | src/pages/PlatformControlsPage.tsx:49, src/pages/PlatformControlsPage.tsx:236, src/pages/PlatformControlsPage.tsx:242 |
| `ENABLE_PUBLIC_RECORD_ANCHORING` | P2 | platform-switchboard | frontend-switchboard=true | src/pages/PlatformControlsPage.tsx:50, src/pages/PlatformControlsPage.tsx:250, src/pages/PlatformControlsPage.tsx:256 |
| `ENABLE_PUBLIC_RECORD_EMBEDDINGS` | P2 | platform-switchboard | frontend-switchboard=true | docs/plans/nessie-intelligence-training-plan.md:80, docs/plans/nessie-intelligence-training-plan.md:88, src/pages/PlatformControlsPage.tsx:51 |
| `ENABLE_QUEUE_REMINDERS` | P0 | launch-critical | docs/reference/ENV.md=true; worker-config=true | docs/reference/ENV.md:223, scripts/ci/snapshots/worker-env-adhoc-baseline.json:40, services/worker/src/config.ts:222 |
| `ENABLE_REPORTS` | P2 | platform-switchboard | frontend-switchboard=true; supabase-seed-default=true; supabase-seed-value=true | supabase/seed.sql:200, src/pages/PlatformControlsPage.tsx:79, supabase/migrations/0021_switchboard_flags.sql:125 |
| `ENABLE_RULES_ENGINE` | P0 | launch-critical | docs/reference/ENV.md=true; worker-config=true | docs/reference/ENV.md:219, docs/runbooks/sec-harden/sec-harden-02-secret-manager-migration.md:121, scripts/ci/snapshots/worker-env-adhoc-baseline.json:41 |
| `ENABLE_RULE_ACTION_DISPATCHER` | P0 | launch-critical | docs/reference/ENV.md=true; worker-config=true | docs/reference/ENV.md:347, scripts/ci/snapshots/worker-env-adhoc-baseline.json:42, services/worker/src/jobs/rule-action-dispatcher.ts:25 |
| `ENABLE_SEMANTIC_SEARCH` | P2 | roadmap-or-optional | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | .env.example:106, docs/reference/ENV.md:402, supabase/seed.sql:203 |
| `ENABLE_SEMANTIC_SUPERSEDE` | P3 | unclassified | No parsed default | docs/design/gemb2/gemb2-04-supersede-spike.md:19 |
| `ENABLE_SYNTHETIC` | P3 | unclassified | No parsed default | services/worker/scripts/nessie-multi-lora-pipeline.ts:91, services/worker/scripts/nessie-multi-lora-pipeline.ts:358, services/worker/scripts/nessie-multi-lora-pipeline.ts:932 |
| `ENABLE_SYNTHETIC_DATA` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:190, scripts/ci/snapshots/worker-env-adhoc-baseline.json:43, services/worker/src/config.test.ts:560 |
| `ENABLE_TREASURY_ALERTS` | P1 | launch-critical | docs/reference/ENV.md=true; worker-config=true | docs/reference/ENV.md:227, scripts/ci/snapshots/worker-env-adhoc-baseline.json:44, services/worker/src/config.test.ts:546 |
| `ENABLE_VEREMARK_WEBHOOK` | P2 | roadmap-or-optional | docs/reference/ENV.md=false | docs/reference/ENV.md:330, docs/reference/ENV.md:331, scripts/ci/snapshots/worker-env-adhoc-baseline.json:45 |
| `ENABLE_VERIFICATION_API` | P0 | launch-critical | .env.example=false; docs/reference/ENV.md=false; frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=true | .env.example:63, scripts/deploy-worker.sh:36, docs/reference/ENV.md:74 |
| `ENABLE_VERTEX_AI` | P3 | unclassified | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:161, scripts/ci/snapshots/worker-env-adhoc-baseline.json:47, services/worker/src/config.ts:218 |
| `ENABLE_VISUAL_FRAUD_DETECTION` | P2 | roadmap-or-optional | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:405, services/worker/src/config.test.ts:478, services/worker/src/config.ts:232 |
| `ENABLE_WEBHOOK_DISPATCH` | P3 | unclassified | No parsed default | docs/stories/22_phase2_agentic_layer.md:85 |
| `ENABLE_WEBHOOK_HMAC` | P0 | launch-critical | docs/reference/ENV.md=true; worker-config=true | docs/reference/ENV.md:215, scripts/ci/snapshots/worker-env-adhoc-baseline.json:48, services/worker/src/config.ts:226 |
| `ENABLE_WORKSPACE_RENEWAL` | P0 | launch-critical | docs/reference/ENV.md=false; worker-config=false | docs/reference/ENV.md:336, scripts/ci/snapshots/worker-env-adhoc-baseline.json:49, services/worker/src/jobs/workspace-subscription-renewal.ts:138 |
| `ENABLE_X402_FACILITATOR` | P1 | launch-critical | docs/reference/ENV.md=false | docs/reference/ENV.md:96, services/edge/src/env.ts:91, services/edge/src/x402-facilitator.ts:149 |
| `ENABLE_X402_PAYMENTS` | P1 | launch-critical | frontend-switchboard=true; supabase-seed-default=false; supabase-seed-value=false | supabase/seed.sql:207, docs/reference/X402_API_ARCHITECTURE.md:98, docs/reference/X402_API_ARCHITECTURE.md:176 |
| `MAINTENANCE_MODE` | P0 | environment-safety | frontend-switchboard=false; supabase-seed-default=false; supabase-seed-value=false | supabase/seed.sql:201, src/pages/PlatformControlsPage.tsx:77, src/pages/PlatformControlsPage.tsx:89 |
| `USE_MOCKS` | P0 | environment-safety | .env.example=false; docs/reference/ENV.md=false | .env.example:22, docs/reference/ENV.md:63, services/worker/src/stripe/client.ts:7 |
| `VITE_ENABLE_DSAR_UI` | P2 | frontend-build-flag | No parsed default | docs/bugs/bug_log.md:20, src/lib/env.ts:25, src/lib/env.ts:44 |

## Immediate Hygiene Actions

1. Pick a canonical registry format and make this script generate the human-readable register from it.
2. Add every launch-critical flag to the canonical registry with owner, default, launch value, fail mode, and affected routes/jobs.
3. Keep `ENABLE_GRC_INTEGRATIONS` as the only GRC integration flag name; do not reintroduce the singular alias.
4. Decide which flags are env-only emergency kill switches versus DB switchboard rollout flags.
5. Add CI that fails when a code-referenced `ENABLE_*` flag is missing from the canonical registry or environment docs.
6. Add an admin/health readiness view that reports beta launch flag values.

## Generation

Generated by `scripts/audit_feature_flags.py`. Local `.env` files are intentionally excluded so secrets and machine-specific values do not leak into the audit artifact.
