import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { verifyEmailConfirmationToken } from '../auth.js';
import { getDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import { buildOAuthEmailConfirmationEmail } from '../email/templates.js';
import { buildEmailConfirmationUrl } from '../lib/urls.js';
import { createEmailConfirmationRouter, confirmationStateSchema, type ConfirmationDependencies } from './email-confirmation.js';

// verifyOtp/refreshSession mutate a Supabase client's active Authorization even with
// persistSession:false. Never call them on the shared service-role DB client.
function isolatedAuth() {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }).auth;
}
const dependencies: ConfirmationDependencies = {
  identify: async (req) => {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ')
      ? verifyEmailConfirmationToken(header.slice(7), config, logger) : null;
  },
  manage: async (action, args = {}) => {
    const { data, error } = await getDb().rpc('manage_oauth_email_confirmation', { p_action: action, ...args });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Confirmation state unavailable');
    return confirmationStateSchema.parse(data);
  },
  generate: async (email) => {
    const { data, error } = await getDb().auth.admin.generateLink({ type: 'magiclink', email });
    if (error || !data.user.email || !data.properties.hashed_token) throw new Error('Confirmation delivery unavailable');
    return { userId: data.user.id, email: data.user.email, tokenHash: data.properties.hashed_token };
  },
  prove: async (tokenHash) => {
    const { data, error } = await isolatedAuth().verifyOtp({ type: 'magiclink', token_hash: tokenHash });
    if (error || !data.user?.email || !data.session?.refresh_token) throw new Error('Invalid mailbox proof');
    return { userId: data.user.id, email: data.user.email, refreshToken: data.session.refresh_token };
  },
  refresh: async (refreshToken) => {
    const { data, error } = await isolatedAuth().refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return null;
    return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
  },
  deliver: async (email, tokenHash, userId) => {
    const content = buildOAuthEmailConfirmationEmail(buildEmailConfirmationUrl(tokenHash));
    const result = await sendEmail({ to: email, ...content, emailType: 'account_verification', actorId: userId });
    return result.success && Boolean(result.messageId) && result.messageId !== 'dev-mode-skipped';
  },
};
export const emailConfirmationRouter = createEmailConfirmationRouter(dependencies);
