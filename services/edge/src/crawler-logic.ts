/**
 * Cloudflare Crawler Logic — University Directory Ingestion (P8-S7)
 *
 * Parses university web pages to extract institution data for the
 * institution_ground_truth pgvector table. Used for credential verification
 * and fraud detection (issuer validation).
 *
 * Constitution 1.6: No document bytes processed. Only public web content.
 * Constitution 1.4: No PII extracted or stored.
 */

export interface CrawlResult {
  institutionName: string;
  domain: string;
  metadata: Record<string, string>;
}

export interface GroundTruthRecord {
  institution_name: string;
  domain: string;
  metadata: Record<string, string>;
  embedding: string; // pgvector format: [0.1,0.2,...]
  source: string;
  confidence_score: number;
}

// Common institution keywords for identification
const INSTITUTION_KEYWORDS = [
  'university', 'college', 'institute', 'school',
  'academy', 'polytechnic', 'conservatory',
];

// Accreditation bodies (US)
const ACCREDITATION_BODIES = [
  'Higher Learning Commission', 'HLC',
  'Middle States Commission', 'MSCHE',
  'New England Commission', 'NECHE',
  'Northwest Commission', 'NWCCU',
  'Southern Association', 'SACSCOC',
  'Western Association', 'WASC', 'WSCUC',
];

/**
 * Parse an HTML page to extract institution information.
 *
 * Returns null if the page doesn't appear to be a legitimate institution.
 */
export function parseInstitutionPage(html: string, domain: string): CrawlResult | null {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch?.[1]?.trim() ?? '';

  // Extract h1 heading
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
  // Strip HTML tags iteratively to handle nested/malformed markup (CodeQL js/incomplete-multi-character-sanitization)
  let h1Raw = h1Match?.[1] ?? '';
  let prev = '';
  while (prev !== h1Raw) { prev = h1Raw; h1Raw = h1Raw.replace(/<[^>]+>/g, ''); }
  const h1 = h1Raw.trim();

  // Determine institution name (prefer h1, fall back to title)
  const institutionName = h1 || title.split('|')[0]?.trim() || '';

  if (!institutionName) return null;

  // Verify this looks like a real institution
  const lowerName = institutionName.toLowerCase();
  const lowerHtml = html.toLowerCase();
  const isInstitution = INSTITUTION_KEYWORDS.some((kw) => lowerName.includes(kw))
    || INSTITUTION_KEYWORDS.some((kw) => lowerHtml.includes(kw));

  if (!isInstitution) return null;

  // Extract metadata
  const metadata: Record<string, string> = {};

  // Accreditation
  for (const body of ACCREDITATION_BODIES) {
    if (html.includes(body)) {
      metadata.accreditation = body;
      break;
    }
  }

  // Location patterns
  const locationMatch = html.match(/(?:Location|Located|Address)[:\s]*([^<\n]{5,60})/i);
  if (locationMatch) {
    metadata.location = locationMatch[1].trim();
  }

  // Founded year
  const foundedMatch = html.match(/(?:Founded|Established)[:\s]*(?:in\s+)?(\d{4})/i);
  if (foundedMatch) {
    metadata.founded = foundedMatch[1];
  }

  // Institution type
  const typeMatch = html.match(/(?:Type|Classification)[:\s]*((?:Public|Private)[\w\s]{0,30}(?:University|College|Institute))/i);
  if (typeMatch) {
    metadata.type = typeMatch[1].trim();
  }

  return { institutionName, domain, metadata };
}

/**
 * Build a record for insertion into institution_ground_truth table.
 *
 * @param crawlResult - Parsed institution data
 * @param embedding - 768-dimensional vector from AI provider
 */
export function buildGroundTruthRecord(
  crawlResult: CrawlResult,
  embedding: number[],
): GroundTruthRecord {
  // Compute confidence based on metadata richness
  let confidence = 0.5; // base: we found an institution page
  if (crawlResult.metadata.accreditation) confidence += 0.2;
  if (crawlResult.metadata.location) confidence += 0.1;
  if (crawlResult.metadata.founded) confidence += 0.1;
  if (crawlResult.metadata.type) confidence += 0.1;
  confidence = Math.min(confidence, 1.0);

  return {
    institution_name: crawlResult.institutionName,
    domain: crawlResult.domain,
    metadata: crawlResult.metadata,
    embedding: `[${embedding.join(',')}]`,
    source: 'cloudflare_crawl',
    confidence_score: Number(confidence.toFixed(2)),
  };
}
