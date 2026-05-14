import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  createTestAnchor,
  deleteTestAnchor,
  getServiceClient,
  resolveSeedIndividualOrFallbackProfileId,
} from '../../e2e/fixtures/supabase';

type HeroStatus = 'PENDING' | 'SUBMITTED' | 'SECURED' | 'EXPIRED' | 'REVOKED';

const OUT_DIR = path.resolve('docs/uat/scrum-952-public-verify');
const BASE_URL = process.env.UAT_BASE_URL ?? 'http://localhost:5173';

const CASES: ReadonlyArray<{
  status: HeroStatus;
  filename: string;
  heading: string | RegExp;
}> = [
  { status: 'PENDING', filename: 'uat_scrum_952_pending.pdf', heading: 'Submitting to network...' },
  { status: 'SUBMITTED', filename: 'uat_scrum_952_submitted.pdf', heading: 'Record Submitted · Awaiting Network Confirmation' },
  { status: 'SECURED', filename: 'uat_scrum_952_secured.pdf', heading: /^Verified on/i },
  { status: 'EXPIRED', filename: 'uat_scrum_952_expired.pdf', heading: 'Record Expired' },
  { status: 'REVOKED', filename: 'uat_scrum_952_revoked.pdf', heading: 'Record Revoked' },
];

const VIEWPORTS = [
  { label: 'desktop-1280', width: 1280, height: 900 },
  { label: 'mobile-375', width: 375, height: 812 },
] as const;

const UatAnchorUpdateSchema = z.object({
  credential_type: z.literal('OTHER'),
  metadata: z.object({
    sub_type: z.literal('professional_certification'),
    issued_to: z.string().min(1),
  }).strict(),
}).strict();

async function capture(page: Page, publicId: string, status: HeroStatus, heading: string | RegExp) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(`${BASE_URL}/verify/${publicId}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: heading }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({
      path: path.join(OUT_DIR, `${viewport.label}-${status.toLowerCase()}.png`),
      fullPage: false,
    });
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const serviceClient = getServiceClient();
  const userId = await resolveSeedIndividualOrFallbackProfileId(serviceClient, {
    errorLabel: 'UAT profile',
    fallbackLabel: 'staging screenshots',
    warningPrefix: 'SCRUM-952 UAT',
  });
  const anchors: Array<{ id: string; public_id: string }> = [];
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    for (const testCase of CASES) {
      const anchor = await createTestAnchor(serviceClient, {
        userId,
        status: testCase.status,
        filename: testCase.filename,
      });

      if (!anchor?.id || !anchor?.public_id) {
        throw new Error(`Failed to create ${testCase.status} UAT anchor`);
      }

      anchors.push({ id: anchor.id as string, public_id: anchor.public_id as string });

      const updatePayload = UatAnchorUpdateSchema.parse({
        credential_type: 'OTHER',
        metadata: {
          sub_type: 'professional_certification',
          issued_to: 'SCRUM-952 UAT Recipient',
        },
      });

      const { error: metadataError } = await serviceClient
        .from('anchors')
        .update(updatePayload)
        .eq('id', anchor.id);

      if (metadataError) {
        throw new Error(`Failed to add SCRUM-952 UAT metadata: ${metadataError.message}`);
      }

      await capture(page, anchor.public_id as string, testCase.status, testCase.heading);
    }
  } finally {
    await browser.close();
    for (const anchor of anchors) {
      try {
        await deleteTestAnchor(serviceClient, anchor.id);
      } catch (error) {
        console.error(`Failed to delete SCRUM-952 UAT anchor ${anchor.id}:`, error);
      }
    }
  }

  console.log(`SCRUM-952 UAT screenshots written to ${OUT_DIR}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
