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
        // NOSONAR typescript:S7739 — "Do not add `then` to an object".
        //
        // The rule is right in general: a thenable object gets awaited by
        // surprise, so it is a reliability hazard in production code. Here it
        // is the ENTIRE POINT and cannot be refactored away without destroying
        // what this file exists to detect.
        //
        // `PostgrestBuilder` really is a thenable — supabase-js issues the HTTP
        // request from `.then()`, not from `.from()/.update()/.eq()`. So
        // `void db.from('t').update({...}).eq('id', id)` builds a request and
        // never sends it: no error, no write, HTTP 200. That is the silent-
        // success defect this repo keeps shipping. A test double that is a
        // resolved Promise (or `mockReturnThis()`) is EAGER, so it cannot tell
        // "builder constructed" from "request issued" and passes either way.
        // Only a lazy thenable reproduces the real contract.
        //
        // Scope is one object in one test-only helper, never imported by
        // production code. Prefer marking this Accepted in the SonarCloud UI
        // over deleting the suppression — removing it means either failing the
        // quality gate or weakening the double back into one that cannot catch
        // the bug.
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
