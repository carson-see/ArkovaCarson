# SECURED Anchor Backfill Webhook Behavior

Arkova's production recovery path can bulk-promote historical anchors from `SUBMITTED` to `SECURED` after the Bitcoin transaction has already confirmed. During that backfill, Arkova emits one signed `anchor.secured` webhook for each affected anchor so customer systems receive the same durable integration signal they expect from the normal confirmation flow.

Backfill promotions intentionally do not replay historical secured-email notifications. That avoids sending a large delayed email burst to end users while preserving webhook delivery for systems that need to synchronize status.

