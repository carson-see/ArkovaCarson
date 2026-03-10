/**
 * Verification Event Logger
 *
 * Fire-and-forget helper for logging public verification events.
 * Calls the log_verification_event RPC (SECURITY DEFINER) which
 * allows unauthenticated callers to insert into verification_events.
 *
 * Failures are logged to console but never block the verification flow.
 *
 * @see P6-TS-06
 */

import { supabase } from '@/lib/supabase';

type VerificationMethod = 'web' | 'api' | 'embed' | 'qr';
type VerificationResult = 'verified' | 'revoked' | 'not_found' | 'error';

interface LogVerificationEventParams {
  publicId: string;
  method: VerificationMethod;
  result: VerificationResult;
  fingerprintProvided?: boolean;
}

/**
 * Log a verification event. Fire-and-forget — never throws.
 */
export async function logVerificationEvent({
  publicId,
  method,
  result,
  fingerprintProvided = false,
}: LogVerificationEventParams): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase.rpc as any)('log_verification_event', {
      p_public_id: publicId,
      p_method: method,
      p_result: result,
      p_fingerprint_provided: fingerprintProvided,
      p_user_agent: navigator.userAgent ?? null,
      p_referrer: document.referrer || null,
    });
  } catch {
    // Fire-and-forget — verification event logging must never block the user flow
  }
}
