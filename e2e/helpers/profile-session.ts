import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SEED_USERS, WS_CLIENT_OPTIONS } from '../fixtures/supabase';
import {
  resolveE2EFrontendOrigin,
  resolveE2ESupabaseUrl,
  supabaseAuthStorageKey,
} from './supabase-storage-key';
import { uniqueTestId } from './unique';
import { totp } from './totp';

export interface TestProfileOptions {
  role: 'INDIVIDUAL' | 'ORG_ADMIN' | null;
  orgId?: string | null;
  requiresManualReview?: boolean;
  emailPrefix?: string;
  fullName?: string;
}

export interface ProfileSession {
  page: Page;
  context: BrowserContext;
  userId: string;
}

export async function createProfileSession(
  browser: Browser,
  serviceClient: SupabaseClient,
  options: TestProfileOptions,
): Promise<ProfileSession> {
  const email = `${uniqueTestId(options.emailPrefix ?? 'e2e-profile')}@test.arkova.io`;
  const password = SEED_USERS.individual.password;
  const fullName = options.fullName ?? 'E2E Profile User';

  const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !created.user) {
    throw new Error(`Failed to create profile session user: ${createError?.message}`);
  }

  const userId = created.user.id;
  const { error: profileError } = await serviceClient
    .from('profiles')
    .upsert({
      id: userId,
      email,
      full_name: fullName,
      role: options.role,
      org_id: options.orgId ?? null,
      requires_manual_review: options.requiresManualReview ?? false,
      is_public_profile: false,
      is_platform_admin: false,
      disclaimer_accepted_at: new Date().toISOString(),
    });

  if (profileError) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to prepare profile session: ${profileError.message}`);
  }

  // BUG-030 / E-2: both the Supabase URL and the localStorage key below are
  // derived, not hardcoded. `supabaseAuthStorageKey` reproduces supabase-js's
  // own default — `sb-<first host label>-auth-token` — which for the local
  // project is exactly the `sb-127-auth-token` this used to inline, and for a
  // hosted project is `sb-<project-ref>-auth-token`. See
  // `helpers/supabase-storage-key.ts`.
  const supabaseUrl = resolveE2ESupabaseUrl();
  const userClient = createClient(
    supabaseUrl,
    process.env.VITE_SUPABASE_ANON_KEY || '',
    WS_CLIENT_OPTIONS,
  );
  const { data: sessionData, error: signInError } = await userClient.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in profile session user: ${signInError?.message}`);
  }

  // Ordinary profile/role tests require a real AAL2 session. Keep the owned
  // profile's onboarding state intact; only complete this user's MFA factor.
  let context: BrowserContext | null = null;
  try {
    const { data: factor, error: enrollError } = await userClient.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'E2E profile session',
    });
    if (enrollError || !factor) throw new Error('Failed to enroll profile session MFA');
    const { error: verifyError } = await userClient.auth.mfa.challengeAndVerify({
      factorId: factor.id,
      code: totp(factor.totp.secret),
    });
    if (verifyError) throw new Error('Failed to verify profile session MFA');
    const { data: current, error: sessionError } = await userClient.auth.getSession();
    const { data: assurance, error: assuranceError } =
      await userClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (sessionError || assuranceError || current.session?.user.id !== userId ||
        assurance?.currentLevel !== 'aal2') {
      throw new Error('Profile session MFA did not produce a same-user AAL2 session');
    }

    context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [{
          // Playwright matches storageState origins by ORIGIN, so this has to be
          // the origin the browser actually visits — the dev server locally,
          // E2E_BASE_URL on a rig.
          origin: resolveE2EFrontendOrigin(),
          localStorage: [{
            name: supabaseAuthStorageKey(supabaseUrl),
            value: JSON.stringify(current.session),
          }],
        }],
      },
    });
    const page = await context.newPage();

    return { page, context, userId };
  } catch (error) {
    await disposeProfileSession(serviceClient, context, userId, { error });
    throw error;
  }
}

export async function disposeProfileSession(
  serviceClient: SupabaseClient,
  context: BrowserContext | null,
  userId: string | null,
  originalFailure?: { error: unknown },
) {
  const failures: unknown[] = originalFailure ? [originalFailure.error] : [];
  try {
    await context?.close();
  } catch {
    failures.push(new Error('Failed to close owned profile browser context'));
  }
  if (userId) {
    try {
      const { error } = await serviceClient.auth.admin.deleteUser(userId);
      if (error) throw error;
    } catch {
      failures.push(new Error('Failed to delete owned profile session user'));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Profile session operation and cleanup failed');
  }
}

export async function withProfileSession(
  browser: Browser,
  serviceClient: SupabaseClient,
  options: TestProfileOptions,
  run: (session: ProfileSession) => Promise<void>,
) {
  let context: BrowserContext | null = null;
  let userId: string | null = null;
  let originalFailure: { error: unknown } | undefined;

  try {
    const session = await createProfileSession(browser, serviceClient, options);
    context = session.context;
    userId = session.userId;
    await run(session);
  } catch (error) {
    originalFailure = { error };
  } finally {
    await disposeProfileSession(serviceClient, context, userId, originalFailure);
  }
}
