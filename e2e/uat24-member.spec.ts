import { expect, test } from '@playwright/test';
import path from 'node:path';

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) test(`${viewport.width}px member context is exact and actionable`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const modules: Record<string, string> = {
    '/src/hooks/useAuth.ts': `export const useAuth=()=>({user:{id:'actor'},signOut:async()=>{}});`,
    '/src/hooks/useProfile.ts': `export const useProfile=()=>({profile:{},loading:false});`,
    '/src/hooks/useActiveOrg.ts': `export const useActiveOrg=()=>({orgId:'11111111-1111-4111-8111-111111111111',loading:false});`,
    '/src/hooks/useOrganization.ts': `export const useOrganization=id=>({organization:{id,name:'Selected child organization'}});`,
    '/src/lib/workerClient.ts': `export const WORKER_URL='http://localhost:3001';export const PUBLIC_API_URL=WORKER_URL;export const workerPostForUrl=async()=>'';export const workerFetch=async url=>new Response(JSON.stringify(url.includes('member-context')?{member:{id:'22222222-2222-4222-8222-222222222222',email:'member@example.com',full_name:'Secondary Member',avatar_url:null,role:'INDIVIDUAL',created_at:'2026-01-01T00:00:00Z',org_id:'33333333-3333-4333-8333-333333333333',membership_role:'member'}}:{folders:[{id:'folder',name:'Contextual folder',parent_folder_id:null,connector_provider:'google_drive'}]}),{status:200,headers:{'Content-Type':'application/json'}});`,
    '/src/lib/supabase.ts': `const anchor={id:'anchor',filename:'secondary-record.pdf',fingerprint:'a'.repeat(64),status:'SECURED',credential_type:null,label:null,public_id:'ARK-MEMBER',file_size:100,folder_id:'folder',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',chain_timestamp:null,chain_tx_id:null,chain_block_height:null};function from(){const q={};for(const m of ['select','eq','is','order'])q[m]=()=>q;q.limit=async()=>({data:[anchor],error:null});return q}export const supabase={from};`,
  };
  await page.route('**/*', route => { const url = new URL(route.request().url()); return modules[url.pathname] ? route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] }) : route.continue(); });
  await page.goto('/e2e/fixtures/uat24-member.html');
  await expect(page.getByText('Secondary Member')).toBeVisible();
  await expect(page.getByText('secondary-record.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Contextual folder' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('secondary-record.pdf')).toBeVisible();
  await expect(page.locator('main')).toHaveCSS('opacity', '1');
  await expect(page.locator('.animate-in-view')).toHaveCSS('opacity', '1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: path.join('docs/staging/uat24-completion-20260919/screenshots', `member-${viewport.width}.png`), fullPage: true });
});
