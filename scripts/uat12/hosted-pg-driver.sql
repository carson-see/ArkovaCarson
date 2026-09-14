\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role = 'service_role';

INSERT INTO auth.users(id, email, raw_app_meta_data, raw_user_meta_data)
VALUES ('12900000-0000-4000-8000-000000000012', 'uat12-rollback-fixture@arkova.example', '{}'::jsonb, '{}'::jsonb);
INSERT INTO public.organizations(id, legal_name, display_name)
VALUES ('12900000-0000-4000-8000-000000000120', 'UAT-12 rollback fixture', 'UAT-12 rollback fixture');
INSERT INTO public.credits(user_id, balance) VALUES ('12900000-0000-4000-8000-000000000012', 2);
INSERT INTO public.org_credits(org_id, balance) VALUES ('12900000-0000-4000-8000-000000000120', 2)
ON CONFLICT (org_id) DO UPDATE SET balance=EXCLUDED.balance;

SELECT public.create_anchor_submission(
  repeat('1', 64), 'ARK-UAT12-QUEUE', '12900000-0000-4000-8000-000000000012', NULL,
  'queue.pdf', 12, 'application/pdf', 'OTHER', 'Queue description', 'document_bytes',
  '{"existing":"kept"}', ARRAY['personal'], ARRAY[]::text[], 'queue'
);
SELECT public.create_anchor_submission(
  repeat('2', 64), 'ARK-UAT12-INSTANT', '12900000-0000-4000-8000-000000000012',
  '12900000-0000-4000-8000-000000000120', 'instant.pdf', 13, 'application/pdf',
  'OTHER', 'Instant description', 'document_bytes', '{"existing":"kept"}',
  ARRAY['personal'], ARRAY['child-only'], 'instant'
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.anchor_private_tags t JOIN public.anchors a ON a.id=t.anchor_id
      WHERE a.public_id IN ('ARK-UAT12-QUEUE','ARK-UAT12-INSTANT')) <> 3 THEN
    RAISE EXCEPTION 'private_tag_count_mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.anchors WHERE public_id LIKE 'ARK-UAT12-%'
      AND (metadata ? 'private_tags' OR metadata ? 'user_tags' OR metadata ? 'org_tags')) THEN
    RAISE EXCEPTION 'private_tags_leaked_to_anchor_metadata';
  END IF;
  IF (SELECT count(*) FROM public.job_queue WHERE type='anchor.instant_secure'
      AND payload->>'intent_id'=(SELECT i.id::text FROM public.anchor_instant_intents i
        JOIN public.anchors a ON a.id=i.anchor_id WHERE a.public_id='ARK-UAT12-INSTANT')) <> 1 THEN
    RAISE EXCEPTION 'instant_job_not_atomic';
  END IF;
END $$;

SELECT * FROM public.claim_anchor_instant_intent(
  (SELECT i.id FROM public.anchor_instant_intents i JOIN public.anchors a ON a.id=i.anchor_id
    WHERE a.public_id='ARK-UAT12-INSTANT'), 'uat12-owned17-worker'
);

DO $$
BEGIN
  IF (SELECT balance FROM public.org_credits WHERE org_id='12900000-0000-4000-8000-000000000120') <> 1 THEN
    RAISE EXCEPTION 'canonical_org_debit_balance_mismatch';
  END IF;
  IF (SELECT count(*) FROM public.org_credit_deductions d JOIN public.anchors a ON a.id=d.reference_id
      WHERE a.public_id='ARK-UAT12-INSTANT' AND d.entry_type='DEBIT' AND d.amount=-1) <> 1 THEN
    RAISE EXCEPTION 'canonical_org_debit_missing';
  END IF;
END $$;

UPDATE public.anchors SET status='PENDING', chain_tx_id=NULL WHERE public_id='ARK-UAT12-INSTANT';
SELECT public.settle_anchor_instant_intent(
  (SELECT i.id FROM public.anchor_instant_intents i JOIN public.anchors a ON a.id=i.anchor_id
    WHERE a.public_id='ARK-UAT12-INSTANT'), 'FAILED_SAFE', 1, 'uat12_proven_prebroadcast'
);
SELECT public.settle_anchor_instant_intent(
  (SELECT i.id FROM public.anchor_instant_intents i JOIN public.anchors a ON a.id=i.anchor_id
    WHERE a.public_id='ARK-UAT12-INSTANT'), 'FAILED_SAFE', 1, 'uat12_replay'
);

DO $$
BEGIN
  IF (SELECT balance FROM public.org_credits WHERE org_id='12900000-0000-4000-8000-000000000120') <> 2 THEN
    RAISE EXCEPTION 'canonical_org_refund_balance_mismatch';
  END IF;
  IF (SELECT count(*) FROM public.org_credit_deductions d JOIN public.anchors a ON a.id=d.reference_id
      WHERE a.public_id='ARK-UAT12-INSTANT' AND d.entry_type='REFUND' AND d.amount=1) <> 1 THEN
    RAISE EXCEPTION 'canonical_org_refund_not_idempotent';
  END IF;
END $$;

SELECT 'UAT12 HOSTED PG PASS canonical_org_debit=1 safe_refund=1 replay_refund=0 private_tags=3 metadata_leaks=0 atomic_job=1';
ROLLBACK;
