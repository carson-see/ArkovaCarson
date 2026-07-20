-- WH-7 (SCRUM-2899) — webhook delivery health / regression verification query
--
-- Read-only. Run against prod (project vzwyaatejekddvltxyye) BEFORE the flag flip
-- to capture the baseline, and AFTER the fix soaks + ENABLE_OUTBOUND_WEBHOOKS is
-- flipped ON to confirm the "TypeError: fetch failed" silent-drop class has gone
-- to ~0. The failure mode this fix targets is the idempotency-lookup / delivery-
-- log transport failure (~594/wk aggregate, ~13/wk permanent silent drops); the
-- signal that it is fixed is: no growth in `log_write` dead-letter rows and a
-- healthy success:failed ratio in the delivery log.
--
-- Nothing here writes. Safe to run any time.

-- 1) webhook_delivery_logs status buckets, current + prior ISO week.
--    Watch: `failed` and `retrying` should not grow week-over-week after the fix;
--    `success` should dominate. A spike in `pending` that never resolves is the
--    old rotten-socket signature.
SELECT
  date_trunc('week', created_at) AS iso_week,
  status,
  count(*)                        AS n
FROM webhook_delivery_logs
WHERE created_at >= date_trunc('week', now()) - interval '1 week'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- 2) Dead-letter queue by failure_kind per week.
--    `log_write`   = audit-integrity preservation (the WH-3 path — a persistent
--                    idempotency-lookup / delivery-log write failure that would
--                    previously have been a SILENT drop). Post-fix this should be
--                    ~0/wk; any nonzero rows are events preserved rather than lost.
--    `http_delivery` = endpoint exhausted retries (customer-endpoint problem, not
--                    our transport). Expected to be small and unrelated to WH-1.
SELECT
  date_trunc('week', failed_at) AS iso_week,
  failure_kind,
  count(*)                       AS n,
  count(*) FILTER (WHERE resolved) AS resolved_n
FROM webhook_dead_letter_queue
WHERE failed_at >= now() - interval '8 weeks'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- 3) Single-number regression gauge: unresolved `log_write` DLQ rows in the last
--    7 days. This is the direct proxy for the ~13/wk silent drops. Target ≈ 0.
SELECT count(*) AS log_write_dlq_last_7d
FROM webhook_dead_letter_queue
WHERE failure_kind = 'log_write'
  AND resolved = false
  AND failed_at >= now() - interval '7 days';
