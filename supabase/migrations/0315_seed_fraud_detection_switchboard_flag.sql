-- SCRUM-1955: Seed default-off switchboard row for the client-side fraud detection Web Worker.
-- Purpose: allow platform admins to explicitly enable ENABLE_FRAUD_DETECTION after review.
--
-- ROLLBACK:
-- DELETE FROM public.switchboard_flags
-- WHERE flag_key = 'ENABLE_FRAUD_DETECTION';

INSERT INTO public.switchboard_flags (flag_key, enabled, description)
VALUES (
  'ENABLE_FRAUD_DETECTION',
  false,
  'Client-side deterministic fraud detection Web Worker. Sends structured findings only; document bytes remain in-browser.'
)
ON CONFLICT (flag_key) DO NOTHING;
