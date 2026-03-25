/**
 * iXBRL Parser for SEC Filings (AI-001)
 *
 * Extracts structured financial data from inline XBRL (iXBRL) filings.
 * Most 10-K/Q filings since ~2020 use iXBRL — structured data already
 * tagged in the HTML. Parsing iXBRL first extracts structured data
 * directly, falling back to AI extraction only for narrative sections.
 *
 * Key XBRL taxonomy concepts mapped:
 *   - us-gaap:Revenues / us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax
 *   - us-gaap:NetIncomeLoss
 *   - us-gaap:Assets
 *   - us-gaap:Liabilities
 *   - us-gaap:EarningsPerShareBasic / us-gaap:EarningsPerShareDiluted
 *   - us-gaap:CommonStockSharesOutstanding
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import * as cheerio from 'cheerio';

/** Extracted financial data from an iXBRL filing */
export interface IXBRLFinancialData {
  revenue?: number;
  netIncome?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  earningsPerShareBasic?: number;
  earningsPerShareDiluted?: number;
  sharesOutstanding?: number;
  /** Additional extracted facts keyed by XBRL concept name */
  additionalFacts: Record<string, string | number>;
  /** Period context (e.g. "2025-01-01 to 2025-12-31") */
  period?: string;
  /** Entity name from filing */
  entityName?: string;
  /** CIK number */
  cik?: string;
  /** Count of XBRL facts found */
  factCount: number;
}

/** Maps XBRL concept names to our normalized field names */
const CONCEPT_MAP: Record<string, keyof Omit<IXBRLFinancialData, 'additionalFacts' | 'period' | 'entityName' | 'cik' | 'factCount'>> = {
  'us-gaap:Revenues': 'revenue',
  'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax': 'revenue',
  'us-gaap:SalesRevenueNet': 'revenue',
  'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax': 'revenue',
  'us-gaap:NetIncomeLoss': 'netIncome',
  'us-gaap:ProfitLoss': 'netIncome',
  'us-gaap:Assets': 'totalAssets',
  'us-gaap:Liabilities': 'totalLiabilities',
  'us-gaap:LiabilitiesAndStockholdersEquity': 'totalLiabilities',
  'us-gaap:EarningsPerShareBasic': 'earningsPerShareBasic',
  'us-gaap:EarningsPerShareDiluted': 'earningsPerShareDiluted',
  'us-gaap:CommonStockSharesOutstanding': 'sharesOutstanding',
  'us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted': 'sharesOutstanding',
};

/** Entity-level concepts */
const ENTITY_CONCEPTS = new Set([
  'dei:EntityRegistrantName',
  'dei:EntityCentralIndexKey',
  'dei:DocumentPeriodEndDate',
  'dei:CurrentFiscalYearEndDate',
]);

/**
 * Parse an iXBRL HTML document and extract structured financial data.
 *
 * @param html - The raw HTML content of an iXBRL filing
 * @returns Extracted financial data, or null if no XBRL tags found
 */
export function parseIXBRL(html: string): IXBRLFinancialData | null {
  if (!html || typeof html !== 'string') return null;

  const $ = cheerio.load(html, { xml: false });

  const result: IXBRLFinancialData = {
    additionalFacts: {},
    factCount: 0,
  };

  // Find all iXBRL tagged elements (ix:nonFraction for numeric, ix:nonNumeric for text)
  const ixElements = $('[name]').filter((_i, el) => {
    const name = $(el).attr('name') ?? '';
    return name.includes(':');
  });

  // Also look for ix:nonFraction and ix:nonNumeric elements directly
  const nonFractionElements = $('ix\\:nonfraction, ix\\:nonFraction, nonfraction');
  const nonNumericElements = $('ix\\:nonnumeric, ix\\:nonNumeric, nonnumeric');

  // Process numeric facts (ix:nonFraction)
  nonFractionElements.each((_i, el) => {
    const $el = $(el);
    const name = $el.attr('name') ?? '';
    const rawValue = $el.text().trim();
    const sign = $el.attr('sign');
    const decimals = $el.attr('decimals');
    const contextRef = $el.attr('contextref') ?? $el.attr('contextRef') ?? '';

    if (!name || !rawValue) return;

    const numValue = parseXBRLNumber(rawValue, sign, decimals);
    if (numValue === null) return;

    result.factCount++;

    // Map to known fields
    const fieldName = CONCEPT_MAP[name];
    if (fieldName) {
      // Prefer values with longer context refs (usually the annual period)
      if (result[fieldName] === undefined || contextRef.length > 10) {
        (result as Record<string, unknown>)[fieldName] = numValue;
      }
    } else if (name.startsWith('us-gaap:') || name.startsWith('dei:')) {
      result.additionalFacts[name] = numValue;
    }
  });

  // Process text facts (ix:nonNumeric)
  nonNumericElements.each((_i, el) => {
    const $el = $(el);
    const name = $el.attr('name') ?? '';
    const value = $el.text().trim();

    if (!name || !value) return;

    result.factCount++;

    if (name === 'dei:EntityRegistrantName') {
      result.entityName = value;
    } else if (name === 'dei:EntityCentralIndexKey') {
      result.cik = value;
    } else if (name === 'dei:DocumentPeriodEndDate') {
      result.period = value;
    } else if (ENTITY_CONCEPTS.has(name)) {
      result.additionalFacts[name] = value;
    }
  });

  // Also scan for name attributes on any element (some filings use non-standard tags)
  ixElements.each((_i, el) => {
    const $el = $(el);
    const name = $el.attr('name') ?? '';
    const value = $el.text().trim();

    if (!name || !value) return;

    // Skip if we already processed this element
    const tagName = (el as cheerio.Element).tagName?.toLowerCase() ?? '';
    if (tagName.includes('nonfraction') || tagName.includes('nonnumeric')) return;

    const fieldName = CONCEPT_MAP[name];
    if (fieldName && result[fieldName] === undefined) {
      const numValue = parseXBRLNumber(value);
      if (numValue !== null) {
        (result as Record<string, unknown>)[fieldName] = numValue;
        result.factCount++;
      }
    }
  });

  // If no facts found, this likely isn't an iXBRL document
  if (result.factCount === 0) {
    return null;
  }

  return result;
}

/**
 * Parse an XBRL numeric value, handling formatting and sign.
 *
 * XBRL numeric values may have:
 * - Commas as thousands separators
 * - Parentheses for negative values
 * - A sign attribute ("-" means negate)
 * - A decimals attribute (e.g. "-6" means value is in millions)
 */
export function parseXBRLNumber(
  raw: string,
  sign?: string | null,
  decimals?: string | null,
): number | null {
  if (!raw) return null;

  // Remove whitespace, commas, dollar signs, and other formatting
  let cleaned = raw.replace(/[\s,$%]/g, '');

  // Handle parentheses (accounting notation for negatives)
  const isParenNegative = /^\(.*\)$/.test(cleaned);
  if (isParenNegative) {
    cleaned = cleaned.replace(/[()]/g, '');
  }

  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;

  let result = num;

  // Apply sign attribute
  if (sign === '-' || isParenNegative) {
    result = -Math.abs(result);
  }

  // Apply scale from decimals attribute
  // decimals="-6" means the value is in millions (multiply by 10^6)
  // decimals="-3" means thousands, decimals="2" means cents
  if (decimals && decimals !== 'INF') {
    const dec = parseInt(decimals, 10);
    if (!isNaN(dec) && dec < 0) {
      result = result * Math.pow(10, -dec);
    }
  }

  return result;
}

/**
 * Check if an HTML document contains iXBRL tags.
 * Quick check without full parsing.
 */
export function hasIXBRL(html: string): boolean {
  if (!html) return false;
  return (
    html.includes('ix:nonFraction') ||
    html.includes('ix:nonfraction') ||
    html.includes('ix:nonNumeric') ||
    html.includes('ix:nonnumeric') ||
    html.includes('xmlns:ix=')
  );
}
