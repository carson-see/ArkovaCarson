#!/usr/bin/env tsx
/**
 * Run USPTO patent fetcher manually.
 * Usage: cd services/worker && npx tsx scripts/run-uspto-fetcher.ts
 */

import { config } from 'dotenv';
config();

import { createClient } from '@supabase/supabase-js';
import { fetchUsptoPAtents } from '../src/jobs/usptoFetcher.js';

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  console.log('Starting USPTO patent fetch...');
  await fetchUsptoPAtents(db);
  console.log('Done!');
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
