/**
 * AI-001: iXBRL Parser Tests
 *
 * Tests for parsing inline XBRL financial data from SEC filings.
 */

import { describe, it, expect } from 'vitest';
import { parseIXBRL, parseXBRLNumber, hasIXBRL } from '../ixbrlParser.js';

const SAMPLE_IXBRL = `
<!DOCTYPE html>
<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:us-gaap="http://fasb.org/us-gaap/2023"
      xmlns:dei="http://xbrl.sec.gov/dei/2023">
<head><title>10-K Filing</title></head>
<body>
  <ix:nonNumeric name="dei:EntityRegistrantName" contextRef="c-1">Acme Corporation</ix:nonNumeric>
  <ix:nonNumeric name="dei:EntityCentralIndexKey" contextRef="c-1">0001234567</ix:nonNumeric>
  <ix:nonNumeric name="dei:DocumentPeriodEndDate" contextRef="c-1">2025-12-31</ix:nonNumeric>

  <p>Total revenue was
    <ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"
                    contextRef="c-annual" unitRef="usd" decimals="-6"
                    >42,500</ix:nonFraction> million.
  </p>

  <p>Net income was
    <ix:nonFraction name="us-gaap:NetIncomeLoss"
                    contextRef="c-annual" unitRef="usd" decimals="-6"
                    >8,200</ix:nonFraction> million.
  </p>

  <p>Total assets:
    <ix:nonFraction name="us-gaap:Assets"
                    contextRef="c-balance" unitRef="usd" decimals="-6"
                    >150,000</ix:nonFraction>
  </p>

  <p>Total liabilities:
    <ix:nonFraction name="us-gaap:Liabilities"
                    contextRef="c-balance" unitRef="usd" decimals="-6"
                    >75,000</ix:nonFraction>
  </p>

  <p>EPS basic:
    <ix:nonFraction name="us-gaap:EarningsPerShareBasic"
                    contextRef="c-annual" unitRef="usdPerShare" decimals="2"
                    >3.45</ix:nonFraction>
  </p>

  <p>EPS diluted:
    <ix:nonFraction name="us-gaap:EarningsPerShareDiluted"
                    contextRef="c-annual" unitRef="usdPerShare" decimals="2"
                    >3.42</ix:nonFraction>
  </p>

  <p>Shares outstanding:
    <ix:nonFraction name="us-gaap:CommonStockSharesOutstanding"
                    contextRef="c-balance" unitRef="shares" decimals="-3"
                    >2,380</ix:nonFraction>
  </p>
</body>
</html>
`;

describe('AI-001: parseIXBRL', () => {
  it('extracts entity metadata', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result).not.toBeNull();
    expect(result!.entityName).toBe('Acme Corporation');
    expect(result!.cik).toBe('0001234567');
    expect(result!.period).toBe('2025-12-31');
  });

  it('extracts revenue (with decimals scaling)', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result).not.toBeNull();
    // 42,500 with decimals="-6" → 42,500,000,000
    expect(result!.revenue).toBe(42_500_000_000);
  });

  it('extracts net income', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result!.netIncome).toBe(8_200_000_000);
  });

  it('extracts total assets and liabilities', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result!.totalAssets).toBe(150_000_000_000);
    expect(result!.totalLiabilities).toBe(75_000_000_000);
  });

  it('extracts EPS values', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result!.earningsPerShareBasic).toBe(3.45);
    expect(result!.earningsPerShareDiluted).toBe(3.42);
  });

  it('extracts shares outstanding', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    // 2,380 with decimals="-3" → 2,380,000
    expect(result!.sharesOutstanding).toBe(2_380_000);
  });

  it('counts total facts', () => {
    const result = parseIXBRL(SAMPLE_IXBRL);
    expect(result!.factCount).toBeGreaterThanOrEqual(7);
  });

  it('returns null for empty input', () => {
    expect(parseIXBRL('')).toBeNull();
    expect(parseIXBRL(null as unknown as string)).toBeNull();
  });

  it('returns null for non-XBRL HTML', () => {
    const plainHtml = '<html><body><p>Hello world</p></body></html>';
    expect(parseIXBRL(plainHtml)).toBeNull();
  });

  it('handles negative values with sign attribute', () => {
    const html = `
    <html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:us-gaap="http://fasb.org/us-gaap/2023">
    <body>
      <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="c-1" unitRef="usd" sign="-">500</ix:nonFraction>
    </body></html>`;
    const result = parseIXBRL(html);
    expect(result).not.toBeNull();
    expect(result!.netIncome).toBe(-500);
  });

  it('handles parenthesized negative values', () => {
    const html = `
    <html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:us-gaap="http://fasb.org/us-gaap/2023">
    <body>
      <ix:nonFraction name="us-gaap:NetIncomeLoss" contextRef="c-1" unitRef="usd">(1,200)</ix:nonFraction>
    </body></html>`;
    const result = parseIXBRL(html);
    expect(result).not.toBeNull();
    expect(result!.netIncome).toBe(-1200);
  });
});

describe('AI-001: parseXBRLNumber', () => {
  it('parses plain numbers', () => {
    expect(parseXBRLNumber('42500')).toBe(42500);
  });

  it('strips commas', () => {
    expect(parseXBRLNumber('42,500')).toBe(42500);
  });

  it('strips dollar signs', () => {
    expect(parseXBRLNumber('$42,500')).toBe(42500);
  });

  it('handles negative sign attribute', () => {
    expect(parseXBRLNumber('500', '-')).toBe(-500);
  });

  it('handles parenthesized negatives', () => {
    expect(parseXBRLNumber('(1,200)')).toBe(-1200);
  });

  it('applies decimals scaling for millions', () => {
    expect(parseXBRLNumber('42500', null, '-6')).toBe(42_500_000_000);
  });

  it('applies decimals scaling for thousands', () => {
    expect(parseXBRLNumber('2380', null, '-3')).toBe(2_380_000);
  });

  it('does not scale for positive decimals', () => {
    expect(parseXBRLNumber('3.45', null, '2')).toBe(3.45);
  });

  it('returns null for non-numeric input', () => {
    expect(parseXBRLNumber('hello')).toBeNull();
    expect(parseXBRLNumber('')).toBeNull();
  });
});

describe('AI-001: hasIXBRL', () => {
  it('detects ix:nonFraction tags', () => {
    expect(hasIXBRL('<ix:nonFraction name="foo">42</ix:nonFraction>')).toBe(true);
  });

  it('detects xmlns:ix namespace', () => {
    expect(hasIXBRL('<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">')).toBe(true);
  });

  it('returns false for plain HTML', () => {
    expect(hasIXBRL('<html><body>Hello</body></html>')).toBe(false);
  });

  it('returns false for empty/null', () => {
    expect(hasIXBRL('')).toBe(false);
    expect(hasIXBRL(null as unknown as string)).toBe(false);
  });
});
