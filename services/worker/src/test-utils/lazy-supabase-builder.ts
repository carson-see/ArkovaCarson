/**
 * Shared test double for a supabase-js query builder (PR #1808).
 *
 * Real builders are LAZY PromiseLikes: `PostgrestBuilder.then()` is where the
 * HTTP request is issued. Production code that discards a builder —
 * `void db.from('t').update({...}).eq('id', id)` — therefore sends nothing,
 * silently, with no error and no effect.
 *
 * A mock returning a resolved Promise, or `mockReturnThis()`, cannot catch that
 * bug: it never distinguishes "builder was constructed" from "request was
 * issued". This recorder does — a payload lands in `executed` only when
 * `.then()` is actually called.
 */
/** The lazy thenable shape a supabase-js builder presents to callers. */
export interface LazyBuilder {
  then(
    onfulfilled?: ((value: unknown) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ): Promise<unknown>;
}

export interface LazyBuilderRecorder {
  /** Payloads whose request was actually issued, in order. */
  executed: Array<Record<string, unknown>>;
  /** Build a lazy builder for `payload`; chain it off `.update()`/`.insert()`. */
  build(payload: Record<string, unknown>): LazyBuilder;
  /** Clear recorded executions (call from `beforeEach`). */
  reset(): void;
}

export function createLazyBuilderRecorder(
  result: unknown = { data: null, error: null },
): LazyBuilderRecorder {
  const executed: Array<Record<string, unknown>> = [];

  return {
    executed,
    build(payload) {
      return {
        then(onfulfilled, onrejected) {
          executed.push(payload);
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
    },
    reset() {
      executed.length = 0;
    },
  };
}
