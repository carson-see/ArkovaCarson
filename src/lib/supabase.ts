/**
 * Supabase Client
 *
 * Client-side Supabase client for authentication and data access.
 * Uses anonymous key only - service role key is NEVER exposed to client.
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.types';
export type { Database } from '../types/database.types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseAnonKey) {
  console.warn('VITE_SUPABASE_ANON_KEY not set. Authentication will not work.');
}

// Use a placeholder key when none is configured so the client can instantiate
// without throwing. Auth calls will fail gracefully at runtime instead.
const safeKey = supabaseAnonKey || 'missing-key-placeholder';

export const supabase = createClient<Database>(supabaseUrl, safeKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
