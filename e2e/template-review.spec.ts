/**
 * AI-03 lock-in (c) — template-review E2E happy path (SCRUM-2383).
 *
 * upload-mock → on-device extract (mocked at the network seams) → review →
 * correct → confirm — asserting the NETWORK LAYER never carries raw document
 * content or unstripped PII.
 *
 * Mock strategy (production code path stays intact end to end):
 *  - The on-device NER runtime is stubbed by intercepting the app-origin
 *    vendored transformers.js module (TRANSFORMERS_BROWSER_MODULE — imported
 *    from the source constant so a vendor-bundle rename can never silently
 *    strand this intercept again; main's #1416 renamed `.web.min.js` →
 *    `.bundle.min.js` and did exactly that to the original hardcoded glob):
 *    the stub loads a pipeline that finds zero entities, so the REAL regex
 *    PII stripper still runs on-device (the file's SSN/email sentinels are
 *    stripped by it) without needing the ~100MB vendored model weights in CI.
 *  - The worker extraction + template endpoints are fulfilled with canned
 *    responses (no live Gemini) while their REQUEST bodies are captured and
 *    asserted against the privacy contract.
 *  - ENABLE_AI_EXTRACTION is forced ON via the get_flag RPC route so the run
 *    does not depend on seeded switchboard state.
 */

import { test, expect, getServiceClient, SEED_USERS } from './fixtures';
import { TRANSFORMERS_BROWSER_MODULE } from '../src/lib/nerPiiDetector';
import path from 'path';
import fs from 'fs';
import os from 'os';

// PII sentinels embedded in the uploaded document. The regex stripper removes
// these ON DEVICE — they must never appear in any network payload.
const SSN_SENTINEL = '123-45-6789';
const EMAIL_SENTINEL = 'sentinel.person@example-fixture.test';
const RAW_DOC_MARKER = 'RAW-DOC-CONTENT-MARKER-AI03';

const DOC_TEXT = [
  'Certificate of Continuing Professional Education.',
  `${RAW_DOC_MARKER}`,
  'Participant SSN: 123-45-6789.',
  'Contact: sentinel.person@example-fixture.test.',
  'Course: Advanced Tax Planning. CPE Credits: 4.0.',
  'Provider: Example Fixture Institute. Completed: March 20, 2026.',
].join('\n');

/** Stub transformers.js module: loads a NER pipeline that finds no entities. */
const TRANSFORMERS_STUB = `
export const env = {
  allowRemoteModels: true,
  allowLocalModels: true,
  localModelPath: '/models/',
  backends: { onnx: { wasm: { numThreads: 1 } } },
};
export async function pipeline() {
  return async () => [];
}
`;

function createTestTextFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkova-e2e-ai03-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, DOC_TEXT);
  return filePath;
}

test.describe('AI-03 template review — privacy-contract happy path', () => {
  const serviceClient = getServiceClient();
  let testFilePath: string;

  test.beforeAll(() => {
    testFilePath = createTestTextFile(`ai03_review_${Date.now()}.txt`);
  });

  test.afterAll(async () => {
    if (testFilePath && fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(path.dirname(testFilePath));
    }
    const { data: testAnchors } = await serviceClient
      .from('anchors')
      .select('id')
      .eq('user_id', SEED_USERS.individual.id)
      .like('filename', 'ai03_review_%');
    if (testAnchors) {
      for (const anchor of testAnchors) {
        await serviceClient.from('audit_events').delete().eq('anchor_id', anchor.id);
        await serviceClient.from('anchors').delete().eq('id', anchor.id);
      }
    }
  });

  test('upload → on-device extract (mocked) → review → correct → confirm; no raw doc content on the wire', async ({ individualPage: page }) => {
    // ── Capture EVERY outgoing request body for the privacy assertion ──
    const requestLog: Array<{ url: string; body: string }> = [];
    page.on('request', (request) => {
      requestLog.push({ url: request.url(), body: request.postData() ?? '' });
    });

    // ── Network seams ──
    // 1. On-device NER runtime stub (same-origin module intercept). Routed on
    //    the EXACT module path the production loader dynamically imports
    //    (src/lib/nerPiiDetector.ts TRANSFORMERS_BROWSER_MODULE) — if this
    //    pattern misses, the real loader runs, the git-ignored weights are
    //    absent in CI, and the §1.6 fail-closed path blocks the flow before
    //    the review panel (that exact drift broke this spec after #1416).
    await page.context().route(`**${TRANSFORMERS_BROWSER_MODULE}*`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: TRANSFORMERS_STUB,
      }),
    );

    // 2. Force ENABLE_AI_EXTRACTION on, deterministically.
    let aiFlagResolved = false;
    await page.route('**/rest/v1/rpc/get_flag', async (route) => {
      const body = route.request().postData() ?? '';
      if (body.includes('ENABLE_AI_EXTRACTION')) {
        aiFlagResolved = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: 'true' });
      } else {
        await route.fallback();
      }
    });

    // 3. Worker extraction endpoint — canned fields, overall confidence 0.6
    //    (below the 0.8 review threshold → every field requires review).
    let extractRequestBody = '';
    await page.route('**/api/v1/ai/extract', async (route) => {
      extractRequestBody = route.request().postData() ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          fields: {
            credentialType: 'CPE',
            issuerName: 'Example Fixture Institute',
            creditHours: '4',
          },
          confidence: 0.6,
          provider: 'mock-e2e',
          creditsRemaining: 10,
        }),
      });
    });

    // 4. Worker template endpoint — canned reconstruction (best-effort path).
    let templateRequestBody = '';
    await page.route('**/api/v1/ai/template', async (route) => {
      templateRequestBody = route.request().postData() ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          templateType: 'formal',
          documentTitle: 'CPE Certificate',
          sections: [],
          tags: ['education'],
          documentType: 'CPE Certificate',
          summary: 'Continuing professional education certificate.',
          verificationNotes: null,
        }),
      });
    });

    // ── Flow: upload → extract → review ──
    await page.goto('/records');
    await expect(
      page.locator('#main-content').getByRole('heading', { name: 'My Records' }),
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: /Secure Document/i }).click();
    await expect(page.getByText('Secure Document').first()).toBeVisible();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testFilePath);
    await expect(page.getByText(path.basename(testFilePath))).toBeVisible({ timeout: 10000 });
    await expect.poll(() => aiFlagResolved, {
      message: 'ENABLE_AI_EXTRACTION flag resolved before continuing',
      timeout: 10000,
    }).toBe(true);

    await page.getByTestId('secure-document-continue').click();

    // The review panel renders once on-device OCR + stripping + the mocked
    // extract round-trip complete.
    const reviewPanel = page.getByTestId('template-review-panel');
    await expect(reviewPanel).toBeVisible({ timeout: 30000 });

    // SCRUM-2914 (Founder UI findings, 2026-07-22): the AI-03 confidence-driven
    // review gate was removed — extraction confidence scoring is unreliable and
    // must never block a submit. Continue is enabled immediately; field
    // review/edit stays available (exercised below) but no longer gates the flow.
    // The template reconstruction request has not fired yet (it only goes out on
    // Continue), so its captured body is still empty at this point.
    const continueButton = page.getByTestId('extraction-review-continue');
    await expect(continueButton).toBeEnabled();
    expect(templateRequestBody).toEqual('');

    // ── Correct one field (edit) — review/edit remains available ──
    await page.getByTestId('review-edit-creditHours').click();
    await page.getByTestId('review-input-creditHours').fill('6');
    await page.getByTestId('review-save-creditHours').click();

    await expect(continueButton).toBeEnabled();
    await continueButton.click();
    await expect.poll(() => templateRequestBody, {
      message: 'template reconstruction request uses reviewed fields after review',
      timeout: 10000,
    }).not.toEqual('');

    // ── Template step (if shown) → confirm → success ──
    const skipButton = page.getByRole('button', { name: /^Skip$/ });
    if (await skipButton.isVisible().catch(() => false)) {
      await skipButton.click();
    }
    await expect(page.getByText(/Ready to Secure/i)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /Secure Document/i }).last().click();
    await expect(page.getByText(/Document Submitted/i)).toBeVisible({ timeout: 20000 });

    // ── PRIVACY CONTRACT ASSERTIONS ──
    // (1) The extract request went out PII-STRIPPED: the SSN was redacted
    //     on-device before any network call.
    expect(extractRequestBody).toContain('REDACTED');
    expect(extractRequestBody).not.toContain(SSN_SENTINEL);
    expect(extractRequestBody).not.toContain(EMAIL_SENTINEL);

    // (2) The template request carries ONLY extracted fields + confidence —
    //     no bytes, no raw document text.
    expect(templateRequestBody).not.toEqual('');
    const templatePayload = JSON.parse(templateRequestBody) as Record<string, unknown>;
    expect(Object.keys(templatePayload).sort()).toEqual(['confidence', 'fields']);
    expect(templatePayload.fields).toMatchObject({
      issuerName: 'Example Fixture Institute',
      creditHours: '6',
    });
    expect(templatePayload.fields).not.toMatchObject({ credentialType: 'CPE' });
    expect(templateRequestBody).not.toContain(RAW_DOC_MARKER);
    expect(templateRequestBody).not.toContain(SSN_SENTINEL);

    // (3) NO request anywhere in the session carried the raw PII sentinels.
    //     (The RAW_DOC_MARKER itself is non-PII plain text, so it may legally
    //     appear in the PII-stripped extraction payload — the SSN/email must not.)
    for (const { url, body } of requestLog) {
      expect(body, `request to ${url} must not carry the SSN sentinel`).not.toContain(SSN_SENTINEL);
      expect(body, `request to ${url} must not carry the email sentinel`).not.toContain(EMAIL_SENTINEL);
    }
  });
});
