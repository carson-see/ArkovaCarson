/**
 * Nessie Multi-LoRA Domain Router
 *
 * Routes queries to the appropriate domain-specific LoRA adapter
 * based on credential type and content keywords.
 *
 * Strategy: classifier-based routing now, upgrade to MoLoRA per-token
 * routing when adapter count exceeds 5 domains.
 *
 * Adapters trained on Together AI (2026-03-29):
 *   SEC:        45,000 examples (ft-4df03467-7107)
 *   Academic:   45,000 examples (ft-a3f1e983-884e)
 *   Legal:      12,956 examples (ft-aebfcda2-fd12)
 *   Regulatory: 13,337 examples (ft-ffbc98fd-ef9c)
 */

export interface DomainAdapter {
  domain: string;
  label: string;
  modelId: string;
}

export interface RouterConfig {
  adapters: Record<string, DomainAdapter>;
  defaultAdapter: string;
}

/**
 * Enable/disable domain routing via env var.
 * When disabled, falls back to monolithic model (NESSIE_MODEL env var).
 */
export function isDomainRoutingEnabled(): boolean {
  return process.env.NESSIE_DOMAIN_ROUTING === 'true';
}

const ROUTER_CONFIG: RouterConfig = {
  defaultAdapter: 'academic',
  adapters: {
    sec: {
      domain: 'sec',
      label: 'SEC & Financial Compliance',
      modelId: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-sec-7c4962d4',
    },
    academic: {
      domain: 'academic',
      label: 'Academic & Research Publications',
      modelId: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-academic-d3af8711',
    },
    legal: {
      domain: 'legal',
      label: 'Legal & Case Law',
      modelId: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-legal-56793fc2',
    },
    regulatory: {
      domain: 'regulatory',
      label: 'Regulatory & Government',
      modelId: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-regulatory-2ed0f4d7',
    },
    // NMT-16: New domain groups (model IDs populated after training)
    professional: {
      domain: 'professional',
      label: 'Professional Licenses & Certifications',
      modelId: 'placeholder-professional', // Populated after NMT-16 training
    },
    identity: {
      domain: 'identity',
      label: 'Identity Documents & Military Records',
      modelId: 'placeholder-identity', // Populated after NMT-16 training
    },
  },
};

/** Keyword sets for classifier-based routing */
const DOMAIN_KEYWORDS: Record<string, Set<string>> = {
  sec: new Set([
    'sec', 'securities', 'exchange', 'cik', '10-k', '10-q', '8-k',
    's-1', 'def 14a', 'filing', 'edgar', 'sarbanes', 'sox',
  ]),
  legal: new Set([
    'court', 'case law', 'opinion', 'docket', 'plaintiff', 'defendant',
    'habeas', 'scotus', 'circuit', 'appellate', 'litigation',
  ]),
  regulatory: new Set([
    'regulation', 'federal register', 'cfr', 'rulemaking', 'agency',
    'notice', 'proposed rule', 'compliance', 'acnc', 'charity',
  ]),
  academic: new Set([
    'publication', 'journal', 'research', 'doi', 'orcid',
    'accreditation', 'degree', 'university', 'patent', 'grant',
  ]),
  // NMT-16: New domain keyword sets
  professional: new Set([
    'license', 'certification', 'cle', 'continuing education',
    'board certified', 'practice', 'professional', 'certificate',
    'pmp', 'cpa', 'pe ', 'badge', 'credential',
  ]),
  identity: new Set([
    'passport', 'driver', 'national id', 'military', 'dd-214',
    'service record', 'veteran', 'visa', 'immigration',
    'birth certificate', 'social security', 'resume', 'cv',
  ]),
};

/** Credential type → domain mapping. Typed Sets replace the if-chain. */
const SEC_TYPES = new Set(['SEC_FILING', 'FINANCIAL', 'INSURANCE']);
const LEGAL_TYPES = new Set(['LEGAL']);
const REGULATORY_TYPES = new Set(['REGULATION', 'CHARITY']);
const ACADEMIC_TYPES = new Set(['PUBLICATION', 'DEGREE', 'TRANSCRIPT', 'ACCREDITATION', 'PATENT']);
const PROFESSIONAL_TYPES = new Set(['LICENSE', 'CERTIFICATE', 'CLE', 'BADGE', 'PROFESSIONAL', 'ATTESTATION']);
const IDENTITY_TYPES = new Set(['IDENTITY', 'MILITARY', 'RESUME', 'MEDICAL']);

const TYPE_TO_DOMAIN: Array<[Set<string>, string]> = [
  [SEC_TYPES, 'sec'],
  [LEGAL_TYPES, 'legal'],
  [REGULATORY_TYPES, 'regulatory'],
  [ACADEMIC_TYPES, 'academic'],
  [PROFESSIONAL_TYPES, 'professional'],
  [IDENTITY_TYPES, 'identity'],
];

/**
 * Resolve adapter, falling back to default if the matched adapter is untrained.
 */
function resolveAdapter(domain: string): DomainAdapter {
  const adapter = ROUTER_CONFIG.adapters[domain];
  if (adapter && isAdapterTrained(adapter)) return adapter;
  return getDefault();
}

/**
 * Route a query to the appropriate domain adapter.
 *
 * Two-pass classifier:
 * 1. Credential type → domain Set lookup (fast path)
 * 2. Keyword scoring from query text (fallback)
 *
 * Falls back to default adapter if the matched adapter is untrained (placeholder).
 */
export function routeToDomain(
  credentialType?: string,
  queryText?: string,
): DomainAdapter {
  // Pass 1: Credential type lookup
  if (credentialType) {
    const ct = credentialType.toUpperCase();
    for (const [typeSet, domain] of TYPE_TO_DOMAIN) {
      if (typeSet.has(ct)) return resolveAdapter(domain);
    }
  }

  // Pass 2: Keyword scoring
  if (queryText) {
    const lower = queryText.toLowerCase();
    let bestDomain = ROUTER_CONFIG.defaultAdapter;
    let bestScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }

    if (bestScore > 0) {
      return resolveAdapter(bestDomain);
    }
  }

  return getDefault();
}

function getDefault(): DomainAdapter {
  return ROUTER_CONFIG.adapters[ROUTER_CONFIG.defaultAdapter] ?? {
    domain: 'base',
    label: 'Base Model',
    modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
  };
}

/**
 * Jurisdiction-specific LoRA adapters (NCE-14)
 *
 * Trained on jurisdiction-specific compliance Q&A.
 * When a jurisdiction is specified, these take precedence over domain routing.
 * Adapter IDs will be populated after Together AI fine-tuning.
 */
interface JurisdictionAdapter extends DomainAdapter {
  available: boolean;
}

/** Jurisdiction adapters — available=false until trained on Together AI */
const JURISDICTION_ADAPTERS: Record<string, JurisdictionAdapter> = {
  'US-CA': { domain: 'jurisdiction-ca', label: 'California Compliance', modelId: 'placeholder', available: false },
  'US-NY': { domain: 'jurisdiction-ny', label: 'New York Compliance', modelId: 'placeholder', available: false },
  'US-FED': { domain: 'jurisdiction-fed', label: 'Federal Compliance (SEC/IRS)', modelId: 'placeholder', available: false },
};

/**
 * Route with jurisdiction preference (NCE-14).
 *
 * If a jurisdiction adapter is available and has a model ID,
 * prefer it. Otherwise fall back to standard domain routing.
 */
export function routeWithJurisdiction(
  jurisdiction?: string,
  credentialType?: string,
  queryText?: string,
): DomainAdapter {
  // Jurisdiction adapter takes priority when available
  if (jurisdiction && JURISDICTION_ADAPTERS[jurisdiction]) {
    const adapter = JURISDICTION_ADAPTERS[jurisdiction];
    if (adapter.available) {
      return adapter;
    }
  }

  // Fall back to standard domain routing
  return routeToDomain(credentialType, queryText);
}

/**
 * Check if a domain adapter has been trained (not a placeholder).
 * NMT-16: Professional and Identity adapters are placeholders until trained.
 */
export function isAdapterTrained(adapter: DomainAdapter): boolean {
  return !adapter.modelId.startsWith('placeholder');
}

/**
 * Get all trained (non-placeholder) domain adapters.
 */
export function getTrainedAdapters(): DomainAdapter[] {
  return Object.values(ROUTER_CONFIG.adapters).filter(isAdapterTrained);
}

export {
  ROUTER_CONFIG, JURISDICTION_ADAPTERS,
  SEC_TYPES, LEGAL_TYPES, REGULATORY_TYPES, ACADEMIC_TYPES, PROFESSIONAL_TYPES, IDENTITY_TYPES,
};
