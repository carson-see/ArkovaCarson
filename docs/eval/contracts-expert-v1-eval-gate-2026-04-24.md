# Contracts Expert v1 Vertex Eval Gate

Status: SCRUM-864 engineering prep. The live Vertex tuning job was not submitted by Codex because it requires human-owned GCP credentials, spend approval, and endpoint hygiene checks before and after the run.

## Manifest encoded in code

`services/worker/src/ai/contracts/contracts-vertex-eval.ts` defines the expected tuning manifest:

- display name: `arkova-gemini-contracts-expert-v1`
- base model: `gemini-2.5-flash`
- epochs: `8`
- adapter size: `ADAPTER_SIZE_FOUR`
- intermediate checkpoints: must remain undeployed

## Eval gate

The threshold checker enforces the Jira acceptance gates:

| Metric | Gate |
|---|---:|
| Macro F1 | >= 0.85 |
| Structured term accuracy | >= 0.90 |
| Auto-renewal F1 | >= 0.85 |
| Unusual-clause F1 | >= 0.75 |
| Missing-clause F1 | >= 0.70 |
| Cross-document F1 | >= 0.85 |
| URL accuracy | 1.00 |
| Latency p50 | <= 5000 ms |
| v7 uplift | > 10 pp |

## Stratified eval plan

The helper builds a 200-entry stratified eval plan with equal representation across required strata when each stratum has enough examples. Unit coverage asserts the release gate fails closed when any metric misses its threshold.

## Human runbook

Before running SCRUM-864 live:

1. Audit current Vertex endpoints and delete idle intermediate endpoints.
2. Upload contracts JSONL to the approved GCS bucket.
3. Submit Vertex supervised tuning with the manifest above.
4. Wait for job state `SUCCEEDED`.
5. Run the 200-entry stratified eval and commit the real metrics report.
6. Undeploy any intermediate checkpoints created during the run.
7. Update Confluence and Jira with the tuning job ID, model endpoint, metrics, and endpoint-cleanup confirmation.
