import { expect, test, type Page, type TestInfo } from '@playwright/test';

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

async function openFixture(page: Page, role: 'admin' | 'member') {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ role }) => {
    Object.assign(window, { __uat19: { role } });
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}';
      document.head.append(style);
    }, { once: true });
  }, { role });
  const modules: Record<string, string> = {
    '/src/hooks/useAuth.ts': `export const useAuth=()=>({user:{id:'${USER}',email:'person@example.test'},signOut:async()=>{}});`,
    '/src/hooks/useProfile.ts': `export const useProfile=()=>({profile:{id:'${USER}',org_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',role:'ORG_ADMIN',is_platform_admin:false},loading:false});`,
    '/src/hooks/useOrganization.ts': `export const useOrganization=()=>({organization:{id:'${ORG}',display_name:'Selected Route Organization',legal_name:'Selected Route Organization LLC',domain:'selected.example',verification_status:'VERIFIED',description:'Exact-route organization dashboard fixture.',website_url:'https://selected.example',linkedin_url:'https://linkedin.com/company/selected',twitter_url:'https://x.com/selected',created_at:'2026-01-01T00:00:00Z'},updating:false,updateOrganization:async()=>true});`,
    '/src/hooks/useOrgMembers.ts': `export const useOrgMembers=()=>({members:[],loading:false,refreshMembers:async()=>{}});`,
    '/src/hooks/useOrgInvitations.ts': `export const useOrgInvitations=()=>({invitations:[],loading:false,error:null,refreshInvitations:async()=>{}});`,
    '/src/hooks/useAdminOrgMembers.ts': `export const useAdminOrgMembers=()=>({members:[],loading:false,refreshMembers:async()=>{}});`,
    '/src/hooks/useRevokeAnchor.ts': `export const useRevokeAnchor=()=>({revokeAnchor:async()=>true});`,
    '/src/hooks/useInviteMember.ts': `export const useInviteMember=()=>({inviteMember:async()=>true});`,
    '/src/hooks/useCanIssueCredential.ts': `export const useCanIssueCredential=()=>({allowed:false,loading:false});`,
    '/src/hooks/useIssueCredentialSplit.ts': `export const useIssueCredentialSplit=()=>({enabled:true,loading:false});`,
    '/src/hooks/useExportAnchors.ts': `export const useExportAnchors=()=>({exportAnchors:async()=>true,loading:false});`,
    '/src/components/layout/index.ts': `import React from'/node_modules/.vite/deps/react.js';export const AppShell=({children})=>React.createElement('main',null,children);`,
    '/src/components/anchor/index.ts': `import React from'/node_modules/.vite/deps/react.js';export const SecureDocumentDialog=({open,orgId})=>open?React.createElement('div',{role:'dialog','data-testid':'secure-org'},orgId):null;`,
    '/src/components/organization/index.ts': `export {OrgRegistryTable} from '/src/components/organization/OrgRegistryTable.tsx';export const MembersTable=()=>null;export const PendingInvitationsList=()=>null;export const IssueCredentialForm=()=>null;export const RevokeDialog=()=>null;export const InviteMemberModal=()=>null;export const AddExistingMemberModal=()=>null;`,
    '/src/components/folders/index.ts': `export {FolderSidebar} from '/src/components/folders/FolderSidebar.tsx';export {FolderFormDialog} from '/src/components/folders/FolderFormDialog.tsx';export {DeleteFolderDialog} from '/src/components/folders/DeleteFolderDialog.tsx';export {MoveToFolderDialog} from '/src/components/folders/MoveToFolderDialog.tsx';`,
    '/src/components/org/OrgVerification.tsx': `export const OrgVerification=()=>null;`,
    '/src/components/org/ManageSubOrgs.tsx': `export const ManageSubOrgs=()=>null;export const translateWorkerError=()=>'';`,
    '/src/components/org/RequestAffiliationDialog.tsx': `export const RequestAffiliationDialog=()=>null;`,
    '/src/components/shared/VerifiedBadge.tsx': `export const OrgVerifiedBadge=()=>null;export const AffiliatedBadge=()=>null;`,
    '/src/components/integrations/DriveConnectorCard.tsx': `export const DriveConnectorCard=()=>null;`,
    '/src/components/integrations/DocusignConnectorCard.tsx': `export const DocusignConnectorCard=()=>null;`,
    '/src/components/integrations/MemberDocusignConnectorCard.tsx': `export const MemberDocusignConnectorCard=()=>null;`,
    '/src/components/integrations/AdobeSignConnectorCard.tsx': `export const AdobeSignConnectorCard=()=>null;export const adobeSignErrorCopy=()=>'';`,
    '/src/lib/workerClient.ts': `export const WORKER_URL='http://localhost:3001';export const workerFetch=async(path,init)=>fetch(path,init);`,
    '/src/lib/supabase.ts': `function query(table){const q={};for(const m of ['select','eq','is','filter','order','range','or','gte','lte','in'])q[m]=()=>q;q.single=async()=>({data:table==='org_members'?{role:window.__uat19.role}:null,error:null});q.maybeSingle=q.single;q.then=(resolve)=>resolve(table==='anchors'?{data:[{id:'anchor-1',filename:'selected-record.pdf',fingerprint:'abc123',status:'SECURED',credential_type:null,label:null,public_id:'ARK-SELECTED',file_size:20,created_at:'2026-09-19T00:00:00Z',updated_at:'2026-09-19T00:00:00Z',chain_timestamp:null,chain_tx_id:null,chain_block_height:null,metadata:null,folder_id:'folder-child'}],count:1,error:null}:{data:null,count:0,error:null});return q;}export const supabase={from:query,auth:{getSession:async()=>({data:{session:null}})},storage:{from:()=>({upload:async()=>({error:null}),getPublicUrl:()=>({data:{publicUrl:''}})})}};`,
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
    if (url.pathname === '/api/v1/folders' && route.request().method() === 'GET') return route.fulfill({ json: { folders: [
      { id: 'folder-root', public_id: 'F-ROOT', name: 'Compliance', owner_scope: 'ORG', context_org_id: ORG, parent_folder_id: null, connector_provider: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'folder-child', public_id: 'F-CHILD', name: 'Quarterly', owner_scope: 'ORG', context_org_id: ORG, parent_folder_id: 'folder-root', connector_provider: null, created_at: '2026-01-02T00:00:00Z' },
    ] } });
    if (url.pathname === '/api/v1/folders' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { folder: {} } });
    if (url.pathname === '/api/v1/folders/bulk-move') return route.fulfill({
      status: 207,
      json: { moved: [], failed: [{ anchor_id: 'anchor-1', code: 'move_denied' }] },
    });
    if (url.pathname === '/api/queue/pending') return route.fulfill({ json: { items: [], count: 0 } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { count: 0 } });
    return route.continue();
  });
  await page.goto('/e2e/fixtures/uat19-org-profile.html');
  await expect(page.getByRole('heading', { name: 'Selected Route Organization' })).toBeVisible();
  await page.locator('main').evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const width = await page.evaluate(() => innerWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test.describe(`UAT-19 ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test('exact-org admin sees folders, search, socials, queue, and secure action', async ({ page }, testInfo) => {
      await openFixture(page, 'admin');
      await expect(page.getByRole('button', { name: 'Compliance', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(/search by filename/i)).toBeVisible();
      await expect(page.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', /linkedin\.com/);
      await capture(page, testInfo, `admin-org-profile-${viewport.width}`);
      await page.getByRole('button', { name: 'New Folder' }).click();
      await page.getByLabel('Folder name').fill('Evidence');
      const createRequest = page.waitForRequest(request => request.url().endsWith('/api/v1/folders') && request.method() === 'POST');
      await page.getByRole('button', { name: 'Create' }).click();
      expect((await createRequest).postDataJSON()).toMatchObject({ owner_scope: 'ORG', org_id: ORG });
      if (viewport.width >= 640) {
        await page.getByRole('checkbox', { name: 'Select selected-record.pdf' }).click();
        await page.getByRole('button', { name: 'Move to folder' }).click();
        const moveDialog = page.getByRole('dialog', { name: 'Move to Folder' });
        await moveDialog.getByRole('button', { name: /Quarterly/ }).click();
        await expect(moveDialog).toBeVisible();
        await expect(moveDialog.getByRole('alert')).toHaveText('Could not move the record. Please try again.');
        await capture(page, testInfo, 'admin-partial-move-1280');
        await moveDialog.getByRole('button', { name: 'Close' }).click();
      }
      await page.getByRole('button', { name: /^(Secure Document|Secure)$/i }).click();
      await expect(page.getByTestId('secure-org')).toHaveText(ORG);
      const queueRequest = page.waitForRequest(request => request.url().includes('/api/queue/pending'));
      await page.getByRole('button', { name: 'Queue', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();
      expect(new URL((await queueRequest).url()).searchParams.get('org_id')).toBe(ORG);
      await capture(page, testInfo, `admin-${viewport.width}`);
    });
    test('ordinary member retains read/search but no org write or queue actions', async ({ page }, testInfo) => {
      await openFixture(page, 'member');
      await expect(page.getByPlaceholder(/search by filename/i)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Quarterly' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Queue' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^(Secure Document|Secure)$/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New Folder' })).toHaveCount(0);
      await capture(page, testInfo, `member-${viewport.width}`);
    });
  });
}
