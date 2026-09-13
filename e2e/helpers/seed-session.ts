import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SEED_USERS } from '../fixtures/supabase';
import {
  resolveE2EFrontendOrigin,
  resolveE2ESupabaseUrl,
  supabaseAuthStorageKey,
} from './supabase-storage-key';

type SeedSession = 'individual' | 'orgAdmin' | 'orgBAdmin';

/** Borrow setup's verified token without refreshing or signing out its session. */
export async function readSeedAal2Token(user: SeedSession): Promise<string> {
  const state = JSON.parse(await readFile(resolve('.auth', `${user}.json`), 'utf8'));
  const origin = state.origins.find((entry: { origin: string }) =>
    entry.origin === resolveE2EFrontendOrigin());
  const stored = origin?.localStorage.find((entry: { name: string }) =>
    entry.name === supabaseAuthStorageKey(resolveE2ESupabaseUrl()));
  if (!stored) throw new Error(`Missing setup session for ${user}`);
  const session = JSON.parse(stored.value);
  const token: unknown = session.access_token;
  if (typeof token !== 'string') throw new Error(`Missing setup token for ${user}`);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  // This is a fixture precondition, not signature verification: the real API
  // validates the borrowed bearer and each isolation test proves own access.
  if (session.user?.id !== SEED_USERS[user].id || claims.sub !== SEED_USERS[user].id ||
      claims.role !== 'authenticated' || claims.aal !== 'aal2' ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    throw new Error(`Setup session for ${user} must be current, same-user authenticated AAL2`);
  }
  return token;
}
