/**
 * Connector adapter contract (PR-1 of 4 — SCRUM connector-template series).
 *
 * FOUNDER DIRECTIVE: "The Google Drive connector should be a template that is
 * reproducible for OneDrive and others." This file is the shape of that
 * template — the vendor-neutral surface a change-detecting cloud-storage
 * connector (Drive today; OneDrive/SharePoint later) must implement so the
 * orchestrator (watch lifecycle, changes-feed walk, document fetch, dead-
 * letter classification) can be written ONCE against the interface instead of
 * once per vendor.
 *
 * SCOPE OF THIS PR — READ BEFORE EXTENDING THIS FILE
 * ---------------------------------------------------
 * This PR lands the interface and one real, fully-tested implementation
 * (`GoogleDriveAdapter` in `google-drive-adapter.ts`) that delegates to the
 * existing, shipped `oauth/drive.ts` functions with ZERO behavior change.
 * Nothing in `drive-changes-processor.ts`, `drive-changes-runner.ts`, or the
 * webhook/OAuth routes is rewired to consume this adapter yet — that is a
 * separate, higher-tier change (this file touches no anchor-creating code
 * path). Proving the contract against the ONE provider that exercises it
 * end-to-end (OAuth → watch → changes feed → byte fetch → error taxonomy) is
 * the whole point of PR-1; a second, unvalidated implementation would not
 * prove anything.
 *
 * Deliberately NOT done here (deferred to PR-3, once a second provider
 * exists to generalize FROM, not speculate FOR):
 *   - a shared/generalized health-reason vocabulary across vendors,
 *   - a shared/generalized revision ledger or dedupe-key scheme,
 *   - a OneDrive/SharePoint implementation of this interface.
 *
 * Contracts this interface deliberately does NOT cover, for ANY provider
 * (open questions for a later PR — see the PR body for the full list):
 *   - folder rename/move (Drive's changes feed reports the moved FILE, not a
 *     "this folder was renamed" event; a rename below a watched folder is
 *     invisible to `listChanges` today),
 *   - permission / ownership changes on a watched file or folder,
 *   - historical catch-up on reconnect (this interface's `getFreshCursor` is
 *     "start from now," not "replay everything since disconnect"),
 *   - retention / expiry of connector-fetched artifacts.
 *
 * WHY `revisionKind` STAYS OPAQUE
 * --------------------------------
 * `SourceVersionRef.revisionKind` is a provider-declared, free-form string —
 * the orchestrator must treat it as opaque and MUST NOT branch on its value
 * except to display/log it. Two real providers already prove why a shared
 * enum would be wrong:
 *   - Google Drive has a REAL, monotonic revision id (`headRevisionId`) for
 *     binary files, but Workspace-native docs (Docs/Sheets/Slides) expose
 *     none — Drive's own fallback chain is `headRevisionId` → `mtime:<ts>`
 *     (modification time, guaranteed to advance) → `evt:<time>:<fileId>`
 *     (synthesized from the change event itself, last resort). See
 *     `resolveRevision` in `drive-changes-processor.ts` (exported for this
 *     adapter to reuse verbatim) and the `mtime:` / `evt:` prefixes it emits
 *     — those prefixes are part of the 0343 `connector_artifact` dedupe key
 *     and must never change.
 *   - DocuSign has NO revision concept at all in the Drive sense; its
 *     connector instead content-addresses via `fingerprint_sha256` — the
 *     document's own hash IS the version identity, computed after fetch, not
 *     declared by the vendor API up front.
 *   These are genuinely different "no native revision" resolutions for the
 *   same underlying problem, driven by each vendor's own API shape. A shared
 *   enum (`'head' | 'mtime' | 'content_hash' | ...`) would force every future
 *   provider's real semantics through categories invented for the first two,
 *   which is exactly the premature generalization this PR is scoped to avoid.
 *   `revisionKind` is therefore typed `string`, not a union — provider-
 *   declared, orchestrator-opaque, by design.
 */

/**
 * A change's version identity, as the source vendor declares it.
 *
 * `externalRef` is the vendor's stable identifier for the CHANGED OBJECT
 * (Drive: `file.id`; a future OneDrive adapter: the DriveItem id) — stable
 * across revisions of the same object, unlike `externalRevision`.
 *
 * `externalRevision` is `null` only for a provider/object pair that truly has
 * no revision signal to report (not merely "unresolved this time" — Drive's
 * adapter never emits `null` here because its own fallback chain always
 * resolves to SOMETHING, even a synthesized last-resort id; a change it
 * cannot identify at all is dropped before reaching `SourceChangeEvent`, not
 * passed through with a null revision).
 *
 * `revisionKind` — see the module doc comment's "WHY `revisionKind` STAYS
 * OPAQUE" section. Never branch on this value; it exists for observability
 * and for a record surface to explain what was actually measured (§1.5).
 */
export interface SourceVersionRef {
  externalRef: string;
  externalRevision: string | null;
  /** Provider-declared, treated opaquely by the orchestrator. See module doc. */
  revisionKind: string;
}

/**
 * One change-feed entry, vendor-shape stripped to what the orchestrator
 * (folder-match, dedupe, rule-event enqueue) actually consumes.
 *
 * `actorEmail` is RAW — vendor APIs return it unscrubbed, and this interface
 * makes no PII decision on the connector's behalf. The caller (the eventual
 * orchestrator wiring, not this PR) owns scrubbing/redaction before anything
 * derived from it is persisted or logged, per §1.6A and §1.4.
 *
 * `removed` and `trashed` are kept as two separate booleans (not merged into
 * one "gone" flag) because Drive itself distinguishes them: `removed` is the
 * changes-feed tombstone (the change entry itself says "this id is gone,
 * permanently, from this feed"); `trashed` is a live file's current soft-
 * delete state. A future provider may only ever populate one of the two —
 * both stay optional-in-spirit (`false` when the provider has no concept of
 * the other), never collapsed, so a caller can keep asking Drive's own
 * question ("do we anchor a trashed-but-not-removed file the same way as a
 * live one?") instead of losing the distinction before it ever sees it.
 */
export interface SourceChangeEvent {
  version: SourceVersionRef;
  parentIds: string[];
  mimeType: string | null;
  modifiedTime: string | null;
  /** Raw; caller scrubs before persisting. */
  actorEmail: string | null;
  removed: boolean;
  trashed: boolean;
}

/** OAuth token set, camelCased at the adapter boundary (vendor token
 * endpoints are conventionally snake_case; this interface is not). */
export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope?: string;
  tokenType?: string;
}

/**
 * The vendor-neutral surface a change-detecting connector implements.
 *
 * Every method maps to a real, already-shipped Google Drive function (see
 * `google-drive-adapter.ts`'s per-method doc comments for the exact mapping
 * and the handful of encoding decisions the mapping required — none of which
 * changed this interface's shape; see that file's module doc comment for the
 * full account of what was validated and what had to be resolved inside the
 * adapter instead).
 */
export interface ConnectorAdapter {
  readonly vendor: string;

  buildAuthorizationUrl(args: { redirectUri: string; state: string }): string;
  exchangeCode(args: { code: string; redirectUri: string }): Promise<OAuthTokenSet>;
  refreshToken(args: { refreshToken: string }): Promise<OAuthTokenSet>;
  revoke(args: { token: string }): Promise<void>;

  /**
   * Register a push-notification subscription. `resourceScope` is an opaque,
   * provider-declared scoping token (Drive: a shared-drive id; omitted means
   * "my/personal drive"). Returns an opaque `subscriptionId` the orchestrator
   * must round-trip to `stopWatch` unmodified — see `google-drive-adapter.ts`
   * for why Drive's own subscriptionId is NOT a single vendor id.
   */
  createWatch(args: {
    accessToken: string;
    address: string;
    resourceScope?: string;
  }): Promise<{ subscriptionId: string; expiresAt: string; cursor: string }>;
  stopWatch(args: { accessToken: string; subscriptionId: string }): Promise<void>;

  /** A cursor that starts the changes feed from "now" — NOT historical
   * catch-up (see the module doc comment's open-questions list). */
  getFreshCursor(args: { accessToken: string; resourceScope?: string }): Promise<string>;

  /**
   * Walk one page of the changes feed from `cursor`. `nextCursor` non-null
   * means "more pages are available right now, call again with this token";
   * `newCursor` non-null means "this was the final page — persist this as
   * the durable resume cursor for the NEXT webhook delivery." At most one is
   * ever non-null for a given call, mirroring Drive's own
   * `nextPageToken` / `newStartPageToken` pair.
   */
  listChanges(args: {
    accessToken: string;
    cursor: string;
  }): Promise<{ changes: SourceChangeEvent[]; nextCursor: string | null; newCursor: string | null }>;

  /**
   * Is `err` the vendor's "this cursor is no longer valid" signal? True means
   * the caller's documented recovery is to discard the cursor and re-bootstrap
   * via `getFreshCursor` — never a blind retry with the same cursor.
   */
  isCursorInvalidError(err: unknown): boolean;

  /**
   * Fetch one document's raw bytes for server-side fingerprinting (§1.6A —
   * this is the ONE method whose return value is connector-fetched document
   * content). The caller MUST hash and discard `bytes` in the same
   * synchronous span; per §1.6A, `bytes` must never be logged, persisted,
   * attached to an Error, or written to `job_queue.last_error`.
   */
  fetchBytes(args: {
    externalRef: string;
    accessToken: string;
    mimeType?: string | null;
  }): Promise<{ bytes: Buffer; contentType: string | null; exportMimeType: string | null }>;

  /**
   * Classify a `fetchBytes` failure into a dead-letter-relevant outcome.
   * `'permanent_access_denied'` / `'permanent_too_large'` mean "retrying
   * cannot succeed — this artifact will never fit through this pipeline";
   * `'retryable'` covers everything else (auth/quota/network/5xx), including
   * an error this adapter does not recognize at all (fail OPEN to retryable,
   * never silently permanent for an unrecognized shape).
   */
  classifyFetchError(err: unknown): 'permanent_access_denied' | 'permanent_too_large' | 'retryable';
}
