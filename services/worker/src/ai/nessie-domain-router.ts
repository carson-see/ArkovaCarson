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
};

/**
 * Route a query to the appropriate domain adapter.
 *
 * Two-pass classifier:
 * 1. Exact credential type match (fast path)
 * 2. Keyword scoring from query text (fallback)
 */
export function routeToDomain(
  credentialType?: string,
  queryText?: string,
): DomainAdapter {
  // Pass 1: Credential type match
  if (credentialType) {
    const ct = credentialType.toUpperCase();
    if (ct === 'SEC_FILING') return ROUTER_CONFIG.adapters.sec ?? getDefault();
    if (ct === 'LEGAL') return ROUTER_CONFIG.adapters.legal ?? getDefault();
    if (ct === 'REGULATION' || ct === 'CERTIFICATE') return ROUTER_CONFIG.adapters.regulatory ?? getDefault();
    if (ct === 'PUBLICATION' || ct === 'PROFESSIONAL') return ROUTER_CONFIG.adapters.academic ?? getDefault();
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

    if (bestScore > 0 && ROUTER_CONFIG.adapters[bestDomain]) {
      return ROUTER_CONFIG.adapters[bestDomain];
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

export { ROUTER_CONFIG };
