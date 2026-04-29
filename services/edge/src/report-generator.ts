/**
 * PDF Report Generation Worker (P8-S15 / INFRA-03)
 *
 * Generates portfolio reports and stores them in the ARKOVA_REPORTS R2 bucket.
 * Provides zero-egress signed URLs for download.
 *
 * Constitution 1.4: No PII in generated reports.
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md Section 2
 */

import type { Env } from './env';
import { buildR2Key, generateReportContent, type ReportRequest } from './report-logic';
import { buildSignedReportUrl, verifySignedReportUrl } from './r2-signed-url';

const DOWNLOAD_URL_TTL_SEC = 3600;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json() as ReportRequest;

      if (!body.orgId || !body.reportType || !body.data) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields: orgId, reportType, data' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Generate report content
      const content = generateReportContent(body);

      // Build R2 key
      const key = buildR2Key(body.orgId, body.reportType, new Date());

      // Store in R2 (put() throws on binding failure; no response.ok to check)
      await env.ARKOVA_REPORTS.put(key, content, {
        httpMetadata: {
          contentType: 'text/markdown',
        },
        customMetadata: {
          orgId: body.orgId,
          reportType: body.reportType,
          generatedAt: new Date().toISOString(),
        },
      });

      // SCRUM-1283 (R3-10) sub-issue C: real HMAC-signed download URL.
      // The previous behavior returned a hardcoded `arkova-reports.r2.cloudflarestorage.com`
      // URL that wasn't actually authenticated — anyone who guessed an R2
      // key could attempt access. Now the URL points at /reports/dl on this
      // worker with `?expires&sig` params verified by the route handler
      // (handleSignedReportDownload, also exported from this file).
      const downloadSecret = env.R2_REPORT_DOWNLOAD_SECRET;
      if (!downloadSecret) {
        console.error('[report-generator] R2_REPORT_DOWNLOAD_SECRET missing — refusing to emit unsigned URL');
        return new Response(
          JSON.stringify({
            error: 'misconfigured',
            message: 'R2_REPORT_DOWNLOAD_SECRET must be provisioned before reports can be issued.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const baseUrl = new URL(request.url).origin;
      const signedUrl = await buildSignedReportUrl(baseUrl, key, downloadSecret, DOWNLOAD_URL_TTL_SEC);

      return new Response(
        JSON.stringify({
          key,
          signedUrl,
          expiresIn: DOWNLOAD_URL_TTL_SEC,
          contentType: 'text/markdown',
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    } catch (error) {
      console.error('[report-generator] Error:', error);
      return new Response(
        JSON.stringify({ error: 'Report generation failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};

/**
 * SCRUM-1283 (R3-10) sub-issue C — public download route.
 *
 * Verifies the HMAC + expiry on `/reports/dl/<key>?expires&sig`, then
 * streams the R2 object back. NOT gated by CRON_SECRET — the signature
 * is the auth. Mounted from index.ts BEFORE the `/report*` internal
 * gate so download URLs work for end-users without the cron secret.
 */
export async function handleSignedReportDownload(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }
  const downloadSecret = env.R2_REPORT_DOWNLOAD_SECRET;
  if (!downloadSecret) {
    return new Response('misconfigured', { status: 503 });
  }
  const url = new URL(request.url);
  const verdict = await verifySignedReportUrl(url, downloadSecret);
  if (!verdict.ok) {
    const status = verdict.reason === 'expired' ? 410 : 401;
    return new Response(
      JSON.stringify({ error: verdict.reason }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const obj = await env.ARKOVA_REPORTS.get(verdict.key);
  if (!obj) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, max-age=60, no-transform');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(obj.body, { status: 200, headers });
}
