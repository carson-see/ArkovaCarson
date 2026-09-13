/**
 * publicRecordTemplate.ts (SCRUM-5105)
 *
 * Projects a pipeline-anchored `public_records` row (title + metadata) onto
 * the platform PUBLICATION credential template's field keys, so
 * `RecordDetailPage` can pass a richer `metadata` object into
 * `AssetDetailView` / `CredentialRenderer` for pipeline-anchored public
 * records (OpenAlex, EDGAR, etc.) — see
 * services/worker/src/jobs/publicRecordAnchor.ts's `buildPipelineAnchorInsert`
 * for why `anchors.metadata` alone is too thin to render (it only carries
 * `{pipeline_source, source_id, source_url, record_type}` plus merkle keys).
 *
 * SCOPE (deliberate, do not widen without review):
 * - Ships `openalex`, `edgar`, `federal_register`, `openstates` in this PR.
 * - Every other source returns `{}` — in particular, person-registry
 *   sources (npi, finra, calbar, acnc, dapip, uspto, courtlistener, sam_gov,
 *   etc.) are EXPLICITLY DEFERRED to a follow-up with a dedicated PII
 *   review. Do not add a source here without one.
 * - Never emit: abstract, description, summary (those already flow through
 *   `anchor.description` — see `publicRecordDescription()` in
 *   `publicRecordAnchor.ts`), anything email/phone/ssn/dob/address-shaped,
 *   or a raw nested object dump. Every value is `string | number | boolean
 *   | string[]`, and every string is capped at `MAX_STRING_LENGTH` chars.
 * - Person names are excluded per-source deliberately (see each projector's
 *   comment for the specific excluded field and why) — this is the reason
 *   OpenAlex authors land under a NEW `authors` key rather than the
 *   template's `recipientIdentifier` key, which the extraction contract
 *   defines as hashed-never-raw-PII.
 */

const MAX_STRING_LENGTH = 500;
const MAX_AUTHORS = 20;
const MAX_CONCEPTS = 10;

/**
 * CTO ruling (SCRUM-5105 follow-up): `authors` is an array of objects, not
 * bare strings, so a display consumer can link/format the ORCID separately
 * from the name. `orcid` is present only when the source carried one, with
 * any leading "https://orcid.org/" stripped.
 */
export interface ProjectedAuthor {
  name: string;
  orcid?: string;
}

export type ProjectedFieldValue = string | number | boolean | string[] | ProjectedAuthor[];
export type ProjectedTemplate = Record<string, ProjectedFieldValue>;

export interface ProjectablePublicRecord {
  title: string | null;
  metadata: Record<string, unknown>;
}

function capString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_STRING_LENGTH ? trimmed.slice(0, MAX_STRING_LENGTH) : trimmed;
}

function capStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = capString(entry);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function capNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function capBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stripDoiPrefix(doi: string): string {
  return doi.replace(/^https?:\/\/doi\.org\//i, '');
}

function stripOrcidPrefix(orcid: string): string {
  return orcid.replace(/^https?:\/\/orcid\.org\//i, '');
}

/**
 * OpenAlex's `journal` metadata is a bare display-name string in the
 * current writer (openalexFetcher.ts ~L245: `work.primary_location?.source
 * ?.display_name ?? null`), but is normalised defensively here in case an
 * older/alternate write path stored the raw `{ name | display_name }`
 * source object instead.
 */
function normaliseJournal(value: unknown): string | null {
  if (typeof value === 'string') return capString(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return capString(obj.name) ?? capString(obj.display_name);
  }
  return null;
}

/**
 * Normalises one OpenAlex author entry to `{ name, orcid? }`. The fetcher's
 * stored shape is `{ name, orcid, institutions }` (openalexFetcher.ts
 * ~L237-241), but this also accepts a bare string and the raw OpenAlex
 * authorship shape `{ author: { display_name, orcid } }` in case an
 * un-normalised record ever reaches this path. `orcid` is included only
 * when the source carried a non-empty one, with any leading
 * "https://orcid.org/" stripped.
 */
function authorEntry(entry: unknown): ProjectedAuthor | null {
  if (typeof entry === 'string') {
    const name = capString(entry);
    return name ? { name } : null;
  }
  if (!entry || typeof entry !== 'object') return null;

  const obj = entry as Record<string, unknown>;
  let name = capString(obj.name) ?? capString(obj.display_name);
  let orcidRaw: unknown = obj.orcid;

  if (!name) {
    const nested = obj.author;
    if (nested && typeof nested === 'object') {
      const nestedObj = nested as Record<string, unknown>;
      name = capString(nestedObj.display_name) ?? capString(nestedObj.name);
      orcidRaw = orcidRaw ?? nestedObj.orcid;
    }
  }

  if (!name) return null;

  const orcidStr = capString(orcidRaw);
  if (!orcidStr) return { name };
  const orcid = stripOrcidPrefix(orcidStr);
  return orcid ? { name, orcid } : { name };
}

function conceptDisplayName(entry: unknown): string | null {
  if (typeof entry === 'string') return capString(entry);
  if (entry && typeof entry === 'object') {
    return capString((entry as Record<string, unknown>).display_name);
  }
  return null;
}

/**
 * `openalex` (PUBLICATION) — see openalexFetcher.ts ~L242-269 for the
 * stored metadata shape.
 *   title (public_records.title)      -> fieldOfStudy
 *   metadata.journal                  -> issuerName
 *   metadata.publication_date         -> issuedDate
 *   metadata.doi                      -> licenseNumber (leading
 *                                        "https://doi.org/" stripped)
 *   metadata.authors                  -> authors (NEW key, max 20 — never
 *                                        recipientIdentifier, which the
 *                                        extraction contract reserves for a
 *                                        hashed-never-raw-PII value)
 *   metadata.concepts                 -> concepts (max 10)
 *   metadata.publication_year / cited_by_count / is_retracted /
 *   is_open_access                    -> extras, passed through as-is
 * Never emitted: metadata.abstract.
 */
function projectOpenAlex(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};

  const fieldOfStudy = capString(record.title);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;

  const issuerName = normaliseJournal(meta.journal);
  if (issuerName) out.issuerName = issuerName;

  const issuedDate = capString(meta.publication_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const doi = capString(meta.doi);
  if (doi) out.licenseNumber = stripDoiPrefix(doi);

  if (Array.isArray(meta.authors)) {
    const authors: ProjectedAuthor[] = [];
    for (const entry of meta.authors) {
      const author = authorEntry(entry);
      if (author) authors.push(author);
      if (authors.length >= MAX_AUTHORS) break;
    }
    if (authors.length > 0) out.authors = authors;
  }

  if (Array.isArray(meta.concepts)) {
    const concepts: string[] = [];
    for (const entry of meta.concepts) {
      const name = conceptDisplayName(entry);
      if (name) concepts.push(name);
      if (concepts.length >= MAX_CONCEPTS) break;
    }
    if (concepts.length > 0) out.concepts = concepts;
  }

  const publicationYear = capNumber(meta.publication_year);
  if (publicationYear !== null) out.publication_year = publicationYear;

  const citedByCount = capNumber(meta.cited_by_count);
  if (citedByCount !== null) out.cited_by_count = citedByCount;

  const isRetracted = capBoolean(meta.is_retracted);
  if (isRetracted !== null) out.is_retracted = isRetracted;

  const isOpenAccess = capBoolean(meta.is_open_access);
  if (isOpenAccess !== null) out.is_open_access = isOpenAccess;

  return out;
}

/**
 * `edgar` — allow-list derived from the three insert sites in
 * services/worker/src/jobs/edgarFetcher.ts (all three write the same field
 * names): ~L279-286, ~L578-585, ~L954-961.
 *   entity_name        -> issuerName        (filing entity / company name)
 *   filing_date        -> issuedDate
 *   ciks                -> licenseNumber (first CIK) + extras.ciks
 *   form_type          -> extras.formType
 *   period_of_report   -> extras.periodOfReport
 *   tickers            -> extras.tickers
 *   primary_document   -> extras.primaryDocument   (only the ~L584 variant)
 *   file_description / primary_doc_description -> extras.fileDescription
 * EXCLUDED: display_names — EDGAR full-text-search hits on Form 3/4/5
 * (beneficial-ownership filings) can carry an individual filer's name in
 * this array; `entity_name` already gives a vetted document-level name, so
 * display_names is dropped rather than passed through.
 * fieldOfStudy is left unset: `record.title` here is a constructed
 * "Entity — Form (Date)" string that only duplicates issuerName/issuedDate,
 * not a natural subject line.
 */
function projectEdgar(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};

  const issuerName = capString(meta.entity_name);
  if (issuerName) out.issuerName = issuerName;

  const issuedDate = capString(meta.filing_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const ciks = capStringArray(meta.ciks, 20);
  if (ciks.length > 0) {
    out.licenseNumber = ciks[0];
    out.ciks = ciks;
  }

  const formType = capString(meta.form_type);
  if (formType) out.formType = formType;

  const periodOfReport = capString(meta.period_of_report);
  if (periodOfReport) out.periodOfReport = periodOfReport;

  const tickers = capStringArray(meta.tickers, 20);
  if (tickers.length > 0) out.tickers = tickers;

  const primaryDocument = capString(meta.primary_document);
  if (primaryDocument) out.primaryDocument = primaryDocument;

  const fileDescription = capString(meta.file_description) ?? capString(meta.primary_doc_description);
  if (fileDescription) out.fileDescription = fileDescription;

  return out;
}

/**
 * `federal_register` — allow-list derived from the single insert site in
 * services/worker/src/jobs/federalRegisterFetcher.ts ~L184-190.
 *   document_number    -> licenseNumber   (primary document identifier)
 *   publication_date   -> issuedDate
 *   agencies (array of names) -> issuerName (first agency) + extras.agencies
 *   type               -> extras.documentType
 *   citation           -> extras.citation
 *   pdf_url            -> extras.pdfUrl
 * EXCLUDED: abstract (~L189) — banned module-wide (never abstract /
 * description / summary; it already flows through `anchor.description`).
 * fieldOfStudy <- record.title: unlike edgar/openstates, the Federal
 * Register title (e.g. an agency's final-rule or notice title) IS the bare
 * document subject — it carries no baked-in identifier/date duplication.
 */
function projectFederalRegister(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};

  const fieldOfStudy = capString(record.title);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;

  const documentNumber = capString(meta.document_number);
  if (documentNumber) out.licenseNumber = documentNumber;

  const issuedDate = capString(meta.publication_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const agencies = capStringArray(meta.agencies, 20);
  if (agencies.length > 0) {
    out.issuerName = agencies[0];
    out.agencies = agencies;
  }

  const documentType = capString(meta.type);
  if (documentType) out.documentType = documentType;

  const citation = capString(meta.citation);
  if (citation) out.citation = citation;

  const pdfUrl = capString(meta.pdf_url);
  if (pdfUrl) out.pdfUrl = pdfUrl;

  return out;
}

/**
 * `openstates` — allow-list derived from the single insert site in
 * services/worker/src/jobs/openStatesFetcher.ts ~L254-266.
 *   identifier          -> licenseNumber   (bill identifier, e.g. "HB123")
 *   state_name          -> issuerName      (issuing legislature)
 *   latest_action_date  -> issuedDate
 *   session             -> extras.session
 *   classification      -> extras.classification
 *   subjects            -> extras.subjects
 *   chamber             -> extras.chamber
 *   jurisdiction        -> extras.jurisdiction
 *   latest_action       -> extras.latestAction
 * EXCLUDED: primary_sponsors (~L261) — sponsor names are person data, not
 * document-level; abstract (~L264) — banned module-wide.
 * fieldOfStudy is left unset — metadata carries no bare bill-subject field
 * (`record.title` bakes in the identifier + session, which already surface
 * separately as licenseNumber/extras.session).
 */
function projectOpenStates(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};

  const identifier = capString(meta.identifier);
  if (identifier) out.licenseNumber = identifier;

  const issuerName = capString(meta.state_name);
  if (issuerName) out.issuerName = issuerName;

  const issuedDate = capString(meta.latest_action_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const session = capString(meta.session);
  if (session) out.session = session;

  const classification = capStringArray(meta.classification, 20);
  if (classification.length > 0) out.classification = classification;

  const subjects = capStringArray(meta.subjects, 20);
  if (subjects.length > 0) out.subjects = subjects;

  const chamber = capString(meta.chamber);
  if (chamber) out.chamber = chamber;

  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;

  const latestAction = capString(meta.latest_action);
  if (latestAction) out.latestAction = latestAction;

  return out;
}

const PROJECTORS: Record<string, (record: ProjectablePublicRecord) => ProjectedTemplate> = {
  openalex: projectOpenAlex,
  edgar: projectEdgar,
  federal_register: projectFederalRegister,
  openstates: projectOpenStates,
};

/**
 * Projects a pipeline-anchored `public_records` row onto template display
 * keys for the given `source`. Returns `{}` for any source not explicitly
 * implemented above (see module doc for the deferred person-registry list).
 */
export function projectPublicRecordToTemplate(
  source: string,
  record: ProjectablePublicRecord,
): ProjectedTemplate {
  const projector = PROJECTORS[source];
  if (!projector) return {};
  return projector(record);
}

/** UI-side display cap, independent of the MAX_AUTHORS projector cap above. */
const AUTHORS_DISPLAY_CAP = 10;

/**
 * Shared display formatter for an `authors` field value produced by this
 * module (`{ name, orcid? }[]`). Consumers (AssetDetailView's generic
 * metadata dump, CredentialRenderer's generic metadata dump) both render
 * arbitrary metadata values with a default `JSON.stringify` for objects —
 * this is the ONE narrow override, for exactly the `authors` key, so both
 * surfaces show joined names instead of a raw object-array dump. Returns
 * `null` for anything that isn't a non-empty array of `{ name: string
 * }`-shaped entries, so a malformed/legacy value still falls through to
 * each consumer's own default rendering rather than showing nothing.
 */
export function formatAuthorsDisplay(value: unknown, maxShown = AUTHORS_DISPLAY_CAP): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = value
    .map((entry) => (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name
      : null))
    .filter((name): name is string => name !== null);
  if (names.length === 0) return null;
  const shown = names.slice(0, maxShown);
  const remaining = names.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} +${remaining} more` : shown.join(', ');
}
