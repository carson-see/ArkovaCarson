import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SEED_USERS } from '../fixtures/supabase';
import { uniqueTestId } from './unique';

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

  const userClient = createClient(
    process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321',
    process.env.VITE_SUPABASE_ANON_KEY || '',
  );
  const { data: sessionData, error: signInError } = await userClient.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !sessionData.session) {
    await serviceClient.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in profile session user: ${signInError?.message}`);
  }

  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:5173',
        localStorage: [{
          name: 'sb-127-auth-token',
          value: JSON.stringify(sessionData.session),
        }],
      }],
    },
  });
  const page = await context.newPage();

  return { page, context, userId };
}

export async function disposeProfileSession(
  serviceClient: SupabaseClient,
  context: BrowserContext | null,
  userId: string | null,
) {
  await context?.close();
  if (userId) {
    await serviceClient.auth.admin.deleteUser(userId);
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

  try {
    const session = await createProfileSession(browser, serviceClient, options);
    context = session.context;
    userId = session.userId;
    await run(session);
  } finally {
    await disposeProfileSession(serviceClient, context, userId);
  }
}
