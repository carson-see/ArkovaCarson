/**
 * Typed RPC Helper (AUDIT-21)
 *
 * Provides type-safe wrappers for Supabase RPCs that aren't yet in the
 * generated database.types.ts (migrations 0059-0066 pending production apply).
 *
 * Once OPS-01 completes and types are regenerated, this file can be removed
 * and callers can use db.rpc() directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// RPC Argument and Return type definitions
// ---------------------------------------------------------------------------

/** check_ai_credits(p_org_id, p_user_id, p_credits_needed) → boolean */
export interface CheckAiCreditsArgs {
  p_org_id: string;
  p_user_id: string;
  p_credits_needed: number;
}

/** deduct_ai_credits(p_org_id, p_user_id, p_credits, p_event_type, p_provider, p_tokens_used) */
export interface DeductAiCreditsArgs {
  p_org_id: string;
  p_user_id: string;
  p_credits: number;
  p_event_type: string;
  p_provider: string;
  p_tokens_used: number;
}

/** get_extraction_accuracy(p_credential_type, p_days) → accuracy stats */
export interface GetExtractionAccuracyArgs {
  p_credential_type?: string;
  p_days?: number;
}

/** get_flag(p_flag_id) → flag value */
export interface GetFlagArgs {
  p_flag_id: string;
}

/** search_public_credential_embeddings / search_credential_embeddings */
export interface SearchEmbeddingsArgs {
  p_embedding: number[];
  p_match_count?: number;
  p_match_threshold?: number;
  p_org_id?: string;
}

/** anonymize_user_data(p_user_id) */
export interface AnonymizeUserDataArgs {
  p_user_id: string;
}

// ---------------------------------------------------------------------------
// Typed RPC call wrapper
// ---------------------------------------------------------------------------

/**
 * Call a Supabase RPC function with proper typing.
 *
 * This wraps `db.rpc()` to avoid `as any` casts throughout the codebase.
 * The generic parameter `T` represents the expected return type.
 *
 * @example
 *   const { data, error } = await callRpc<boolean>(db, 'check_ai_credits', { ... });
 */
export async function callRpc<T = unknown>(
  client: SupabaseClient,
  fnName: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (client.rpc as any)(fnName, args);
  return result as { data: T | null; error: { message: string; code?: string } | null };
}
