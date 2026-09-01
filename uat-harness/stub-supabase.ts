export const supabase = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'uat-token' } } }) },
};
