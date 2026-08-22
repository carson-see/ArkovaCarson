/**
 * Snapshot-and-restore for seeded rows an E2E spec must mutate (BUG-030 / E-3).
 *
 * A spec that deletes seeded rows is only safe against a database that is
 * thrown away after the run. CI does exactly that (`db reset`), which is why
 * `identity-entitlement.spec.ts` deleting the seed individual's `subscriptions`
 * row went unnoticed. A daily runner against a long-lived rig — the whole point
 * of making the suite portable — instead destroys the seed permanently on the
 * first run, and every later run, plus every other spec that assumes a seeded
 * subscription, is then testing a database the seed no longer describes.
 *
 * Contract:
 *   - Capture BEFORE the first destructive statement. A failed read throws at
 *     capture time; it must never degrade into "captured nothing", because a
 *     no-op restore reproduces the original defect behind a helper that looks
 *     like a fix.
 *   - Restore puts the ORIGINAL rows back, primary keys included — not a
 *     freshly-minted equivalent.
 *   - An empty snapshot restores to empty. "No row" is a legitimate seed state.
 *   - Restore is idempotent: Playwright still runs `afterAll` after a failed
 *     test, and a retry can enter the hook twice.
 *
 * The Supabase call surface is narrowed to {@link RowStore} so the orchestration
 * is unit-testable without a database (`tests/infra/row-snapshot.test.ts`) —
 * the same pure-core/thin-wrapper split as `cross-tenant-assertions.ts` and
 * `soaking-ref-guard.ts`.
 */

export interface StoreError {
  message: string;
}

/** One table, already narrowed to the rows a spec is about to mutate. */
export interface RowStore<T> {
  select(): Promise<{ data: T[] | null; error: StoreError | null }>;
  deleteMatching(): Promise<{ error: StoreError | null }>;
  insert(rows: T[]): Promise<{ error: StoreError | null }>;
}

export interface RowSnapshot<T> {
  /** The rows as they existed at capture time (a defensive copy). */
  readonly rows: T[];
  /** Delete whatever the spec left behind and put the captured rows back. */
  restore(): Promise<void>;
}

/**
 * Read and hold the current rows so they can be put back verbatim.
 *
 * @param label human-readable identity of what is being snapshotted, e.g.
 *   `subscriptions(user=demo-user)`. It is the only thing that makes a failure
 *   in a hook legible, so pass something specific.
 */
export async function captureRows<T>(store: RowStore<T>, label: string): Promise<RowSnapshot<T>> {
  const { data, error } = await store.select();

  if (error) {
    throw new Error(
      `Refusing to continue: could not snapshot ${label} before mutating it — ${error.message}. `
      + 'Mutating without a snapshot would permanently destroy seeded rows on a persistent rig.',
    );
  }
  if (!data) {
    throw new Error(
      `Refusing to continue: snapshot of ${label} returned no rows payload. `
      + 'Mutating without a snapshot would permanently destroy seeded rows on a persistent rig.',
    );
  }

  // Defensive copy: the caller's rows must not be able to mutate history.
  const captured: T[] = data.map((row) => (
    row !== null && typeof row === 'object' ? { ...(row as object) } as T : row
  ));

  return {
    rows: captured,
    async restore(): Promise<void> {
      // Clear first: `subscriptions` has UNIQUE(user_id), so re-inserting the
      // captured row on top of a live test row would 23505 and abort the
      // restore. Clearing also makes a second call idempotent.
      const { error: deleteError } = await store.deleteMatching();
      if (deleteError) {
        throw new Error(`Failed to restore ${label}: clearing test rows failed — ${deleteError.message}`);
      }

      if (captured.length === 0) return;

      const { error: insertError } = await store.insert(captured.map((row) => (
        row !== null && typeof row === 'object' ? { ...(row as object) } as T : row
      )));
      if (insertError) {
        throw new Error(`Failed to restore ${label}: re-inserting the original rows failed — ${insertError.message}`);
      }
    },
  };
}

/** Minimal shape of the supabase-js client this adapter needs. */
type SupabaseLike = {
  from(table: string): {
    select(columns: string): unknown;
    delete(): unknown;
    insert(rows: unknown): unknown;
  };
};

/**
 * Adapt a supabase-js service client + an equality filter into a {@link RowStore}.
 *
 * `match` is applied with `.match(...)` on every operation, so the snapshot, the
 * clear and the re-insert all address exactly the same row set.
 */
export function supabaseRowStore<T>(
  client: SupabaseLike,
  table: string,
  match: Record<string, unknown>,
): RowStore<T> {
  type Thenable<R> = PromiseLike<R>;
  const withMatch = (builder: unknown): Thenable<{ data?: unknown; error: StoreError | null }> =>
    (builder as { match(m: Record<string, unknown>): Thenable<{ data?: unknown; error: StoreError | null }> })
      .match(match);

  return {
    async select() {
      const { data, error } = await withMatch(client.from(table).select('*'));
      return { data: (data as T[] | null) ?? null, error };
    },
    async deleteMatching() {
      const { error } = await withMatch(client.from(table).delete());
      return { error };
    },
    async insert(rows: T[]) {
      // Insert is not filtered — the rows carry their own keys.
      const { error } = await (client.from(table).insert(rows) as Thenable<{ error: StoreError | null }>);
      return { error };
    },
  };
}
