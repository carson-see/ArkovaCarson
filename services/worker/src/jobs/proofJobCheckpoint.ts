/**
 * Shared durable-checkpoint store for the proof back-catalog jobs
 * (proof-backcatalog-classifier, proof-materializer).
 *
 * Both jobs resume long scans of `anchors` from a checkpoint row parked in
 * `job_queue`, keyed by (type, payload->>scope, payload->>mode). The load /
 * create / save trio was identical in both files apart from the job type
 * string and the error-message prefix, so it lives here once — extracted when
 * the materializer landed and SonarCloud flagged ~200 duplicated lines.
 *
 * Terminal status 'completed' on the row is deliberate: the checkpoint is
 * durable state, not work. `claim_next_job` never claims it, queue monitors
 * never count it pending/failed/dead, and the stuck-job sweeper never touches
 * it.
 *
 * The `db` shape is deliberately narrow and structural (not the generated
 * SupabaseClient) so the jobs' existing hand-rolled test doubles satisfy it.
 */

/** Every checkpoint payload is addressed by scope + mode; the rest is per-job. */
export interface ScopedCheckpointPayload {
  scope: string;
  mode: 'dry-run' | 'write';
}

export interface CheckpointHandle<P extends ScopedCheckpointPayload> {
  id: string;
  payload: P;
}

/** The minimum `job_queue` surface the checkpoint store touches. */
export interface CheckpointDb {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): unknown;
    };
    insert(values: Record<string, unknown>): {
      select(cols: string): {
        single(): Promise<{ data: { id: string } | null; error: { message?: string } | null }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message?: string } | null }>;
    };
  };
}

/** The chained select shape `loadCheckpoint` narrows the untyped builder to. */
type CheckpointSelectChain<P> = {
  eq(col: string, val: unknown): {
    eq(col: string, val: unknown): {
      order(
        col: string,
        opts: { ascending: boolean },
      ): {
        limit(n: number): PromiseLike<{
          data: Array<{ id: string; payload: P }> | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
};

export interface CheckpointStore<P extends ScopedCheckpointPayload> {
  /** Most recent checkpoint for (scope, mode), or null when none exists. */
  load(scope: string, mode: 'dry-run' | 'write'): Promise<CheckpointHandle<P> | null>;
  /** Insert a fresh checkpoint row and return its handle. */
  create(payload: P): Promise<CheckpointHandle<P>>;
  /** Persist an updated payload against an existing handle. */
  save(handle: CheckpointHandle<P>): Promise<void>;
}

/**
 * Build a checkpoint store bound to one job type.
 *
 * @param db        narrow `job_queue` accessor (real client or test double)
 * @param jobType   `job_queue.type` value that owns these checkpoint rows
 * @param label     error-message prefix, e.g. 'materializer' / 'classifier'
 */
export function createCheckpointStore<P extends ScopedCheckpointPayload>(
  db: CheckpointDb,
  jobType: string,
  label: string,
): CheckpointStore<P> {
  return {
    async load(scope, mode) {
      const q = db.from('job_queue').select('id, payload').eq('type', jobType) as
        CheckpointSelectChain<P>;
      const { data, error } = await q
        .eq('payload->>scope', scope)
        .eq('payload->>mode', mode)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) {
        throw new Error(`${label} checkpoint load failed: ${error.message ?? 'unknown'}`);
      }
      const row = data?.[0];
      return row ? { id: row.id, payload: row.payload } : null;
    },

    async create(payload) {
      const { data, error } = await db
        .from('job_queue')
        .insert({ type: jobType, status: 'completed', payload })
        .select('id')
        .single();
      if (error || !data) {
        throw new Error(`${label} checkpoint create failed: ${error?.message ?? 'no id returned'}`);
      }
      return { id: data.id, payload };
    },

    async save(handle) {
      const { error } = await db
        .from('job_queue')
        .update({ payload: handle.payload, updated_at: new Date().toISOString() })
        .eq('id', handle.id);
      if (error) {
        throw new Error(`${label} checkpoint save failed: ${error.message ?? 'unknown'}`);
      }
    },
  };
}
