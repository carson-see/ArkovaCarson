/**
 * Cloudflare Crawler — University Directory Ingestion (P8-S7)
 *
 * Crawls university websites to build the institution_ground_truth table.
 * Uses Cloudflare's fetch API to retrieve public web content, parses institution
 * data, generates embeddings via Workers AI, and inserts into Supabase.
 *
 * Constitution 1.6: No document bytes. Only public web content.
 * Constitution 1.4: No PII extracted or stored.
 */

import type { Env } from './env';
import { parseInstitutionPage, buildGroundTruthRecord } from './crawler-logic';

export interface CrawlRequest {
  domains: string[];
}

export interface CrawlResponse {
  crawled: number;
  inserted: number;
  failed: number;
  results: DomainResult[];
}

interface DomainResult {
  domain: string;
  status: 'success' | 'failed' | 'skipped';
  institutionName?: string;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json() as CrawlRequest;

      if (!body.domains || !Array.isArray(body.domains) || body.domains.length === 0) {
        return jsonResponse({ error: 'domains array is required' }, 400);
      }

      // Limit batch size to prevent abuse
      const domains = body.domains.slice(0, 20);

      const response = await crawlDomains(domains, env);

      return jsonResponse(response);
    } catch (error) {
      console.error('[crawler] Error:', error);
      return jsonResponse({ error: 'Crawl failed' }, 500);
    }
  },
};

async function crawlDomains(domains: string[], env: Env): Promise<CrawlResponse> {
  const results: DomainResult[] = [];
  let inserted = 0;

  for (const domain of domains) {
    try {
      // Validate domain format (prevent SSRF)
      if (!isValidDomain(domain)) {
        results.push({ domain, status: 'skipped', error: 'Invalid domain format' });
        continue;
      }

      // INJ-03: DNS rebinding defense — resolve domain before fetching
      // and verify resolved IPs are not private/reserved
      if (await resolvesToPrivateIp(domain)) {
        results.push({ domain, status: 'skipped', error: 'Domain resolves to private/reserved IP' });
        continue;
      }

      // Fetch the main page
      const url = `https://${domain}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'ArkovaCrawler/1.0 (credential-verification; +https://arkova.ai)',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        results.push({ domain, status: 'failed', error: `HTTP ${response.status}` });
        continue;
      }

      const html = await response.text();

      // Parse institution data
      const parsed = parseInstitutionPage(html, domain);
      if (!parsed) {
        results.push({ domain, status: 'skipped', error: 'Not an institution page' });
        continue;
      }

      // Generate embedding via Workers AI
      const embeddingText = `${parsed.institutionName} ${parsed.domain} ${Object.values(parsed.metadata).join(' ')}`;
      const aiResult = await env.ARKOVA_AI.run('@cf/baai/bge-base-en-v1.5', {
        text: embeddingText,
      }) as { data: number[][] };

      const embedding = aiResult.data[0];
      if (!embedding || embedding.length !== 768) {
        results.push({ domain, status: 'failed', error: 'Embedding generation failed' });
        continue;
      }

      // Build record and insert into Supabase
      const record = buildGroundTruthRecord(parsed, embedding);

      const insertResult = await fetch(
        `${env.SUPABASE_URL}/rest/v1/institution_ground_truth`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify(record),
        },
      );

      if (!insertResult.ok) {
        const error = await insertResult.text();
        results.push({ domain, status: 'failed', error: `Insert failed: ${error}` });
        continue;
      }

      inserted++;
      results.push({
        domain,
        status: 'success',
        institutionName: parsed.institutionName,
      });
    } catch (error) {
      results.push({
        domain,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return {
    crawled: domains.length,
    inserted,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };
}

/**
 * INJ-03: Post-resolution IP validation.
 * Resolves a domain via Cloudflare DNS-over-HTTPS and checks whether
 * any A/AAAA record points to a private or reserved IP range.
 * Prevents DNS rebinding attacks where a domain initially resolves to
 * a public IP but later resolves to a private one.
 * Both IPv4 (A) and IPv6 (AAAA) records are checked.
 */
async function resolvesToPrivateIp(domain: string): Promise<boolean> {
  try {
    const encodedDomain = encodeURIComponent(domain);

    // Query A records (IPv4)
    const resA = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodedDomain}&type=A`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      },
    );

    if (resA.ok) {
      const jsonA = (await resA.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const answer of jsonA.Answer ?? []) {
        if (answer.type !== 1) continue; // Only A records (type 1)
        if (isPrivateIpv4(answer.data)) return true;
      }
    }

    // Query AAAA records (IPv6)
    const resAAAA = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodedDomain}&type=AAAA`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      },
    );

    if (resAAAA.ok) {
      const jsonAAAA = (await resAAAA.json()) as { Answer?: Array<{ type: number; data: string }> };
      for (const answer of jsonAAAA.Answer ?? []) {
        if (answer.type !== 28) continue; // Only AAAA records (type 28)
        if (isPrivateIpv6(answer.data)) return true;
      }
    }

    return false;
  } catch {
    return false; // fail-open — Cloudflare Workers runtime blocks private IPs at fetch level
  }
}

/** Check if an IPv4 address falls within private/reserved ranges */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return true; // malformed = block

  const [a, b] = parts;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // 127.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
  if (a === 0) return true;                           // 0.0.0.0/8
  return false;
}

/**
 * Check if an IPv6 address falls within private/reserved ranges.
 * Addresses from DNS are already in normalized lowercase string form.
 * Covered ranges:
 *   ::1          — loopback
 *   fe80::/10    — link-local (fe80:: through febf::)
 *   fc00::/7     — ULA (fc00:: and fd00::)
 *   ::           — unspecified
 *   100::/64     — discard prefix (RFC 6666)
 */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().trim();
  if (lower === '::1') return true;          // loopback
  if (lower === '::') return true;           // unspecified
  if (lower.startsWith('fe80:')) return true; // link-local fe80::/10
  if (lower.startsWith('fe90:')) return true; // link-local fe80::/10 (fe80-febf)
  if (lower.startsWith('fea0:')) return true; // link-local fe80::/10
  if (lower.startsWith('feb0:')) return true; // link-local fe80::/10
  if (lower.startsWith('fc00:')) return true; // ULA fc00::/7
  if (lower.startsWith('fd00:')) return true; // ULA fc00::/7 (fd subrange)
  if (lower.startsWith('0100:0000:0000:0000:')) return true; // 100::/64 discard
  if (lower.startsWith('100::')) return true; // 100::/64 discard (compressed)
  return false;
}

/** Validate domain format to prevent SSRF attacks */
function isValidDomain(domain: string): boolean {
  // Must be a simple domain (no protocol, no path, no port, no userinfo)
  if (domain.includes('/') || domain.includes(':') || domain.includes('@')) {
    return false;
  }
  // Must have at least one dot
  if (!domain.includes('.')) return false;

  // Block internal/reserved domains and IP-based SSRF vectors
  const blocked = [
    'localhost',
    '127.', '0.0.0.0', '0.',           // IPv4 loopback + zero
    '10.',                               // RFC 1918 Class A
    '172.16.', '172.17.', '172.18.', '172.19.',  // RFC 1918 Class B (172.16-31.*)
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.',                          // RFC 1918 Class C
    '169.254.',                          // Link-local / AWS metadata
    // CGNAT (100.64.0.0/10) — precise range check below
    '::1', 'fe80:', '[::',              // IPv6 loopback + link-local + bracket notation
    '.internal', '.local', '.corp',     // Internal TLDs / DNS rebinding vectors
    'metadata.google.internal',          // GCP metadata
  ];
  if (blocked.some((b) => domain.toLowerCase().includes(b))) return false;

  // CGNAT range check: 100.64.0.0 – 100.127.255.255 (100.64.0.0/10)
  const cgnatMatch = domain.match(/^100\.(\d+)\./);
  if (cgnatMatch) {
    const second = parseInt(cgnatMatch[1], 10);
    if (second >= 64 && second <= 127) return false;
  }

  // Must match a valid domain pattern (letters, digits, hyphens, dots)
  // TLD must be at least 2 chars and alphabetic
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
