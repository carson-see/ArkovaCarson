# Baseline regeneration diff — superseded by `00013`

Captured 2026-08-12T15:18:00Z by `270018525501-compute@developer.gserviceaccount.com`. Old = `superseded-by-00013/day0/`, new = `day0-snapshots/`.
Every surface below is **verified**, not assumed.

## `scheduler-census.txt`

**UNCHANGED** — sha256 `49e8c3651d601e79cd4057151153a0b0721d7b8e109e7fd38771dc7a1a7fe621`

## `switchboard-flags-material.txt`

**UNCHANGED** — sha256 `05018e26af0d7a11f9067ba9d90dd01581b7e58435cdc3e14f64f809df14a8c6`

## `switchboard-flags-full.tsv`

**UNCHANGED** — sha256 `22f5945c213e3784700a9b6d5a108b0873e6598e52346f59712ae3be35a58059`

## `monitoring-census.txt`

**UNCHANGED** — sha256 `e5f1e4a02c6f9105c53c181640d04376613a84cdb07c742318372cabec0820b8`

## `rig-env-dump.txt`

**CHANGED**

```diff
--- /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/evidence/fullsoak-2026-08/day0-snapshots/superseded-by-00013/day0/rig-env-dump.txt	2026-08-12 09:53:50
+++ /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/evidence/fullsoak-2026-08/day0-snapshots/rig-env-dump.txt	2026-08-12 11:18:28
@@ -5,7 +5,7 @@
 BITCOIN_RPC_AUTH -> SECRET_REF: arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth key=latest
 BITCOIN_RPC_URL -> SECRET_REF: arkova-s33-rig-b1-bitcoin-core-signet-rpc-url key=latest
 BITCOIN_TREASURY_WIF -> SECRET_REF: treasury-wif-legacy-soak-2026-08-staging key=latest
-BITCOIN_UTXO_PROVIDER = mempool
+BITCOIN_UTXO_PROVIDER = getblock
 BUILD_SHA = f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58
 CORS_ALLOWED_ORIGINS = https://app.arkova.ai
 CRON_OIDC_AUDIENCE = https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app
@@ -45,4 +45,6 @@
 __annotation.autoscaling.knative.dev/maxScale = 5
 __annotation.autoscaling.knative.dev/minScale = 1
 __annotation.run.googleapis.com/execution-environment = None
+__annotation.run.googleapis.com/vpc-access-connector = fullsoak-btc-rpc
+__annotation.run.googleapis.com/vpc-access-egress = private-ranges-only
 __resources.limits = {"cpu": "2", "memory": "2Gi"}
```

