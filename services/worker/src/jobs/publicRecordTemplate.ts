/**
 * Public-record → credential-template projection (SCRUM-5106).
 *
 * RULED DESIGN (CTO, 2026-09-13 — do not deviate without a new ruling):
 *   - Author/inventor names are written to a distinct `authors` key as an
 *     array of `{ name: string; orcid?: string }`, capped at 20 entries.
 *     They are NEVER written to `recipientIdentifier` — that key is
 *     hashed-never-raw-PII by contract (`ai/types.ts` — grep
 *     `recipientIdentifier` there for the invariant this must not violate).
 *   - The platform TEMPLATE ROW re-key (the credential-template definition
 *     itself) is a SEPARATE PR that ships with a migration. This module only
 *     changes what NEW pipeline anchors write into `anchors.metadata`; it
 *     does not touch any existing row (no backfill) and does not touch
 *     `public_records` or template-definition tables.
 *
 * Scope (2026-09-13 amendment — founder directive, same day): the projector
 * covers every source `publicRecordAnchor.ts` currently anchors, not a
 * four-source subset. `SOURCE_FIELD_TABLE` below is the audit surface: each
 * row names which pipeline `metadata` key (or `$title` / `$sourceId` / a
 * fixed constant) feeds which template key, so a reviewer can check the
 * allow-list without reading the resolver code. Two categories get the same
 * five template keys and the same bounds, never raw nested objects:
 *
 *   - Document/legal sources (edgar, federal_register, openstates,
 *     courtlistener, uspto, and the jurisdiction-compliance statute/case-law
 *     families) — court/office, docket/patent/document number, issue date,
 *     and TITLE are allowed. A document's conventional title (e.g. a court
 *     case caption) is not treated as a "party name" for this purpose — the
 *     same way `record.title` is allowed through for `openalex` even though
 *     it is also the anchor filename. What IS excluded per source: judge
 *     lists, bill sponsors, and any other separately-structured person-name
 *     field (see the per-source notes below `SOURCE_FIELD_TABLE`).
 *   - Registry/person sources (npi, finra, calbar, acnc, dapip,
 *     edgar_form_adv, sec_iapd, acra_sg, cnpj_br, moh_sg) — REGISTRY-LEVEL
 *     fields only: identifiers (NPI/CRD/bar number/ABN/UEN/CNPJ/licence no),
 *     status, specialty/taxonomy/practice area, employing firm/organisation,
 *     state/jurisdiction, registration/issue/expiry dates, licence type.
 *     Never an address line (not even city), email, phone, DOB, a
 *     government person-tax-id, or free-text notes/discipline narratives.
 *     The person/entity's own name is already the anchor filename
 *     (`buildAnchorFilename`) and is never duplicated into `fieldOfStudy`.
 *
 * `sec_adv_bulk` does not exist in any fetcher (verified: `grep -rn
 * sec_adv_bulk services/worker/src` — zero hits), but prod `public_records`
 * carries ~1,500 rows with `source = 'sec_adv_bulk'` from an April 2026 bulk
 * Form ADV load that ran before `edgarFormAdvFetcher.ts` was renamed to its
 * current `edgar_form_adv` source string — the same "row exists, fetcher
 * name moved on" situation as `australia_law`/`kenya_law`. `SOURCE_FIELD_TABLE`
 * aliases `sec_adv_bulk` to the identical `edgar_form_adv` spec object (not a
 * duplicated copy — see the table) so both spellings project the same way;
 * `edgar_form_adv` is this file's sibling `edgarFormAdvFetcher.ts`, and the
 * unrelated `sec_iapd` (`secIapdFetcher.ts`) is covered separately below.
 *
 * Zero-row / broken sources: `fcc`, `sam_gov`, `sam_gov_exclusions`,
 * `sos_de`/`sos_ca`/`sos_ny`/`sos_tx`, `ipeds`, `insurance_ca_cdi`,
 * `cle_ny`/`cle_tx`, `cert_cfa`/`cert_comptia`/`cert_pmi` appear in
 * `SOURCE_PREFIX`/`mapCredentialType` but have zero rows in prod today — their
 * fetchers are broken or unfinished placeholders (SCRUM-5045, SCRUM-5046).
 * `{}` (no `SOURCE_FIELD_TABLE` entry) is the correct, confirmed-intentional
 * output for all of them; add a real entry only once a fetcher for one of
 * them is actually live and writing rows.
 *
 * Bounds (unchanged from the original four-source design):
 *   - Every string value is capped at 500 UTF-16 units via
 *     `truncateUtf16Safe` (surrogate-safe — see that module's header for
 *     why a bare `.slice()` is a poison-record risk).
 *   - Total serialized projection must be <= 4,096 bytes. Openalex is the
 *     only source with a realistic risk of exceeding it (many authors +
 *     concepts), so it is the one with an explicit, tested drop order:
 *     concepts, then authors beyond 5, then cited_by_count. Every other
 *     source's worst case is far under the bound (see
 *     `publicRecordTemplate.test.ts`'s size assertions), so the default
 *     drop order (declared extras, least-declared-first, then authors
 *     trimmed to 5, then authors dropped) exists as a backstop and is not
 *     independently soak-tested per source.
 */

import { z } from 'zod';
import { truncateUtf16Safe } from '../utils/utf16-truncate.js';

const MAX_STRING_UNITS = 500;
const MAX_SERIALIZED_BYTES = 4_096;
const MAX_AUTHORS = 20;
const AUTHORS_SIZE_TRIM_TO = 5;

/** Never emit a key matching this, or any of the literal names below, regardless of source config. */
const FORBIDDEN_KEY_PATTERN = /email|phone|ssn|dob|address/i;
const FORBIDDEN_LITERAL_KEYS = new Set(['abstract', 'description', 'summary', 'recipientIdentifier']);

export interface TemplateAuthor {
  name: string;
  orcid?: string;
}

export type ProjectedTemplateValue = string | number | boolean | string[] | TemplateAuthor[];

export type ProjectedTemplate = Record<string, ProjectedTemplateValue>;

export interface PublicRecordForTemplate {
  title: string | null;
  metadata: Record<string, unknown>;
  /**
   * Optional — matches the RULED DESIGN's fixed `(source, record)` signature
   * (`record: { title, metadata }`) while still letting callers that have a
   * `source_id` (every real caller does; `PipelinePublicRecord` structurally
   * satisfies this interface with room to spare) reach it for the handful of
   * sources whose only stable per-row identifier lives there, not in
   * `metadata` (edgar's accession number, the jurisdiction case-law
   * scraper's synthetic id). Absent, `sourceId`-ref template keys resolve to
   * undefined rather than throwing.
   */
  source_id?: string | null;
}

const AuthorEntrySchema = z.object({
  name: z.string().min(1).max(MAX_STRING_UNITS),
  orcid: z.string().max(MAX_STRING_UNITS).optional(),
}).strict();

const ScalarValueSchema = z.union([
  z.string().max(MAX_STRING_UNITS),
  z.number(),
  z.boolean(),
  z.array(z.string().max(MAX_STRING_UNITS)),
]);

/**
 * NOTE on `.strict()`: the original single-source design used a fixed
 * five-key object and could validate it with a literal `z.object().strict()`.
 * Once the projector covers ~20 sources, each with its own small "extras"
 * set (documented per-source below), the output shape is legitimately
 * dynamic-keyed — a fixed `.strict()` object can't express "these five keys,
 * plus whichever named extras this source declares". `.catchall()` is the
 * closest equivalent that still rejects anything unexpected: the five known
 * keys are validated by name and type, and every OTHER key must still match
 * `ScalarValueSchema` (authors is the only key allowed to be an object
 * array). Nothing gets a free pass the way `.passthrough()` would allow.
 * The forbidden-key check below is the part `.strict()` could never express
 * anyway (it's about key NAMES, not shape) and runs regardless.
 */
export const ProjectedTemplateSchema = z
  .object({
    issuerName: z.string().max(MAX_STRING_UNITS).optional(),
    issuedDate: z.string().max(MAX_STRING_UNITS).optional(),
    licenseNumber: z.union([z.string().max(MAX_STRING_UNITS), z.number()]).optional(),
    fieldOfStudy: z.string().max(MAX_STRING_UNITS).optional(),
    authors: z.array(AuthorEntrySchema).max(MAX_AUTHORS).optional(),
  })
  .catchall(ScalarValueSchema)
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEY_PATTERN.test(key) || FORBIDDEN_LITERAL_KEYS.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `forbidden template key: ${key}`, path: [key] });
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────
// Field references — how a template key resolves against a source record.
// ─────────────────────────────────────────────────────────────────────────

type FieldRef =
  | { kind: 'title' }
  | { kind: 'sourceId' }
  | { kind: 'meta'; key: string }
  | { kind: 'metaFirst'; key: string }
  | { kind: 'metaFallback'; keys: string[] };

const title: FieldRef = { kind: 'title' };
const sourceId: FieldRef = { kind: 'sourceId' };
const meta = (key: string): FieldRef => ({ kind: 'meta', key });
const metaFirst = (key: string): FieldRef => ({ kind: 'metaFirst', key });
const metaFallback = (...keys: string[]): FieldRef => ({ kind: 'metaFallback', keys });

type AuthorsBuilder = 'openalex';

interface ExtraSpec {
  /** Output key name — need not match the source metadata key. */
  key: string;
  ref: FieldRef;
}

interface SourceSpec {
  /** Documentation only — not read by the resolver. */
  category: 'publication' | 'filing' | 'registry' | 'document' | 'legislation' | 'legal';
  issuerName?: FieldRef;
  issuedDate?: FieldRef;
  licenseNumber?: FieldRef;
  fieldOfStudy?: FieldRef;
  authors?: AuthorsBuilder;
  /** Declared least-important-first: the default drop order trims from the START of this array. */
  extras?: ExtraSpec[];
}

/**
 * SOURCE FIELD TABLE — the audit surface.
 *
 * Read as: source → { templateKey: sourceField }. `$title` means
 * `record.title` (the row's own title column, not a metadata key);
 * `$sourceId` means `record` doesn't carry the field on `metadata` at all —
 * the pipeline's own `source_id` column is the closest stable identifier.
 * A source with no entry here (falls through to `{}` in
 * `projectPublicRecordToTemplate`) has not been reviewed for a template
 * mapping yet — anchoring still proceeds, it just carries the four linkage
 * keys from `buildPipelineAnchorInsert`, same as today.
 */

/**
 * `sec_adv_bulk` is an ALIAS of this spec object (see header note): prod
 * `public_records` still carries ~1,500 rows from the April 2026 bulk load
 * under the old source string, and this is the exact shape
 * `edgarFormAdvFetcher.ts` wrote before the rename to `edgar_form_adv`. One
 * spec object, two source keys — not a duplicated copy that can drift.
 */
const EDGAR_FORM_ADV_SPEC: SourceSpec = {
  category: 'registry',
  issuerName: meta('registry'),
  issuedDate: meta('last_filing_date'),
  licenseNumber: meta('crd_number'),
  extras: [
    { key: 'secNumber', ref: meta('sec_number') },
    { key: 'country', ref: meta('country') },
    { key: 'licenseType', ref: meta('license_type') },
    { key: 'state', ref: meta('state') },
    { key: 'registrationStatus', ref: meta('registration_status') },
    { key: 'jurisdiction', ref: meta('jurisdiction') },
  ],
};

export const SOURCE_FIELD_TABLE: Record<string, SourceSpec> = {
  // ---- Publication ---------------------------------------------------
  openalex: {
    category: 'publication',
    issuerName: meta('journal'),
    issuedDate: meta('publication_date'),
    licenseNumber: meta('doi'), // https://doi.org/ prefix stripped
    fieldOfStudy: title,
    authors: 'openalex',
    extras: [
      { key: 'isOpenAccess', ref: meta('is_open_access') },
      { key: 'isRetracted', ref: meta('is_retracted') },
      { key: 'publicationYear', ref: meta('publication_year') },
      { key: 'citedByCount', ref: meta('cited_by_count') },
      { key: 'concepts', ref: meta('concepts') }, // string[] of concept display names, capped 10
    ],
  },

  // ---- SEC / EDGAR filings (document) ---------------------------------
  edgar: {
    category: 'filing',
    issuerName: meta('entity_name'),
    issuedDate: meta('filing_date'),
    licenseNumber: sourceId, // accession number
    fieldOfStudy: meta('form_type'),
    extras: [
      { key: 'periodOfReport', ref: meta('period_of_report') },
      { key: 'tickers', ref: meta('tickers') },
      { key: 'ciks', ref: meta('ciks') },
      { key: 'primaryDocument', ref: meta('primary_document') },
      { key: 'fileDescription', ref: metaFallback('file_description', 'primary_doc_description') },
    ],
  },

  // ---- Investment-adviser registries (registry) — see header note re: `sec_adv_bulk`.
  edgar_form_adv: EDGAR_FORM_ADV_SPEC,
  sec_adv_bulk: EDGAR_FORM_ADV_SPEC, // alias — pre-rename source string, same fetcher shape
  sec_iapd: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('crd_number'),
    extras: [
      { key: 'totalAssets', ref: meta('total_assets') },
      { key: 'numberOfAccounts', ref: meta('number_of_accounts') },
      { key: 'country', ref: meta('country') },
      { key: 'licenseType', ref: meta('license_type') },
      { key: 'state', ref: meta('state') },
      { key: 'registrationStatus', ref: meta('registration_status') },
      { key: 'secNumber', ref: meta('sec_number') },
      { key: 'disclosureCount', ref: meta('disclosure_count') },
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'jurisdictions', ref: meta('jurisdictions') },
    ],
  },

  // ---- Federal Register (document) -------------------------------------
  federal_register: {
    category: 'document',
    issuerName: metaFirst('agencies'),
    issuedDate: meta('publication_date'),
    licenseNumber: meta('document_number'),
    fieldOfStudy: title,
    extras: [
      { key: 'citation', ref: meta('citation') },
      { key: 'documentType', ref: meta('type') },
      { key: 'pdfUrl', ref: meta('pdf_url') },
      { key: 'agencies', ref: meta('agencies') },
    ],
  },

  // ---- Open States legislation (document) — sponsor names excluded. ----
  openstates: {
    category: 'legislation',
    issuerName: meta('chamber'),
    issuedDate: meta('latest_action_date'),
    licenseNumber: meta('identifier'), // bill id, e.g. "HB123"
    // fieldOfStudy intentionally unset: record.title bakes in the
    // identifier + session ("HB123: Title (State session)"), which would
    // just duplicate licenseNumber/extras.session/issuerName content.
    extras: [
      { key: 'latestAction', ref: meta('latest_action') },
      { key: 'classification', ref: meta('classification') },
      { key: 'state', ref: meta('state') },
      { key: 'session', ref: meta('session') },
      { key: 'subjects', ref: meta('subjects') },
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'stateName', ref: meta('state_name') },
    ],
  },

  // ---- CourtListener case law (legal) — judges excluded. ----------------
  courtlistener: {
    category: 'legal',
    issuerName: meta('court_name'),
    issuedDate: meta('date_filed'),
    licenseNumber: meta('docket_id'), // numeric on the fetcher; stringified below
    fieldOfStudy: meta('case_name'), // case caption; see header note on titles vs. party-name fields
    extras: [
      { key: 'citations', ref: meta('citations') }, // string[], capped
      { key: 'citationCount', ref: meta('citation_count') },
      { key: 'natureOfSuit', ref: meta('nature_of_suit') },
      { key: 'precedentialStatus', ref: meta('precedential_status') },
      { key: 'opinionCount', ref: meta('opinion_count') },
      { key: 'courtId', ref: meta('court_id') },
      { key: 'dateFiledIsApproximate', ref: meta('date_filed_is_approximate') },
    ],
  },

  // ---- USPTO patents (legal/document) ------------------------------------
  // `usptoFetcher.ts` writes exactly three metadata keys (patent_id,
  // patent_type, patent_date) — nothing else, no inventors, no issuing-office
  // field. Project only what the fetcher actually carries: an `authors`
  // builder with no input source, or a constant issuerName not backed by
  // fetched data, reads as live capability to the next person touching this
  // file. Add both back in the same PR that teaches usptoFetcher.ts to
  // capture them, not before.
  uspto: {
    category: 'legal',
    issuedDate: meta('patent_date'),
    licenseNumber: meta('patent_id'),
    fieldOfStudy: title,
    extras: [
      { key: 'patentType', ref: meta('patent_type') },
    ],
  },

  // ---- Jurisdiction compliance: statutes (document) ---------------------
  australia_law: {
    category: 'document',
    // The record's OWN primary identifier is section_id (one row per
    // statute SECTION) — statute_id is shared by every section of the same
    // statute and is not this record's own id.
    issuerName: meta('jurisdiction'), // plain country name, e.g. "Australia"
    licenseNumber: meta('section_id'),
    fieldOfStudy: meta('section_title'),
    extras: [
      { key: 'statuteName', ref: meta('statute_name') },
      { key: 'jurisdictionCode', ref: meta('jurisdiction_code') },
      { key: 'part', ref: meta('part') },
    ],
  },
  kenya_law: {
    category: 'document',
    issuerName: meta('jurisdiction'),
    licenseNumber: meta('section_id'),
    fieldOfStudy: meta('section_title'),
    extras: [
      { key: 'statuteName', ref: meta('statute_name') },
      { key: 'jurisdictionCode', ref: meta('jurisdiction_code') },
      { key: 'part', ref: meta('part') },
    ],
  },

  // ---- Jurisdiction compliance: case law (legal) -------------------------
  australia_caselaw: {
    category: 'legal',
    issuerName: meta('court'),
    licenseNumber: sourceId, // no docket/case number in metadata; the pipeline's own source_id is this record's identifier
    fieldOfStudy: meta('case_title'),
    extras: [
      { key: 'jurisdictionCode', ref: meta('jurisdiction_code') },
    ],
  },
  kenya_caselaw: {
    category: 'legal',
    issuerName: meta('court'),
    licenseNumber: sourceId,
    fieldOfStudy: meta('case_title'),
    extras: [
      { key: 'jurisdictionCode', ref: meta('jurisdiction_code') },
    ],
  },

  // ---- Registry / person sources — registry-level fields only. ----------
  npi: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('npi_number'),
    issuedDate: meta('enumeration_date'),
    fieldOfStudy: meta('primary_specialty'),
    extras: [
      { key: 'enumerationType', ref: meta('enumeration_type') },
      { key: 'primaryTaxonomyCode', ref: meta('primary_taxonomy_code') },
      { key: 'status', ref: meta('status') },
      { key: 'credential', ref: meta('credential') },
      { key: 'licenseType', ref: meta('license_type') },
    ],
  },
  finra: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('crd_number'),
    issuedDate: meta('industry_start_date'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'licenseType', ref: meta('license_type') },
      { key: 'currentFirmCrd', ref: meta('current_firm_crd') },
      { key: 'disclosureCount', ref: meta('disclosure_count') },
      { key: 'currentFirm', ref: meta('current_firm') },
      { key: 'registrations', ref: meta('registrations') },
    ],
  },
  calbar: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('bar_number'),
    issuedDate: meta('admission_date'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'licenseType', ref: meta('license_type') },
      { key: 'advancedSpecializations', ref: meta('advanced_specializations') },
      { key: 'sections', ref: meta('sections') },
      { key: 'state', ref: meta('state') },
      { key: 'status', ref: meta('status') },
    ],
  },
  dapip: {
    category: 'registry',
    licenseNumber: metaFallback('ope_id', 'dapip_id'),
    extras: [
      { key: 'state', ref: meta('state') },
      { key: 'activeStatus', ref: meta('active_status') },
      { key: 'institutionType', ref: meta('institution_type') },
    ],
  },
  acnc: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('abn'),
    issuedDate: meta('registration_date'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'pbi', ref: meta('pbi') },
      { key: 'country', ref: meta('country') },
      { key: 'state', ref: meta('state') },
      { key: 'charitySize', ref: meta('charity_size') },
      { key: 'dateEstablished', ref: meta('date_established') },
      { key: 'purposes', ref: meta('purposes') },
      { key: 'operatingCountries', ref: meta('operating_countries') },
      { key: 'responsiblePersonsCount', ref: meta('responsible_persons') },
    ],
  },
  acra_sg: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('uen'),
    issuedDate: meta('registration_date'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'primarySsicCode', ref: meta('primary_ssic_code') },
      { key: 'primarySsicDescription', ref: meta('primary_ssic_description') },
      { key: 'secondarySsicCode', ref: meta('secondary_ssic_code') },
      { key: 'secondarySsicDescription', ref: meta('secondary_ssic_description') },
      { key: 'companyType', ref: meta('company_type') },
      { key: 'uenStatus', ref: meta('uen_status') },
      { key: 'entityType', ref: meta('entity_type') },
    ],
  },
  cnpj_br: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('cnpj_formatted'),
    issuedDate: meta('data_inicio_atividade'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'porte', ref: meta('porte') },
      { key: 'naturezaJuridica', ref: meta('natureza_juridica') },
      { key: 'uf', ref: meta('uf') },
      { key: 'status', ref: meta('situacao_cadastral') },
      { key: 'cnaeFiscal', ref: meta('cnae_fiscal') },
      { key: 'cnaeDescricao', ref: meta('cnae_descricao') },
    ],
  },
  moh_sg: {
    category: 'registry',
    issuerName: meta('registry'),
    licenseNumber: meta('licence_no'),
    issuedDate: meta('effective_date'),
    extras: [
      { key: 'jurisdiction', ref: meta('jurisdiction') },
      { key: 'expiryDate', ref: meta('expiry_date') },
      { key: 'hciCode', ref: meta('hci_code') },
      { key: 'licenceStatus', ref: meta('licence_status') },
      { key: 'licenceType', ref: meta('licence_type') },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Resolution + value coercion
// ─────────────────────────────────────────────────────────────────────────

function truncated(input: string): string {
  return truncateUtf16Safe(input, MAX_STRING_UNITS);
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERN.test(key) || FORBIDDEN_LITERAL_KEYS.has(key);
}

function stripUrlPrefix(value: string): string {
  return value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^https?:\/\/orcid\.org\//i, '');
}

function resolveRaw(
  ref: FieldRef,
  record: { title: string | null; sourceId: string | null; metadata: Record<string, unknown> },
): unknown {
  switch (ref.kind) {
    case 'title':
      return record.title;
    case 'sourceId':
      return record.sourceId;
    case 'meta':
      if (isForbiddenKey(ref.key)) return undefined;
      return record.metadata[ref.key];
    case 'metaFirst': {
      if (isForbiddenKey(ref.key)) return undefined;
      const arr = record.metadata[ref.key];
      return Array.isArray(arr) ? arr[0] : undefined;
    }
    case 'metaFallback': {
      for (const key of ref.keys) {
        if (isForbiddenKey(key)) continue;
        const val = record.metadata[key];
        if (val !== null && val !== undefined && val !== '') return val;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Coerce a resolved value into a scalar template value, or undefined if it doesn't fit. */
function coerceScalar(raw: unknown): string | number | boolean | string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? truncated(trimmed) : undefined;
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    const strings = raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (strings.length === 0) return undefined;
    return strings.slice(0, 10).map(truncated);
  }
  return undefined;
}

function normalizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw === 'string') return coerceScalar(raw) as string | undefined;
  if (raw && typeof raw === 'object' && 'display_name' in (raw as Record<string, unknown>)) {
    const name = (raw as Record<string, unknown>).display_name;
    return typeof name === 'string' ? coerceScalar(name) as string | undefined : undefined;
  }
  return undefined;
}

interface OpenAlexAuthorInput {
  name?: unknown;
  orcid?: unknown;
}

function buildOpenAlexAuthors(raw: unknown): TemplateAuthor[] {
  if (!Array.isArray(raw)) return [];
  const authors: TemplateAuthor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, orcid } = entry as OpenAlexAuthorInput;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    const author: TemplateAuthor = { name: truncated(name.trim()) };
    if (typeof orcid === 'string' && orcid.trim().length > 0) {
      author.orcid = truncated(stripUrlPrefix(orcid.trim()));
    }
    authors.push(author);
    if (authors.length >= MAX_AUTHORS) break;
  }
  return authors;
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
}

/**
 * Drop order when a projection exceeds `MAX_SERIALIZED_BYTES`: openalex's
 * order is explicit per the ruled design (concepts, then authors beyond 5,
 * then cited_by_count); every other source falls back to its declared
 * `extras` array, least-important-first (the array is authored in that
 * order), then authors trimmed to 5, then authors dropped entirely.
 */
function enforceSizeBound(
  out: ProjectedTemplate,
  spec: SourceSpec,
  source: string,
): ProjectedTemplate {
  if (byteSize(out) <= MAX_SERIALIZED_BYTES) return out;

  const dropOrder: string[] = source === 'openalex'
    ? ['concepts', '__authors_trim__', 'citedByCount', 'publicationYear', 'isRetracted', 'isOpenAccess']
    : [...(spec.extras ?? []).map((e) => e.key), '__authors_trim__'];

  for (const step of dropOrder) {
    if (byteSize(out) <= MAX_SERIALIZED_BYTES) break;
    if (step === '__authors_trim__') {
      const authors = out.authors as TemplateAuthor[] | undefined;
      if (authors && authors.length > AUTHORS_SIZE_TRIM_TO) {
        out.authors = authors.slice(0, AUTHORS_SIZE_TRIM_TO);
      }
      continue;
    }
    delete out[step];
  }

  // Backstop: authors dropped entirely, then any remaining extras.
  while (byteSize(out) > MAX_SERIALIZED_BYTES) {
    if (out.authors) {
      delete out.authors;
      continue;
    }
    const extraKeys = Object.keys(out).filter(
      (k) => !['issuerName', 'issuedDate', 'licenseNumber', 'fieldOfStudy', 'authors'].includes(k),
    );
    if (extraKeys.length > 0) {
      delete out[extraKeys[0]];
      continue;
    }
    break; // core fields alone, each capped at 500 units, cannot exceed 4KB.
  }

  return out;
}

/**
 * Project a public record's fetcher-written `metadata` into the bounded,
 * PII-scrubbed shape a credential template can read. Pure — no I/O.
 */
export function projectPublicRecordToTemplate(
  source: string,
  record: PublicRecordForTemplate,
): ProjectedTemplate {
  const spec = SOURCE_FIELD_TABLE[source];
  if (!spec) return {};

  const ctx = {
    title: record.title,
    sourceId: record.source_id ?? null,
    metadata: record.metadata ?? {},
  };
  const out: ProjectedTemplate = {};

  if (spec.issuerName) {
    const raw = resolveRaw(spec.issuerName, ctx);
    const name = normalizeDisplayName(raw);
    if (typeof name === 'string') out.issuerName = name;
  }
  if (spec.issuedDate) {
    const val = coerceScalar(resolveRaw(spec.issuedDate, ctx));
    if (typeof val === 'string') out.issuedDate = val;
  }
  if (spec.licenseNumber) {
    const raw = resolveRaw(spec.licenseNumber, ctx);
    if (typeof raw === 'string') {
      const stripped = stripUrlPrefix(raw.trim());
      const val = coerceScalar(stripped);
      if (typeof val === 'string') out.licenseNumber = val;
    } else if (typeof raw === 'number') {
      // Stringify: only two sources carry a numeric id (courtlistener's
      // docket_id, dapip's dapip_id) — every other licenseNumber source is
      // already a string. Stringifying keeps the shared parity fixture's
      // expected output identical across both packages' resolvers.
      out.licenseNumber = String(raw);
    }
  }
  if (spec.fieldOfStudy) {
    const val = coerceScalar(resolveRaw(spec.fieldOfStudy, ctx));
    if (typeof val === 'string') out.fieldOfStudy = val;
  }
  if (spec.authors === 'openalex') {
    const authors = buildOpenAlexAuthors(ctx.metadata.authors);
    if (authors.length > 0) out.authors = authors;
  }

  for (const extra of spec.extras ?? []) {
    if (isForbiddenKey(extra.key)) continue; // defense-in-depth; no declared extra should ever hit this
    const val = coerceScalar(resolveRaw(extra.ref, ctx));
    if (val !== undefined) out[extra.key] = val;
  }

  // Defense-in-depth: strip anything forbidden regardless of how it got in.
  for (const key of Object.keys(out)) {
    if (isForbiddenKey(key)) delete out[key];
  }

  return enforceSizeBound(out, spec, source);
}
