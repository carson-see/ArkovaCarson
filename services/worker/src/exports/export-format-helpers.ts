/**
 * Shared field-mapping + formatting primitives AND the generic upload/sign +
 * audit orchestration seam for the compliance-log exporters (CPE — SCRUM-1848,
 * CLE — SCRUM-1870, and any future per-domain export).
 *
 * The formatting helpers are byte-identical across the export modules; this
 * module is the single definition each importer pulls in (rather than keeping
 * its own copy), so it is the one place to change how raw anchor/metadata values
 * are coerced into auditor-safe record fields and is the canonical
 * de-duplication that keeps the SonarCloud `new_duplicated_lines_density` gate
 * green.
 *
 * The orchestration helpers (`ExportPdfBuilder`, `uploadAndSignExportArtifacts`,
 * `emitExportAuditEvent`) are the generic, fully-parameterized form of the
 * jsPDF document scaffolding, the Storage upload/sign tail, and the
 * metadata-only audit insert that every per-domain exporter needs.
 * `ExportPdfBuilder` owns the byte-identical jsPDF boilerplate (page geometry,
 * the title + gray meta header, the disclaimer divider block, and the paginated
 * records loop); the caller supplies only its domain-specific values (title,
 * meta lines, disclaimer text, and a per-record line mapper). A per-domain
 * module thus builds its own PDF via these methods and its own audit `details`
 * object, then hands the rendered bodies to the upload/sign helper — so the
 * concrete handler shrinks to a few call sites and no longer token-duplicates
 * its sibling exporters (SonarCloud CPD `new_duplicated_lines_density`).
 *
 * Deliberately depends on NO sibling export module (only structural,
 * duck-typed shapes are declared below) so it can never form an import cycle.
 *
 * Constitution refs:
 *   - 1.4 : audit insert is metadata-only; caller owns the `details` payload.
 *   - 1.5 : timestamps rendered in UTC ("Network Observed Time" framing).
 *   - 1.6 : worker-only — no client-side fingerprint code is referenced here.
 */
import { Buffer } from 'node:buffer';
import { jsPDF } from 'jspdf';

/** Trimmed non-empty string, or null. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Finite number (accepts numeric strings), or null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Reduce an ISO date-time / date string to YYYY-MM-DD (or null). */
export function asDateOnly(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const dateOnly = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

/**
 * Strip any trailing slashes from a base URL before appending a path.
 *
 * A linear character scan, deliberately not a `/\/+$/` regex: SonarCloud's
 * S5852 ReDoS heuristic flags the `+`-then-`$` regex shape even though this
 * single-character pattern is backtrack-free. The scan is provably linear and
 * carries no backtracking, so it keeps the export Quality Gate green without a
 * per-line analyzer suppression.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return url.slice(0, end);
}

/** Format an ISO timestamp as "Mon DD, YYYY, HH:MM AM/PM UTC" (or em dash). */
export function formatUtc(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return (
    d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
  );
}

// ─── Generic compliance-log PDF builder ──────────────
// jsPDF is stateful (a moving `y` cursor), so the shared scaffolding is a thin
// builder class rather than free functions. The caller drives it with
// domain-specific values; all the page geometry, fonts, divider rules, and the
// paginated records loop live here ONCE.

/**
 * One detail group rendered under a record's bold title: a small set of
 * `Label: value` cells joined on the page, optionally tinted (e.g. a link line).
 */
export interface ExportPdfRecordLine {
  /** Pre-joined cells, e.g. ['Provider: Foo', 'Hours: 6']. Joined with `   |   `. */
  cells: string[];
  /** Optional RGB tint for this line (e.g. a verification-link line). */
  color?: [number, number, number];
}

/** What the caller's per-record mapper returns for one record. */
export interface ExportPdfRecord {
  /** Bold record title (falls back to a placeholder when empty). */
  title: string;
  /** Ordered detail lines beneath the title. */
  lines: ExportPdfRecordLine[];
}

const RECORD_CELL_SEPARATOR = '   |   ';
const PDF_PAGE_BREAK_Y = 255;
/** Vertical advance per rendered title line (pt), used to wrap multi-line titles. */
const TITLE_LINE_HEIGHT = 5;

/**
 * Shared jsPDF scaffolding for the compliance-log exporters. Owns the
 * byte-identical boilerplate (geometry, title/meta header, disclaimer divider,
 * paginated records loop) so no per-domain exporter re-implements it.
 */
export class ExportPdfBuilder {
  private readonly doc: jsPDF;
  readonly margin = 20;
  readonly contentWidth: number;
  private y: number;

  constructor() {
    this.doc = new jsPDF();
    const pageWidth = this.doc.internal.pageSize.getWidth();
    this.contentWidth = pageWidth - this.margin * 2;
    this.y = this.margin;
  }

  /** Title (bold) plus a stack of gray metadata lines (e.g. Generated / Period / Records). */
  header(title: string, metaLines: string[]): this {
    this.doc.setFontSize(20);
    this.doc.setFont('helvetica', 'bold');
    this.doc.text(title, this.margin, this.y);
    this.y += 9;

    this.doc.setFontSize(9);
    this.doc.setFont('helvetica', 'normal');
    this.doc.setTextColor(100, 100, 100);
    for (const line of metaLines) {
      this.doc.text(line, this.margin, this.y);
      this.y += 4;
    }
    this.y += 4;
    return this;
  }

  /**
   * Free-form section the caller renders itself (e.g. CLE's ethics-subtotal
   * Summary block) — exposes the underlying doc + current cursor and takes the
   * caller's new cursor back. Keeps domain-specific layout out of the shared
   * scaffolding while still sharing the geometry + cursor.
   */
  section(render: (doc: jsPDF, ctx: { margin: number; contentWidth: number; y: number }) => number): this {
    this.y = render(this.doc, { margin: this.margin, contentWidth: this.contentWidth, y: this.y });
    return this;
  }

  /** A horizontal-rule-bracketed, italicized disclaimer block (verbatim text). */
  disclaimer(text: string): this {
    this.doc.setTextColor(0, 0, 0);
    this.doc.setDrawColor(200, 200, 200);
    this.doc.line(this.margin, this.y, this.margin + this.contentWidth, this.y);
    this.y += 6;
    this.doc.setFontSize(8);
    this.doc.setFont('helvetica', 'italic');
    this.doc.setTextColor(90, 90, 90);
    const lines = this.doc.splitTextToSize(text, this.contentWidth);
    this.doc.text(lines, this.margin, this.y);
    this.y += lines.length * 4 + 4;
    this.doc.setDrawColor(200, 200, 200);
    this.doc.line(this.margin, this.y, this.margin + this.contentWidth, this.y);
    this.y += 8;
    return this;
  }

  /**
   * Render the paginated records list. `mapRecord` turns one domain record into
   * a bold title + ordered detail lines; the loop, page breaks, fonts, and line
   * spacing are handled here.
   */
  records<T>(items: readonly T[], mapRecord: (item: T) => ExportPdfRecord): this {
    this.doc.setTextColor(0, 0, 0);
    for (const item of items) {
      if (this.y > PDF_PAGE_BREAK_Y) {
        this.doc.addPage();
        this.y = this.margin;
      }
      const { title, lines } = mapRecord(item);

      this.doc.setFontSize(11);
      this.doc.setFont('helvetica', 'bold');
      // Wrap the title explicitly and advance `y` by the rendered line count so a
      // long multi-line title does not overlap the detail lines below it.
      // `maxWidth` alone wraps the glyphs but does NOT report how many lines were
      // drawn, leaving the cursor under the first line (mirrors the CPE export's
      // standalone fix — PR #1029).
      const titleLines: string[] = this.doc.splitTextToSize(title || '(untitled)', this.contentWidth);
      this.doc.text(titleLines, this.margin, this.y);
      this.y += titleLines.length * TITLE_LINE_HEIGHT;

      this.doc.setFontSize(8);
      this.doc.setFont('helvetica', 'normal');
      this.doc.setTextColor(70, 70, 70);
      for (const line of lines) {
        if (line.color) {
          this.doc.setTextColor(line.color[0], line.color[1], line.color[2]);
        }
        this.doc.text(line.cells.join(RECORD_CELL_SEPARATOR), this.margin, this.y, {
          maxWidth: this.contentWidth,
        });
        if (line.color) {
          this.doc.setTextColor(70, 70, 70);
        }
        this.y += 4;
      }
      this.y += 3;
    }
    return this;
  }

  /** Finalize to a Buffer. */
  toBuffer(): Buffer {
    return Buffer.from(this.doc.output('arraybuffer'));
  }
}

// ─── Generic export orchestration seam ───────────────
// Structural, duck-typed shapes so this module never imports a sibling exporter
// (no import cycle). `ExportStorageLike` is satisfied by `CpeExportStorage`;
// `ExportAuditDb` / `ExportAuditLogger` by the worker's Supabase client + logger.

/** Minimal Storage seam: matches `CpeExportStorage` structurally. */
export interface ExportStorageLike {
  upload(
    bucket: string,
    path: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<{ error: Error | null }>;
  createSignedUrl(
    bucket: string,
    path: string,
    expiresIn: number,
  ): Promise<{ signedUrl: string | null; error: Error | null }>;
  /**
   * Inspect a bucket's existence + visibility. Returns `exists: false` when the
   * bucket is absent so the fail-loud guard can raise a clear error instead of
   * a confusing downstream upload 500, and `isPublic` so a misconfigured PUBLIC
   * bucket — which would expose unsigned export bodies (CC7) — is rejected too.
   * Part of the seam so the guard lives INSIDE `uploadAndSignExportArtifacts`
   * and no exporter can reach an upload without it.
   */
  getBucket(
    bucket: string,
  ): Promise<{ exists: boolean; isPublic: boolean | null; error: Error | null }>;
}

/**
 * Fail-loud precondition: the exports bucket MUST exist and MUST be private.
 *
 * Provisioning the bucket is an ops step (see agents.md) — this guard does NOT
 * create it. It exists so a missing bucket fails with a clear, actionable error
 * (rather than a confusing upload 500 deeper in the flow), and so a bucket that
 * was accidentally made PUBLIC is rejected before any export body is written —
 * a public bucket would expose unsigned export contents and break the CC7
 * no-content-leak guarantee.
 *
 * This is the CANONICAL guard: it lives beside the shared upload helper (which
 * calls it exactly once per upload), so EVERY per-domain exporter that routes
 * through `uploadAndSignExportArtifacts` is protected — no exporter can skip it
 * by calling the upload tail directly (the CLE-path gap Carson flagged in
 * PR #1415 [P1]). `cpe-log-export.ts` re-exports this symbol for callers/tests.
 */
export async function assertExportsBucketReady(
  storage: Pick<ExportStorageLike, 'getBucket'>,
  bucket: string,
): Promise<void> {
  const { exists, isPublic, error } = await storage.getBucket(bucket);
  if (error && !exists) {
    throw new Error(
      `exports Storage bucket "${bucket}" is unavailable (provision it as a private bucket): ${error.message}`,
    );
  }
  if (!exists) {
    throw new Error(
      `exports Storage bucket "${bucket}" does not exist — provision it as a private bucket before exporting`,
    );
  }
  if (isPublic) {
    throw new Error(
      `exports Storage bucket "${bucket}" is PUBLIC — exports must use a private bucket so signed URLs are the only access path`,
    );
  }
}

/** One signed artifact descriptor returned to the caller. */
export interface ExportArtifact {
  signed_url: string;
  path: string;
  expires_in: number;
}

/** The PDF + JSON pair every compliance-log export produces. */
export interface ExportArtifactPair {
  pdf: ExportArtifact;
  json: ExportArtifact;
}

/**
 * Upload a pre-built PDF + JSON artifact pair to Storage under a shared base
 * path and return a short-lived signed URL for each.
 *
 * This is the generic form of the per-exporter "upload both → sign both" tail.
 * The caller supplies the already-rendered bodies, the bucket, the base path
 * (`<domain>-log/<org>/<user>/<requestId>`, WITHOUT extension), the signed-URL
 * TTL, and a short `label` (e.g. `CPE`/`CLE`) used only in thrown error
 * messages. Any Storage failure throws so the HTTP layer can surface a clean
 * 5xx — the exporter never returns a half-built result.
 *
 * Private-bucket preflight (PR #1415, Carson [P1]): BEFORE any body is written,
 * this helper runs `assertExportsBucketReady` exactly once so an accidentally
 * PUBLIC (or missing) bucket is rejected here — inside the single shared upload
 * seam — rather than being enforced separately (and skippably) per exporter.
 * This closes the CLE gap where the export path reached the upload tail with no
 * visibility check.
 */
export async function uploadAndSignExportArtifacts(args: {
  storage: ExportStorageLike;
  bucket: string;
  /** `<domain>-log/<org>/<user>/<requestId>` — `.pdf`/`.json` are appended. */
  basePath: string;
  pdfBody: Uint8Array;
  jsonBody: string;
  expiresIn: number;
  /** Short upper-case domain tag for error messages, e.g. `CPE` / `CLE`. */
  label: string;
}): Promise<ExportArtifactPair> {
  const { storage, bucket, basePath, pdfBody, jsonBody, expiresIn, label } = args;

  // Fail loud if the destination bucket is missing or public BEFORE writing any
  // body — a missing/public bucket is an ops misconfiguration that must never
  // silently 500 mid-upload or leak unsigned bodies. Runs exactly once here so
  // NO exporter routing through this helper can reach an upload without it.
  await assertExportsBucketReady(storage, bucket);

  const pdfPath = `${basePath}.pdf`;
  const jsonPath = `${basePath}.json`;

  const pdfUpload = await storage.upload(bucket, pdfPath, pdfBody, 'application/pdf');
  if (pdfUpload.error) {
    throw new Error(`failed to upload ${label} log PDF: ${pdfUpload.error.message}`);
  }
  const jsonUpload = await storage.upload(bucket, jsonPath, jsonBody, 'application/json');
  if (jsonUpload.error) {
    throw new Error(`failed to upload ${label} log JSON: ${jsonUpload.error.message}`);
  }

  const pdfSigned = await storage.createSignedUrl(bucket, pdfPath, expiresIn);
  if (pdfSigned.error || !pdfSigned.signedUrl) {
    throw new Error(`failed to sign ${label} log PDF URL: ${pdfSigned.error?.message ?? 'no url'}`);
  }
  const jsonSigned = await storage.createSignedUrl(bucket, jsonPath, expiresIn);
  if (jsonSigned.error || !jsonSigned.signedUrl) {
    throw new Error(`failed to sign ${label} log JSON URL: ${jsonSigned.error?.message ?? 'no url'}`);
  }

  return {
    pdf: { signed_url: pdfSigned.signedUrl, path: pdfPath, expires_in: expiresIn },
    json: { signed_url: jsonSigned.signedUrl, path: jsonPath, expires_in: expiresIn },
  };
}

/** Minimal Supabase-client shape the audit insert needs. */
export interface ExportAuditDb {
  from(table: string): unknown;
}

/** Minimal logger shape the audit emitter needs. */
export interface ExportAuditLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Insert a metadata-only `*.exported` audit event (CC7 no-content-leak).
 *
 * The CALLER owns the `details` object and is responsible for keeping it free
 * of per-credential content (titles, providers, public_ids, URLs) — this helper
 * only serialises and writes what it is handed, plus the row envelope
 * (`event_type` / `event_category` / `actor_id` / `org_id` / `target_type`).
 * Audit failure is non-fatal: the export already succeeded, so a write error or
 * thrown exception is logged at warn with coarse, PII-free context only.
 */
export async function emitExportAuditEvent(
  db: ExportAuditDb,
  logger: ExportAuditLogger,
  params: {
    eventType: string;
    eventCategory: string;
    targetType: string;
    actorId: string;
    orgId: string;
    requestId: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter -- audit insert writes a new event row; org_id + actor_id are set on the row (not a tenant-leaking read).
    const result = await (db.from('audit_events') as any).insert({
      event_type: params.eventType,
      event_category: params.eventCategory,
      actor_id: params.actorId,
      org_id: params.orgId,
      target_type: params.targetType,
      details: JSON.stringify(params.details),
    });
    if (result?.error) {
      logger.warn(
        { orgId: params.orgId, requestId: params.requestId, code: result.error.code },
        `${params.eventType} audit insert failed (non-fatal)`,
      );
    }
  } catch (err) {
    logger.warn(
      { requestId: params.requestId, error: err instanceof Error ? err.message : 'unknown' },
      `${params.eventType} audit insert threw (non-fatal)`,
    );
  }
}
