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
 * SCOPE:
 * - `SOURCE_FIELD_ALLOW_LIST` below is the audit table: every `source` this
 *   module projects, and for each template/extras key, the exact
 *   `metadata` field it is read from (line references are in each
 *   projector function's own comment, since a table entry going stale
 *   silently is worse than a slightly longer file). A source not in the
 *   table returns `{}` — currently that includes `sam_gov` and any source
 *   with zero rows in prod at the time of writing (fcc, sos_*, ipeds,
 *   insurance_ca_cdi, cle_*, cert_*, per SCRUM-5045/5046). Do not widen this
 *   without independently re-reading the fetcher — an earlier draft of
 *   this table asserted USPTO carries inventor data and that
 *   australia_law/kenya_law are legacy aliases of the case-law sources;
 *   neither is true (verified directly against
 *   services/worker/src/jobs/usptoFetcher.ts and jurisdictionFetcher.ts —
 *   `australia_law`/`kenya_law` are the CURRENT, active STATUTE sources,
 *   distinct in both name and shape from `australia_caselaw`/
 *   `kenya_caselaw`).
 * - Registry/person-adjacent sources (npi, finra, calbar, acnc, dapip,
 *   edgar_form_adv, sec_adv_bulk, sec_iapd, acra_sg, cnpj_br, moh_sg)
 *   project REGISTRY-LEVEL fields only: identifiers, status,
 *   specialty/practice-area/taxonomy, firm/organisation name, jurisdiction,
 *   dates, licence type. The practitioner/entity's own name is already the
 *   anchor filename, so it is never duplicated into a template field here.
 *   Never emitted: home/mailing address (not even city/postcode — when a
 *   fetcher stores one, it is dropped entirely), email, phone, date of
 *   birth, a person's own name (provider_name, full_name, charity_legal_name,
 *   entity_name, licensee_name, authorized_official, etc.), or any
 *   free-text notes/disclosure-history field.
 * - Document/legal sources (uspto, courtlistener, australia_law/
 *   australia_caselaw, kenya_law/kenya_caselaw) project court/office,
 *   docket/patent/section number, decision/grant date, and title — never
 *   party or judge names.
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
  /**
   * Optional — most sources carry their own primary identifier inside
   * `metadata`, but a handful don't: edgar's accession number and the
   * jurisdiction case-law scraper's synthetic id live only on the pipeline
   * row's own `source_id` column. Absent, those sources' `licenseNumber`
   * resolves to undefined rather than throwing. Mirrors the worker
   * projector's `PublicRecordForTemplate.source_id` (SCRUM-5106) so both
   * packages resolve the same canonical field for the same template key.
   */
  source_id?: string | null;
}

/**
 * Audit table: source -> { output key: source metadata field }. This is the
 * canonical, human-checkable summary of what each projector below reads —
 * NOT itself executed (each projector remains hand-written for the
 * per-field safety logic: capping, stripping, exclusions, aliasing). Keep
 * this in sync whenever a projector changes; a mismatch here is a doc bug,
 * not a behavior bug, but review a PR that touches one without the other.
 * `sec_adv_bulk` and `kenya_law`/`kenya_caselaw` are noted as sharing a
 * projector rather than repeating identical rows.
 */
export const SOURCE_FIELD_ALLOW_LIST: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  openalex: {
    fieldOfStudy: 'title', issuerName: 'journal', issuedDate: 'publication_date',
    licenseNumber: 'doi (https://doi.org/ prefix stripped)', authors: 'authors ({name, orcid?}, max 20)',
    concepts: 'concepts (max 10)', publicationYear: 'publication_year', citedByCount: 'cited_by_count',
    isRetracted: 'is_retracted', isOpenAccess: 'is_open_access',
  },
  edgar: {
    issuerName: 'entity_name', issuedDate: 'filing_date',
    // licenseNumber is the record's OWN identifier — for a filing that's the
    // accession number (pipeline source_id column), never a CIK (the FILER's
    // id, shared across every filing that company ever makes).
    licenseNumber: '$sourceId (accession)', fieldOfStudy: 'form_type', ciks: 'ciks',
    periodOfReport: 'period_of_report', tickers: 'tickers', primaryDocument: 'primary_document',
    fileDescription: 'file_description | primary_doc_description',
  },
  federal_register: {
    fieldOfStudy: 'title', licenseNumber: 'document_number', issuedDate: 'publication_date',
    issuerName: 'agencies[0]', agencies: 'agencies', documentType: 'type', citation: 'citation', pdfUrl: 'pdf_url',
  },
  openstates: {
    licenseNumber: 'identifier', issuerName: 'chamber', issuedDate: 'latest_action_date',
    // fieldOfStudy intentionally unset — record.title bakes in the
    // identifier + session, duplicating licenseNumber/extras.session.
    session: 'session', classification: 'classification', subjects: 'subjects', stateName: 'state_name',
    state: 'state', jurisdiction: 'jurisdiction', latestAction: 'latest_action',
  },
  npi: {
    licenseNumber: 'npi_number', issuerName: 'registry', issuedDate: 'enumeration_date',
    fieldOfStudy: 'primary_specialty', primaryTaxonomyCode: 'primary_taxonomy_code', credential: 'credential',
    status: 'status', enumerationType: 'enumeration_type', licenseType: 'license_type',
  },
  finra: {
    licenseNumber: 'crd_number', issuerName: 'registry', issuedDate: 'industry_start_date',
    currentFirm: 'current_firm', currentFirmCrd: 'current_firm_crd', disclosureCount: 'disclosure_count',
    registrations: 'registrations', licenseType: 'license_type', jurisdiction: 'jurisdiction',
  },
  calbar: {
    licenseNumber: 'bar_number', issuerName: 'registry', issuedDate: 'admission_date', status: 'status',
    state: 'state', advancedSpecializations: 'advanced_specializations', sections: 'sections',
    licenseType: 'license_type', jurisdiction: 'jurisdiction',
  },
  dapip: {
    // No `registry` field exists for this source — issuerName has nothing
    // to bind to (institution_name is the record's OWN entity name, OUT).
    licenseNumber: 'ope_id | dapip_id', institutionType: 'institution_type',
    state: 'state', activeStatus: 'active_status',
  },
  acnc: {
    licenseNumber: 'abn', issuerName: 'registry', issuedDate: 'registration_date',
    charitySize: 'charity_size', pbi: 'pbi', country: 'country', state: 'state',
    dateEstablished: 'date_established', purposes: 'purposes', operatingCountries: 'operating_countries',
    responsiblePersonsCount: 'responsible_persons', jurisdiction: 'jurisdiction',
  },
  uspto: {
    licenseNumber: 'patent_id', issuedDate: 'patent_date', fieldOfStudy: 'title (public_records.title)',
    patentType: 'patent_type',
  },
  courtlistener: {
    issuerName: 'court_name', licenseNumber: 'docket_id', issuedDate: 'date_filed',
    fieldOfStudy: 'case_name', precedentialStatus: 'precedential_status', citationCount: 'citation_count',
    citations: 'citations', natureOfSuit: 'nature_of_suit', opinionCount: 'opinion_count',
    courtId: 'court_id', dateFiledIsApproximate: 'date_filed_is_approximate',
  },
  edgar_form_adv: {
    licenseNumber: 'crd_number', issuerName: 'registry', issuedDate: 'last_filing_date',
    secNumber: 'sec_number', state: 'state', country: 'country', registrationStatus: 'registration_status',
    licenseType: 'license_type', jurisdiction: 'jurisdiction',
  },
  sec_adv_bulk: { '(alias)': 'same projector + fields as edgar_form_adv' },
  sec_iapd: {
    licenseNumber: 'crd_number', issuerName: 'registry', registrationStatus: 'registration_status',
    totalAssets: 'total_assets', numberOfAccounts: 'number_of_accounts', licenseType: 'license_type',
    secNumber: 'sec_number', country: 'country', state: 'state', disclosureCount: 'disclosure_count',
    jurisdiction: 'jurisdiction', jurisdictions: 'jurisdictions',
  },
  acra_sg: {
    licenseNumber: 'uen', issuerName: 'registry', issuedDate: 'registration_date',
    entityType: 'entity_type', uenStatus: 'uen_status', primarySsicCode: 'primary_ssic_code',
    primarySsicDescription: 'primary_ssic_description', secondarySsicCode: 'secondary_ssic_code',
    secondarySsicDescription: 'secondary_ssic_description', companyType: 'company_type',
    jurisdiction: 'jurisdiction',
  },
  cnpj_br: {
    licenseNumber: 'cnpj_formatted', issuerName: 'registry', issuedDate: 'data_inicio_atividade',
    status: 'situacao_cadastral', naturezaJuridica: 'natureza_juridica', porte: 'porte', uf: 'uf',
    cnaeFiscal: 'cnae_fiscal', cnaeDescricao: 'cnae_descricao', jurisdiction: 'jurisdiction',
  },
  australia_law: {
    licenseNumber: 'section_id', issuerName: 'jurisdiction', fieldOfStudy: 'section_title',
    statuteName: 'statute_name', part: 'part', jurisdictionCode: 'jurisdiction_code',
  },
  kenya_law: { '(same shape)': 'same projector + fields as australia_law' },
  australia_caselaw: {
    // No docket/case number field exists in metadata — the record's own
    // identifier is the pipeline source_id column (a synthetic id built by
    // the case-law scraper), same rule as edgar's accession number.
    issuerName: 'court', licenseNumber: '$sourceId', fieldOfStudy: 'case_title',
    jurisdictionCode: 'jurisdiction_code',
  },
  kenya_caselaw: { '(same shape)': 'same projector + fields as australia_caselaw' },
  moh_sg: {
    licenseNumber: 'licence_no', issuerName: 'registry', issuedDate: 'effective_date',
    licenceType: 'licence_type', licenceStatus: 'licence_status', expiryDate: 'expiry_date',
    hciCode: 'hci_code', jurisdiction: 'jurisdiction',
  },
};

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
 *   is_open_access                    -> extras (camelCased: publicationYear,
 *                                        citedByCount, isRetracted, isOpenAccess)
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
  if (publicationYear !== null) out.publicationYear = publicationYear;

  const citedByCount = capNumber(meta.cited_by_count);
  if (citedByCount !== null) out.citedByCount = citedByCount;

  const isRetracted = capBoolean(meta.is_retracted);
  if (isRetracted !== null) out.isRetracted = isRetracted;

  const isOpenAccess = capBoolean(meta.is_open_access);
  if (isOpenAccess !== null) out.isOpenAccess = isOpenAccess;

  return out;
}

/**
 * `edgar` — allow-list derived from the three insert sites in
 * services/worker/src/jobs/edgarFetcher.ts (all three write the same field
 * names): ~L279-286, ~L578-585, ~L954-961.
 *   entity_name        -> issuerName        (filing entity / company name)
 *   filing_date        -> issuedDate
 *   $sourceId          -> licenseNumber (the row's own source_id column —
 *                         the accession number, this record's OWN primary
 *                         identifier; a CIK is the FILER's id and is shared
 *                         across every filing that company makes, so it
 *                         belongs in extras.ciks, not licenseNumber)
 *   form_type          -> fieldOfStudy
 *   ciks               -> extras.ciks
 *   period_of_report   -> extras.periodOfReport
 *   tickers            -> extras.tickers
 *   primary_document   -> extras.primaryDocument   (only the ~L584 variant)
 *   file_description / primary_doc_description -> extras.fileDescription
 * EXCLUDED: display_names — EDGAR full-text-search hits on Form 3/4/5
 * (beneficial-ownership filings) can carry an individual filer's name in
 * this array; `entity_name` already gives a vetted document-level name, so
 * display_names is dropped rather than passed through.
 */
function projectEdgar(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};

  const issuerName = capString(meta.entity_name);
  if (issuerName) out.issuerName = issuerName;

  const issuedDate = capString(meta.filing_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const licenseNumber = capString(record.source_id);
  if (licenseNumber) out.licenseNumber = licenseNumber;

  const fieldOfStudy = capString(meta.form_type);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;

  const ciks = capStringArray(meta.ciks, 20);
  if (ciks.length > 0) out.ciks = ciks;

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
 *   chamber             -> issuerName      (the issuing legislative body —
 *                          rule text explicitly names "chamber" as a valid
 *                          issuerName source, alongside registry/court/agency)
 *   latest_action_date  -> issuedDate
 *   session             -> extras.session
 *   classification      -> extras.classification
 *   subjects            -> extras.subjects
 *   state               -> extras.state
 *   state_name          -> extras.stateName
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

  const issuerName = capString(meta.chamber);
  if (issuerName) out.issuerName = issuerName;

  const issuedDate = capString(meta.latest_action_date);
  if (issuedDate) out.issuedDate = issuedDate;

  const session = capString(meta.session);
  if (session) out.session = session;

  const classification = capStringArray(meta.classification, 20);
  if (classification.length > 0) out.classification = classification;

  const subjects = capStringArray(meta.subjects, 20);
  if (subjects.length > 0) out.subjects = subjects;

  const state = capString(meta.state);
  if (state) out.state = state;

  const stateName = capString(meta.state_name);
  if (stateName) out.stateName = stateName;

  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;

  const latestAction = capString(meta.latest_action);
  if (latestAction) out.latestAction = latestAction;

  return out;
}

/**
 * `npi` — services/worker/src/jobs/npiFetcher.ts ~L198-237. Excludes
 * provider_name AND organization_name (either is the entity's own name,
 * already the anchor filename — for an organization NPI row these are
 * typically identical strings), gender, sole_proprietor, last_updated, all
 * practice_* fields (address/phone), state_licenses (complex, ties to a
 * person), authorized_official (a person's name).
 */
function projectNpi(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.npi_number);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.enumeration_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const fieldOfStudy = capString(meta.primary_specialty);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;
  const primaryTaxonomyCode = capString(meta.primary_taxonomy_code);
  if (primaryTaxonomyCode) out.primaryTaxonomyCode = primaryTaxonomyCode;
  const credential = capString(meta.credential);
  if (credential) out.credential = credential;
  const status = capString(meta.status);
  if (status) out.status = status;
  const enumerationType = capString(meta.enumeration_type);
  if (enumerationType) out.enumerationType = enumerationType;
  const licenseType = capString(meta.license_type);
  if (licenseType) out.licenseType = licenseType;
  return out;
}

/**
 * `finra` — services/worker/src/jobs/finraBrokerCheckFetcher.ts ~L195-213.
 * Excludes full_name/first_name/last_name/middle_name/other_names (the
 * broker's own name), current_location (address-like), current_employments/
 * previous_employments (complex objects), exams (not required).
 */
function projectFinra(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.crd_number);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.industry_start_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const currentFirm = capString(meta.current_firm);
  if (currentFirm) out.currentFirm = currentFirm;
  const currentFirmCrd = capString(meta.current_firm_crd);
  if (currentFirmCrd) out.currentFirmCrd = currentFirmCrd;
  const disclosureCount = capNumber(meta.disclosure_count);
  if (disclosureCount !== null) out.disclosureCount = disclosureCount;
  const registrations = capStringArray(meta.registrations, 10);
  if (registrations.length > 0) out.registrations = registrations;
  const licenseType = capString(meta.license_type);
  if (licenseType) out.licenseType = licenseType;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * `calbar` — services/worker/src/jobs/calbarFetcher.ts ~L135-147. Excludes
 * full_name (the attorney's own name), city (address component —
 * "never even city"), discipline_history (sensitive free text about the
 * person).
 */
function projectCalbar(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.bar_number);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.admission_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const status = capString(meta.status);
  if (status) out.status = status;
  const state = capString(meta.state);
  if (state) out.state = state;
  const advancedSpecializations = capStringArray(meta.advanced_specializations, 10);
  if (advancedSpecializations.length > 0) out.advancedSpecializations = advancedSpecializations;
  const sections = capStringArray(meta.sections, 10);
  if (sections.length > 0) out.sections = sections;
  const licenseType = capString(meta.license_type);
  if (licenseType) out.licenseType = licenseType;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * `dapip` — services/worker/src/jobs/dapipFetcher.ts ~L108-114. Excludes
 * `address` entirely (explicit ban). No `registry` field exists for this
 * source, so issuerName is left unset — `institution_name` is the record's
 * OWN entity name (OUT), never a stand-in for the issuing body.
 */
function projectDapip(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const opeId = capString(meta.ope_id);
  const dapipId = typeof meta.dapip_id === 'number' ? String(meta.dapip_id) : capString(meta.dapip_id);
  const licenseNumber = opeId ?? dapipId;
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const institutionType = capString(meta.institution_type);
  if (institutionType) out.institutionType = institutionType;
  const state = capString(meta.state);
  if (state) out.state = state;
  const activeStatus = capString(meta.active_status);
  if (activeStatus) out.activeStatus = activeStatus;
  return out;
}

/**
 * `acnc` — services/worker/src/jobs/acncFetcher.ts ~L138-155. Excludes
 * charity_legal_name/other_names (entity's own name), `address` + `postcode`
 * (explicit address ban), `website` (not a requested category).
 */
function projectAcnc(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.abn);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.registration_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const charitySize = capString(meta.charity_size);
  if (charitySize) out.charitySize = charitySize;
  const pbi = capBoolean(meta.pbi);
  if (pbi !== null) out.pbi = pbi;
  const country = capString(meta.country);
  if (country) out.country = country;
  const state = capString(meta.state);
  if (state) out.state = state;
  const dateEstablished = capString(meta.date_established);
  if (dateEstablished) out.dateEstablished = dateEstablished;
  const purposes = capStringArray(meta.purposes, 10);
  if (purposes.length > 0) out.purposes = purposes;
  const operatingCountries = capStringArray(meta.operating_countries, 10);
  if (operatingCountries.length > 0) out.operatingCountries = operatingCountries;
  const responsiblePersonsCount = capNumber(meta.responsible_persons);
  if (responsiblePersonsCount !== null) out.responsiblePersonsCount = responsiblePersonsCount;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * `uspto` — services/worker/src/jobs/usptoFetcher.ts ~L270-273. The fetcher
 * stores NO inventor data (verified directly — do not add `authors` here
 * without a real source field to back it). Excludes `abstract` (banned
 * module-wide).
 */
function projectUspto(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.patent_id);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuedDate = capString(meta.patent_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const fieldOfStudy = capString(record.title);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;
  const patentType = capString(meta.patent_type);
  if (patentType) out.patentType = patentType;
  return out;
}

/**
 * `courtlistener` — services/worker/src/jobs/courtlistenerFetcher.ts
 * ~L366-380. Excludes `judges` (explicit "no judge names"), `syllabus`
 * (free-text summary, banned category), `case_name_full` (redundant with
 * `case_name`), `cluster_id` (internal id). `citations` IS present on the
 * fetcher (`cluster.citations.map(formatCitation)`, a string[] of reporter
 * citations like "512 U.S. 100") and is kept — it is not party-name data.
 * `case_name` is the case's own official caption — allowed as "title", the
 * same allowance used for `fieldOfStudy` elsewhere, not a "party names"
 * list.
 */
function projectCourtlistener(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const issuerName = capString(meta.court_name);
  if (issuerName) out.issuerName = issuerName;
  const licenseNumber = typeof meta.docket_id === 'number' ? String(meta.docket_id) : capString(meta.docket_id);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuedDate = capString(meta.date_filed);
  if (issuedDate) out.issuedDate = issuedDate;
  const fieldOfStudy = capString(meta.case_name);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;
  const citations = capStringArray(meta.citations, 10);
  if (citations.length > 0) out.citations = citations;
  const precedentialStatus = capString(meta.precedential_status);
  if (precedentialStatus) out.precedentialStatus = precedentialStatus;
  const citationCount = capNumber(meta.citation_count);
  if (citationCount !== null) out.citationCount = citationCount;
  const natureOfSuit = capString(meta.nature_of_suit);
  if (natureOfSuit) out.natureOfSuit = natureOfSuit;
  const opinionCount = capNumber(meta.opinion_count);
  if (opinionCount !== null) out.opinionCount = opinionCount;
  const courtId = capString(meta.court_id);
  if (courtId) out.courtId = courtId;
  const dateFiledIsApproximate = capBoolean(meta.date_filed_is_approximate);
  if (dateFiledIsApproximate !== null) out.dateFiledIsApproximate = dateFiledIsApproximate;
  return out;
}

/**
 * `edgar_form_adv` — services/worker/src/jobs/edgarFormAdvFetcher.ts
 * ~L101-112. `sec_adv_bulk` is registered as an alias below (same fetcher
 * shape under a legacy/bulk-import source label — no separate fetcher
 * writes it today). Excludes organization_name (entity's own name), `city`
 * (address component).
 */
function projectEdgarFormAdv(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.crd_number);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.last_filing_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const secNumber = capString(meta.sec_number);
  if (secNumber) out.secNumber = secNumber;
  const state = capString(meta.state);
  if (state) out.state = state;
  const country = capString(meta.country);
  if (country) out.country = country;
  const registrationStatus = capString(meta.registration_status);
  if (registrationStatus) out.registrationStatus = registrationStatus;
  const licenseType = capString(meta.license_type);
  if (licenseType) out.licenseType = licenseType;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * `sec_iapd` — services/worker/src/jobs/secIapdFetcher.ts ~L138-160.
 * Registry-level firm data only — no address/person fields present in this
 * fetcher's metadata block to begin with. No date field exists, so
 * issuedDate is left unset.
 */
function projectSecIapd(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.crd_number);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const registrationStatus = capString(meta.registration_status);
  if (registrationStatus) out.registrationStatus = registrationStatus;
  const totalAssets = capNumber(meta.total_assets);
  if (totalAssets !== null) out.totalAssets = totalAssets;
  const numberOfAccounts = capNumber(meta.number_of_accounts);
  if (numberOfAccounts !== null) out.numberOfAccounts = numberOfAccounts;
  const licenseType = capString(meta.license_type);
  if (licenseType) out.licenseType = licenseType;
  const secNumber = capString(meta.sec_number);
  if (secNumber) out.secNumber = secNumber;
  const country = capString(meta.country);
  if (country) out.country = country;
  const state = capString(meta.state);
  if (state) out.state = state;
  const disclosureCount = capNumber(meta.disclosure_count);
  if (disclosureCount !== null) out.disclosureCount = disclosureCount;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  const jurisdictions = capStringArray(meta.jurisdictions, 20);
  if (jurisdictions.length > 0) out.jurisdictions = jurisdictions;
  return out;
}

/**
 * `acra_sg` — services/worker/src/jobs/singaporeFetcher.ts ~L107-119.
 * Excludes entity_name (entity's own name).
 */
function projectAcraSg(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.uen);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.registration_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const entityType = capString(meta.entity_type);
  if (entityType) out.entityType = entityType;
  const uenStatus = capString(meta.uen_status);
  if (uenStatus) out.uenStatus = uenStatus;
  const primarySsicCode = capString(meta.primary_ssic_code);
  if (primarySsicCode) out.primarySsicCode = primarySsicCode;
  const primarySsicDescription = capString(meta.primary_ssic_description);
  if (primarySsicDescription) out.primarySsicDescription = primarySsicDescription;
  const secondarySsicCode = capString(meta.secondary_ssic_code);
  if (secondarySsicCode) out.secondarySsicCode = secondarySsicCode;
  const secondarySsicDescription = capString(meta.secondary_ssic_description);
  if (secondarySsicDescription) out.secondarySsicDescription = secondarySsicDescription;
  const companyType = capString(meta.company_type);
  if (companyType) out.companyType = companyType;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * `cnpj_br` — services/worker/src/jobs/brazilFetcher.ts ~L187-204. Excludes
 * razao_social/nome_fantasia (entity's own names), `address`/`municipio`/
 * `cep` (address components, explicit ban), `capital_social` (financial
 * data, not a requested category).
 */
function projectCnpjBr(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.cnpj_formatted) ?? capString(meta.cnpj);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.data_inicio_atividade);
  if (issuedDate) out.issuedDate = issuedDate;
  const status = capString(meta.situacao_cadastral);
  if (status) out.status = status;
  const naturezaJuridica = capString(meta.natureza_juridica);
  if (naturezaJuridica) out.naturezaJuridica = naturezaJuridica;
  const porte = capString(meta.porte);
  if (porte) out.porte = porte;
  const uf = capString(meta.uf);
  if (uf) out.uf = uf;
  const cnaeFiscal = capString(meta.cnae_fiscal);
  if (cnaeFiscal) out.cnaeFiscal = cnaeFiscal;
  const cnaeDescricao = capString(meta.cnae_descricao);
  if (cnaeDescricao) out.cnaeDescricao = cnaeDescricao;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

/**
 * Statute records — services/worker/src/jobs/jurisdictionFetcher.ts
 * ~L74-82 (shared by australiaLawFetcher.ts's `statuteSource: 'australia_law'`
 * and kenyaLawFetcher.ts's `statuteSource: 'kenya_law'`). Pure statute-text
 * references — no person/entity data of any kind is stored here.
 */
function projectJurisdictionStatute(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.section_id);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.jurisdiction);
  if (issuerName) out.issuerName = issuerName;
  const fieldOfStudy = capString(meta.section_title);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;
  const statuteName = capString(meta.statute_name);
  if (statuteName) out.statuteName = statuteName;
  const part = capString(meta.part);
  if (part) out.part = part;
  const jurisdictionCode = capString(meta.jurisdiction_code);
  if (jurisdictionCode) out.jurisdictionCode = jurisdictionCode;
  return out;
}

/**
 * Case-law records — services/worker/src/jobs/jurisdictionFetcher.ts
 * ~L145-151 (shared by `australia_caselaw` and `kenya_caselaw`, a DIFFERENT
 * source + shape from the statute path above — confirmed by reading
 * australiaLawFetcher.ts's `caseLaw: { source: 'australia_caselaw', ... }`
 * alongside its separate `statuteSource: 'australia_law'`). No docket/case
 * number field exists in this metadata shape, so `licenseNumber` is left
 * unset. `case_title` is the case's own official caption ("title"
 * category), not a party-names list. Excludes `summary` (banned
 * module-wide) and `search_term` is safe (the fetcher's own query term, not
 * user or case-party data) but omitted here as low-value; jurisdictionCode
 * is kept.
 */
function projectJurisdictionCaseLaw(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const issuerName = capString(meta.court);
  if (issuerName) out.issuerName = issuerName;
  // No docket/case number in metadata — the record's OWN identifier is the
  // pipeline source_id column (a synthetic id the case-law scraper builds).
  const licenseNumber = capString(record.source_id);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const fieldOfStudy = capString(meta.case_title);
  if (fieldOfStudy) out.fieldOfStudy = fieldOfStudy;
  const jurisdictionCode = capString(meta.jurisdiction_code);
  if (jurisdictionCode) out.jurisdictionCode = jurisdictionCode;
  return out;
}

/**
 * `moh_sg` — services/worker/src/jobs/singaporeHealthFetcher.ts
 * ~L108-120. Excludes hci_name (entity's own name), `premises_address` +
 * `postal_code` (explicit address ban), `licensee_name` (may be an
 * individual responsible person, not the institution itself — treated like
 * npi's `authorized_official`).
 */
function projectMohSg(record: ProjectablePublicRecord): ProjectedTemplate {
  const meta = record.metadata;
  const out: ProjectedTemplate = {};
  const licenseNumber = capString(meta.licence_no);
  if (licenseNumber) out.licenseNumber = licenseNumber;
  const issuerName = capString(meta.registry);
  if (issuerName) out.issuerName = issuerName;
  const issuedDate = capString(meta.effective_date);
  if (issuedDate) out.issuedDate = issuedDate;
  const licenceType = capString(meta.licence_type);
  if (licenceType) out.licenceType = licenceType;
  const licenceStatus = capString(meta.licence_status);
  if (licenceStatus) out.licenceStatus = licenceStatus;
  const expiryDate = capString(meta.expiry_date);
  if (expiryDate) out.expiryDate = expiryDate;
  const hciCode = capString(meta.hci_code);
  if (hciCode) out.hciCode = hciCode;
  const jurisdiction = capString(meta.jurisdiction);
  if (jurisdiction) out.jurisdiction = jurisdiction;
  return out;
}

const PROJECTORS: Record<string, (record: ProjectablePublicRecord) => ProjectedTemplate> = {
  openalex: projectOpenAlex,
  edgar: projectEdgar,
  federal_register: projectFederalRegister,
  openstates: projectOpenStates,
  npi: projectNpi,
  finra: projectFinra,
  calbar: projectCalbar,
  dapip: projectDapip,
  acnc: projectAcnc,
  uspto: projectUspto,
  courtlistener: projectCourtlistener,
  edgar_form_adv: projectEdgarFormAdv,
  sec_adv_bulk: projectEdgarFormAdv,
  sec_iapd: projectSecIapd,
  acra_sg: projectAcraSg,
  cnpj_br: projectCnpjBr,
  australia_law: projectJurisdictionStatute,
  kenya_law: projectJurisdictionStatute,
  australia_caselaw: projectJurisdictionCaseLaw,
  kenya_caselaw: projectJurisdictionCaseLaw,
  moh_sg: projectMohSg,
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
