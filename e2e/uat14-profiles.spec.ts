import { expect, test } from '@playwright/test';
import path from 'node:path';

/**
 * Screenshots land in Playwright's own output directory by default, so a local
 * run leaves the working tree clean. Set `UAT14_EVIDENCE_DIR` to capture into
 * the tracked evidence folder when refreshing UAT evidence deliberately
 * (PR #3033 review, pass 4).
 */
const SHOT_DIR = process.env.UAT14_EVIDENCE_DIR ?? 'test-results/uat14-screenshots';

function shot(name: string) {
  return path.join(SHOT_DIR, name);
}

const hookModule = `
const member={public_id:'person-public',display_name:'Ada Lovelace',avatar_url:null,avatar_storage_path:'users/u/avatar/a.png',banner_storage_path:'users/u/banner/b.png',bio:'Building trustworthy records for everyone.',social_links:{website:'ada.example',twitter:'@ada'},created_at:'2026-01-01',organizations:[{org_id:'33333333-3333-4333-8333-333333333333',public_id:'org-public',display_name:'Analytical Society',domain:'analytical.example',logo_url:null,verification_status:'VERIFIED',role:'admin'}]};
const org={org_id:'33333333-3333-4333-8333-333333333333',public_id:'org-public',display_name:'Analytical Society',domain:'analytical.example',description:'Public organization profile with independently controlled brand media.',org_type:'nonprofit',website_url:'https://analytical.example',linkedin_url:'https://linkedin.com/company/analytical',twitter_url:'@analytical',logo_url:null,logo_storage_path:'organizations/o/logo/a.png',banner_storage_path:'organizations/o/banner/b.png',location:'Detroit, MI',founded_date:'2020-01-01',industry_tag:'nonprofit',verification_status:'VERIFIED',created_at:'2026-01-01',total_credentials:12,secured_credentials:11,credential_breakdown:[],public_members:[],sub_organizations:[]};
export const usePublicMemberProfile=()=>({profile:member,loading:false,error:null,fetchProfile:async()=>{}});
export const useOrgProfile=()=>({profile:org,loading:false,error:null,fetchProfile:async()=>{}});
export const useIssuerRegistry=()=>({registry:{anchors:[],total:0},loading:false,error:null,fetchRegistry:async()=>{}});
`;
const mediaModule = `export const useProfileMediaUrl=(path,fallback)=>path?(path.includes('banner')?'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="300"><rect width="1200" height="300" fill="%2300a8cc"/></svg>':'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="100" fill="%2300d4ff"/></svg>'):fallback;export const ProfileMediaImage=()=>null;`;

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '33333333-3333-4333-8333-333333333333';
const PUBLIC_USER = 'person-public';
const PUBLIC_ORG = 'org-public';
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

/** Unsigned JWT whose payload satisfies `sessionHasAal2` for the fixture user. */
function aal2Token(userId: string): string {
  const b64url = (v: string) => Buffer.from(v).toString('base64url');
  return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: userId, aal: 'aal2', role: 'authenticated' }))}.`;
}

async function openEditor(page: import('@playwright/test').Page, view: 'settings' | 'org-editor') {
  const profileModule = `const profile={id:'${USER}',public_id:'${PUBLIC_USER}',org_id:'${ORG}',role:'ORG_ADMIN',full_name:'Ada Editor',bio:'',social_links:{},avatar_url:null,avatar_storage_path:'users/${PUBLIC_USER}/avatar/current.png',banner_storage_path:null,is_public_profile:true,is_platform_admin:false,status:'ACTIVE'};export const ProfileProvider=({children})=>children;export const useProfile=()=>({profile,loading:false,updating:false,refreshProfile:async()=>{},updateProfile:async patch=>{await fetch('/__uat14/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});return true}});`;
  const organizationModule = `const organization={id:'${ORG}',public_id:'${PUBLIC_ORG}',display_name:'Analytical Society',legal_name:'Analytical Society LLC',domain:'analytical.example',verification_status:'VERIFIED',description:'Editor fixture',website_url:'https://analytical.example',linkedin_url:null,twitter_url:null,created_at:'2026-01-01',logo_url:null,logo_storage_path:'organizations/${PUBLIC_ORG}/logo/current.png',banner_storage_path:'organizations/${PUBLIC_ORG}/banner/current.png'};export const useOrganization=()=>({organization,loading:false,updating:false,updateOrganization:async patch=>{await fetch('/__uat14/org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});return true}});`;
  const modules: Record<string, string> = {
    // The upload inputs are gated on `sessionHasAal2(session.access_token, user.id)`
    // (src/lib/mfaSessionKey.ts: sub === user.id && aal === 'aal2' && role ===
    // 'authenticated'). It only decodes the payload, never verifies a signature,
    // so an unsigned token with those three claims is enough for the fixture.
    '/src/hooks/useAuth.ts': `export const AuthProvider=({children})=>children;export const useAuth=()=>({user:{id:'${USER}',email:'ada@example.test'},session:{access_token:'${aal2Token(USER)}'},signOut:async()=>{}});`,
    '/src/hooks/useProfile.ts': profileModule,
    '/src/hooks/useOrganization.ts': organizationModule,
    '/src/components/layout/index.ts': `import React from'/node_modules/.vite/deps/react.js';export const AppShell=({children})=>React.createElement('main',null,children);`,
    '/src/hooks/useOrgMembers.ts': `export const useOrgMembers=()=>({members:[],loading:false,refreshMembers:async()=>{}});`,
    '/src/hooks/useOrgInvitations.ts': `export const useOrgInvitations=()=>({invitations:[],loading:false,error:null,refreshInvitations:async()=>{}});`,
    '/src/hooks/useAdminOrgMembers.ts': `export const useAdminOrgMembers=()=>({members:[],loading:false,refreshMembers:async()=>{}});`,
    '/src/hooks/useRevokeAnchor.ts': `export const useRevokeAnchor=()=>({revokeAnchor:async()=>true});`,
    '/src/hooks/useInviteMember.ts': `export const useInviteMember=()=>({inviteMember:async()=>true});`,
    '/src/hooks/useCanIssueCredential.ts': `export const useCanIssueCredential=()=>({allowed:false,loading:false});`,
    '/src/hooks/useIssueCredentialSplit.ts': `export const useIssueCredentialSplit=()=>({enabled:true,loading:false});`,
    '/src/hooks/useExportAnchors.ts': `export const useExportAnchors=()=>({exportAnchors:async()=>true,loading:false});`,
    '/src/components/anchor/index.ts': `export const SecureDocumentDialog=()=>null;`,
    '/src/components/organization/index.ts': `export const OrgRegistryTable=()=>null;export const MembersTable=()=>null;export const PendingInvitationsList=()=>null;export const IssueCredentialForm=()=>null;export const RevokeDialog=()=>null;export const InviteMemberModal=()=>null;export const AddExistingMemberModal=()=>null;`,
    '/src/components/org/OrgVerification.tsx': `export const OrgVerification=()=>null;`,
    '/src/components/org/ManageSubOrgs.tsx': `export const ManageSubOrgs=()=>null;export const translateWorkerError=()=>'';`,
    '/src/components/org/RequestAffiliationDialog.tsx': `export const RequestAffiliationDialog=()=>null;`,
    '/src/components/shared/VerifiedBadge.tsx': `export const UserVerifiedBadge=()=>null;export const OrgVerifiedBadge=()=>null;export const AffiliatedBadge=()=>null;`,
    '/src/components/integrations/DriveConnectorCard.tsx': `export const DriveConnectorCard=()=>null;`,
    '/src/components/integrations/DocusignConnectorCard.tsx': `export const DocusignConnectorCard=()=>null;`,
    '/src/components/integrations/MemberDocusignConnectorCard.tsx': `export const MemberDocusignConnectorCard=()=>null;`,
    '/src/components/integrations/AdobeSignConnectorCard.tsx': `export const AdobeSignConnectorCard=()=>null;export const adobeSignErrorCopy=()=>'';`,
    '/src/components/auth/DeleteAccountDialog.tsx': `export const DeleteAccountDialog=()=>null;`,
    '/src/components/auth/ExportDataButton.tsx': `export const ExportDataButton=()=>null;`,
    '/src/components/auth/DataCorrectionForm.tsx': `export const DataCorrectionForm=()=>null;`,
    '/src/components/auth/TwoFactorSetup.tsx': `export const TwoFactorSetup=()=>null;`,
    '/src/components/auth/IdentityVerification.tsx': `export const IdentityVerification=()=>null;`,
    '/src/lib/workerClient.ts': `export const WORKER_URL='';export const workerFetch=async()=>new Response(JSON.stringify({}),{status:200});`,
    '/src/lib/supabase.ts': `export const authLinkErrorFromUrl=()=>null;export const shouldRedirectToAuthCallback=()=>false;function query(){const q={};for(const m of ['select','eq','is','order','range','or','gte','lte','in'])q[m]=()=>q;q.single=async()=>({data:{role:'owner'},error:null});q.maybeSingle=q.single;q.then=r=>r({data:[],count:0,error:null});return q}export const supabase={from:query,auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},storage:{from:()=>({upload:async(path,blob)=>{await fetch('/__uat14/upload',{method:'POST',headers:{'x-path':path,'x-type':blob.type},body:blob});return{error:null}},remove:async()=>({error:null}),getPublicUrl:path=>({data:{publicUrl:'https://public.example/'+path}}),createSignedUrl:async path=>({data:{signedUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='},error:null})})}};`,
  };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
    if (url.pathname.startsWith('/__uat14/')) return route.fulfill({ status: 200, json: { ok: true } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: { folders: [], count: 0 } });
    return route.continue();
  });
  await page.goto(`/e2e/fixtures/uat14-profiles.html?view=${view}`);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) test(`${viewport.width}px public profiles are usable`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.route('**/*', route => { const pathname = new URL(route.request().url()).pathname; if (pathname === '/src/hooks/usePublicSearch.ts') return route.fulfill({ contentType: 'application/javascript', body: hookModule }); if (pathname === '/src/components/shared/ProfileMediaImage.tsx') return route.fulfill({ contentType: 'application/javascript', body: mediaModule }); if (pathname === '/src/App.tsx') return route.fulfill({ contentType: 'application/javascript', body: 'export const isSearchSubdomain=()=>false;' }); return route.continue(); });
  await page.goto('/e2e/fixtures/uat14-profiles.html');
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByLabel('Profile QR code')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: shot(`member-${viewport.width}.png`), fullPage: true });
  await page.goto('/e2e/fixtures/uat14-profiles.html?view=org');
  await expect(page.getByRole('heading', { name: 'Analytical Society' })).toBeVisible();
  await expect(page.getByLabel('Organization profile QR code')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: shot(`organization-${viewport.width}.png`), fullPage: true });
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) test(`${viewport.width}px editors sanitize and commit profile media`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const uploads: Array<{ path: string; type: string }> = [];
  const profileWrites: Record<string, unknown>[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/__uat14/upload') uploads.push({ path: request.headers()['x-path'], type: request.headers()['x-type'] });
    if (url.pathname === '/__uat14/profile') profileWrites.push(request.postDataJSON());
  });
  await openEditor(page, 'settings');
  await expect(page.getByText('Profile images')).toBeVisible();
  await page.locator('#profile-avatar').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: onePixelPng });
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toMatchObject({ type: 'image/png' });
  expect(uploads[0].path).toMatch(new RegExp(`^users/${PUBLIC_USER}/avatar/.+\\.png$`));
  await expect.poll(() => profileWrites.some(write => typeof write.avatar_storage_path === 'string')).toBe(true);
  await expect(page.locator('#profile-avatar')).toHaveValue('');
  await expect(page.getByAltText('Current profile')).toBeVisible();

  const beforeMalformed = uploads.length;
  await page.locator('#profile-banner').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: onePixelPng.subarray(0, 20) });
  await page.waitForTimeout(200);
  expect(uploads).toHaveLength(beforeMalformed);
  await expect(page.locator('#profile-banner')).toHaveValue('');

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: shot(`settings-editor-${viewport.width}.png`), fullPage: true });
  await page.getByRole('switch').click();
  await expect.poll(() => profileWrites.some(write => write.is_public_profile === false)).toBe(true);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) test(`${viewport.width}px organization editor commits logo and banner pointers`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const uploads: string[] = [];
  const orgWrites: Record<string, unknown>[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/__uat14/upload') uploads.push(request.headers()['x-path']);
    if (url.pathname === '/__uat14/org') orgWrites.push(request.postDataJSON());
  });
  await openEditor(page, 'org-editor');
  await expect(page.getByRole('heading', { name: 'Analytical Society' })).toBeVisible();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: onePixelPng });
  await expect.poll(() => orgWrites.some(write => typeof write.logo_storage_path === 'string')).toBe(true);
  // Organization media is also mirrored to the public bucket (replaceProfileMedia's
  // publicMirror branch), so the upload log interleaves mirror paths; assert on the
  // owned private path's shape rather than its index.
  expect(uploads.some(path => new RegExp(`^organizations/${PUBLIC_ORG}/logo/.+\\.png$`).test(path))).toBe(true);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.locator('#org-banner').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: onePixelPng });
  await expect.poll(() => orgWrites.some(write => typeof write.banner_storage_path === 'string')).toBe(true);
  expect(uploads.some(path => new RegExp(`^organizations/${PUBLIC_ORG}/banner/.+\\.png$`).test(path))).toBe(true);
  await expect(page.getByAltText('Current organization banner')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  await page.screenshot({ path: shot(`organization-editor-${viewport.width}.png`), fullPage: true });
});
