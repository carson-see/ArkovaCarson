/**
 * Shared TOTP factor shape — SCRUM-3167 review batch (item 15/S5).
 *
 * `TwoFactorSetup.tsx` and `MfaChallenge.tsx` each declared their own local
 * `TotpFactor` interface, and the two had already drifted (only
 * `TwoFactorSetup`'s carried `factor_type`, the field E1's fix depends on
 * to build the factor list from `listFactors().data.all` instead of the
 * verified-only `data.totp`). One shared type, one place to keep it aligned
 * with the real `@supabase/auth-js` `Factor` shape.
 */

export interface TotpFactor {
  id: string;
  factor_type: 'totp';
  friendly_name?: string;
  status: 'verified' | 'unverified';
  created_at: string;
  updated_at: string;
}
