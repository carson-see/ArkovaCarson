/**
 * Shared fetch-stubbing helpers for the ManageSubOrgs specs.
 *
 * `ManageSubOrgs.test.tsx` and `ManageSubOrgsCredits.test.tsx` test the same
 * component and had byte-identical copies of both functions. A change to how
 * `RequestInfo` is normalised has to apply to both suites or they quietly
 * diverge, so they live here instead.
 *
 * The `vi.mock()` calls themselves deliberately stay in each spec: vitest
 * hoists them above imports, so they cannot be shared through a module.
 */

/** Build a JSON `Response` the way the worker returns one. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Normalise the three shapes `fetch` accepts into a plain URL string. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
