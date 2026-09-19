// Isolated UAT harness for SCRUM-5024 (partner referrals). Stubs the two
// `@/lib/supabase` calls `useReferrals` makes directly — `.from('referral_codes')
// .select().eq().eq().maybeSingle()` and `.rpc('get_org_referrals' | 'ensure_org_referral_code', ...)`
// — so `ReferralPanel` (the component that actually changed) renders its real
// data path with no live Supabase project.
const activeCode = 'ARK7Q2XK';

const referred = [
  {
    organization_public_id: 'org_pub_hakichain',
    display_name: 'HakiChain Legal Aid',
    referred_at: '2026-09-01T14:22:00.000Z',
    verification_status: 'VERIFIED',
  },
  {
    organization_public_id: 'org_pub_certen',
    display_name: 'CERTEN Notary Partners',
    referred_at: '2026-08-24T09:05:00.000Z',
    verification_status: 'UNVERIFIED',
  },
  {
    organization_public_id: null,
    display_name: 'Legacy Pre-Backfill Org',
    referred_at: '2026-07-11T18:40:00.000Z',
    verification_status: 'VERIFIED',
  },
];

export const supabase = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'uat-token' } } }) },
  from: (table: string) => {
    if (table === 'referral_codes') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { code: activeCode }, error: null }),
            }),
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  },
  rpc: async (fn: string) => {
    if (fn === 'get_org_referrals') return { data: referred, error: null };
    if (fn === 'ensure_org_referral_code') return { data: activeCode, error: null };
    return { data: null, error: null };
  },
};
