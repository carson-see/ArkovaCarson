/**
 * Shared HTTP-client types for credential-source provider clients — CSI-04.
 *
 * Lives here (not inside any one provider folder) so that no provider module
 * depends on another. Previously `FetchLike` was imported from
 * `credly/client.ts`, which coupled the Accredible client to the Credly
 * module — flagged in the SCRUM-1613 review (P2.4). All provider clients now
 * import this shared definition.
 *
 * The shape is the minimal subset of the WHATWG `fetch` Response that the
 * provider clients consume, so tests can inject a lightweight fake without
 * pulling in `undici`/DOM lib types. Node 20's built-in `fetch` satisfies it.
 */

/** Minimal subset of a `Headers` object the clients read. */
export interface ResponseHeadersLike {
  get(name: string): string | null;
}

/**
 * Minimal subset of a `fetch` Response the provider clients consume.
 *
 * `headers` is optional so existing provider fakes that predate Content-Type
 * validation still satisfy the type; clients that read it must guard with
 * `resp.headers?.get(...)`. Node 20's `fetch` always populates it.
 */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: ResponseHeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * `fetch`-compatible function shape. Tests inject a `vi.fn()`; production
 * uses Node 20's built-in `fetch` global.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;
