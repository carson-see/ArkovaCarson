import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

declare global {
  interface Window {
    __layout: {
      scenario: string;
      instant: boolean;
      requests: Array<{ kind: string; payload?: Record<string, unknown>; records?: unknown[]; authorization?: string }>;
      finishBulk?: () => void;
      finishExtraction?: () => void;
    };
  }
}

export const LONG_NAME = `${'document-with-a-long-filename-'.repeat(6)}.pdf`;
const USER_ID = 'b1111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = 'b2222222-2222-4222-8222-222222222222';
export const ANCHOR_ID = 'b3333333-3333-4333-8333-333333333333';
export const CHILD_ORG_ID = 'b4444444-4444-4444-8444-444444444444';
export const PARENT_ORG_ID = 'b5555555-5555-4555-8555-555555555555';
const AAL2_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: USER_ID, aud: 'authenticated', aal: 'aal2' })).toString('base64url'),
  'fixture',
].join('.');
export type CapturedRequest = { kind: string; payload?: Record<string, unknown>; authorization?: string };

/** Only I/O and account/capability boundaries are mocked; all layout components run unchanged. */
export async function openLayoutFixture(page: Page, scenario = 'review', instant = false) {
  const httpRequests: CapturedRequest[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(({ scenario, instant }) => {
    Object.assign(window, { __layout: { scenario, instant, requests: [] } });
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}';
      document.head.append(style);
    }, { once: true });
  }, { scenario, instant });
  const modules: Record<string, string> = {
    '/src/hooks/useAuth.ts': `export const useAuth = () => ({user:{id:'${USER_ID}'}});`,
    '/src/hooks/useAuth.tsx': `export const useAuth = () => ({user:{id:'${USER_ID}'}});`,
    '/src/hooks/useProfile.ts': `export const useProfile = () => ({profile:{org_id:['selected-child','child-instant','member-zero'].includes(window.__layout.scenario)?'${PARENT_ORG_ID}':null}});`,
    '/src/hooks/useProfile.tsx': `export const useProfile = () => ({profile:{org_id:['selected-child','child-instant','member-zero'].includes(window.__layout.scenario)?'${PARENT_ORG_ID}':null}});`,
    '/src/hooks/useAuditorMode.ts': 'export const useAuditorMode = () => ({isAuditorMode:false});',
    '/src/hooks/useAuditorMode.tsx': 'export const useAuditorMode = () => ({isAuditorMode:false});',
    '/src/hooks/useSecuringCapability.ts': `const child=['selected-child','child-instant','member-zero'].includes(window.__layout.scenario);
      const scope=child?'org_id=${CHILD_ORG_ID}':'scope=user';
      const capability=await fetch('http://localhost:3001/api/v1/anchor-credits/status?'+scope,{headers:{Authorization:'Bearer ${AAL2_TOKEN}'}}).then(r=>r.json());
      export const useSecuringCapability=()=>({capability,loading:false,error:null,refresh:async()=>({data:capability})});`,
    '/src/hooks/usePrivateTagSuggestions.ts': `export const parsePrivateTags=value=>{const tags=[...new Map(value.split(',').map(t=>t.trim()).filter(Boolean).map(t=>[t.toLowerCase(),t])).values()];if(tags.some(t=>t.length>64))return {ok:false,reason:'too_long'};if(tags.length>10)return {ok:false,reason:'too_many'};return {ok:true,tags}};export const commaAwareTagOptions=(value,suggestions)=>{const parts=value.split(',');const completed=parts.slice(0,-1).map(t=>t.trim()).filter(Boolean);const prefix=completed.length?completed.join(', ')+', ':'';const needle=(parts[parts.length-1]??'').trim().toLowerCase();const chosen=new Set(completed.map(t=>t.toLowerCase()));return suggestions.filter(t=>!chosen.has(t.toLowerCase())&&t.toLowerCase().startsWith(needle)).map(t=>prefix+t)};export const usePrivateTagSuggestions=()=>({suggestions:{user:['legal','quarterly'],organization:['audit']},loading:false,error:null});`,
    '/src/hooks/useAnchorSubmissionStatus.ts': `export const useAnchorSubmissionStatus=publicId=>({status:!publicId?null:window.__layout.scenario==='status-held'?{action:'instant',instantStatus:'HELD',retryable:false}:window.__layout.scenario==='status-failed'?{action:'instant',instantStatus:'FAILED',retryable:false}:window.__layout.scenario==='status-no-intent'?{action:'instant',instantStatus:null,retryable:false}:window.__layout.scenario==='needs-credit'?{action:'instant',instantStatus:'NEEDS_CREDIT',retryable:true}:null,loading:false,error:null,refresh:async()=>({})});`,
    '/src/hooks/useBulkAnchors.ts': `export const useBulkAnchors = () => ({isProcessing:false,progress:35,processedCount:3,totalCount:10,error:null,createBulkAnchors:async records => {
      window.__layout.requests.push({kind:'bulk',records});
      return await new Promise(resolve => {window.__layout.finishBulk=()=>resolve({total:records.length,created:records.length,skipped:0,failed:0});});
    }});`,
    '/src/lib/switchboard.ts': 'export const isAIExtractionEnabled = async () => !["ai-off","child-instant","personal-zero","member-zero","status-held","status-failed","status-no-intent","status-loading","needs-credit"].includes(window.__layout.scenario); export const getFlag = async () => false;',
    '/src/lib/auditLog.ts': 'export const logAuditEvent = async () => {};',
    '/src/lib/fraudDetection.ts': 'export const detectFraudForDocument = async () => null; export const fraudResultToMetadata = () => ({});',
    '/src/lib/templateMapper.ts': 'export const applyTemplate = async fields => ({mappedFields:fields,unmappedFields:[]});',
    '/src/lib/aiExtraction.ts': `export async function runExtraction(file, fingerprint, type, progress) {
      const scenario=window.__layout.scenario;
      if(scenario==='extracting') return await new Promise(()=>{});
      if(scenario==='privacy-blocked' || scenario==='extraction-failed') {
        progress({stage:'error',progress:0,failClosed:scenario==='privacy-blocked',reasonCode:'timeout'});return null;
      }
      return {overallConfidence:0.9,fields:Array.from({length:14},(_,i)=>({key:'field'+i,value:'Long extracted value '+i+' '+('ReferenceWithoutSpaces'.repeat(8)),confidence:0.9,status:'pending'}))};
    }
    export const fetchTemplateReconstruction = async () => null;`,
    '/src/lib/supabase.ts': `
      const template={id:'${TEMPLATE_ID}',name:'LongTemplateIdentifier'.repeat(7),description:'A long template description for the responsive layout regression.',credential_type:'OTHER',is_system:true,org_id:null};
      function query(table){const q={};for(const method of ['select','eq','is','or','order','update'])q[method]=()=>q;
        q.insert=payload=>{window.__layout.requests.push({kind:table,payload});return q;};
        q.limit=async()=>({data:table==='credential_templates'?[template]:table==='anchor_private_tags'?[{tag:'legal'},{tag:'quarterly'}]:[],error:null});
        q.single=async()=>{if(window.__layout.scenario==='processing')await new Promise(resolve=>{window.__layout.finishInsert=resolve;});
          return window.__layout.scenario==='error'?{data:null,error:{message:'Unable to save. Please try again.'}}:{data:{id:'${ANCHOR_ID}',public_id:'ARK-'+'A'.repeat(40)},error:null};};
        q.maybeSingle=async()=>{if(window.__layout.scenario==='id-resolution-failed')return {data:null,error:{message:'read unavailable'}};window.__layout.requests.push({kind:'anchor-id-resolution',payload:{id:'${ANCHOR_ID}'}});return {data:{id:'${ANCHOR_ID}'},error:null};};return q;}
      export const supabase={from:query,auth:{getSession:async()=>({data:{session:{access_token:'${AAL2_TOKEN}',aal:'aal2',user:{id:'${USER_ID}',aud:'authenticated'}}},error:null})}};`,
  };
  if (scenario === 'mixed-fingerprinting') {
    modules['/src/lib/fileHasher.ts'] = 'export const generateFingerprint = async () => new Promise(()=>{});';
  }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
    if (url.pathname.startsWith('/api/')) {
      if (scenario === 'attestation-submitting' && url.pathname === '/api/v1/attestations') return; // Hold the boundary while asserting the in-flight state.
      const rawBody = route.request().postData();
      const payload = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : null;
      httpRequests.push({
        kind: `${route.request().method()} ${url.pathname}${url.search}`,
        ...(payload ? { payload } : {}),
        authorization: route.request().headers().authorization,
      });
      if (url.pathname === '/api/v1/anchor-credits/status') {
        const zero = scenario === 'personal-zero' || scenario === 'member-zero';
        const organization = url.searchParams.has('org_id');
        return route.fulfill({ json: {
          canSecureInstantly: instant || ['child-instant', 'personal-zero', 'member-zero', 'status-held', 'status-failed', 'status-no-intent', 'status-loading', 'needs-credit'].includes(scenario),
          creditBalance: zero ? 0 : 5,
          instantSecureCost: 1,
          scope: organization ? 'organization' : 'user',
          canPurchase: scenario !== 'member-zero',
          purchaseGuidance: scenario === 'member-zero' ? 'Ask an organization administrator to purchase credits.' : null,
        } });
      }
      if (url.pathname === '/api/v1/anchor-self-service') {
        if (scenario === 'error') return route.fulfill({ status: 503, json: { error: 'submission_unavailable' } });
        if (scenario === 'processing') return; // Hold only the submission, not capability reads.
        return route.fulfill({ status: 201, json: { public_id: 'ARK-FIXTURE', fingerprint: payload?.fingerprint, status: 'PENDING', action: payload?.action } });
      }
      if (url.pathname === '/api/v1/anchor-credits/purchase') {
        // Prove checkout survives an async session creation rather than relying
        // on transient user activation after the network response.
        if (scenario === 'personal-zero') await new Promise(resolve => setTimeout(resolve, 750));
        return route.fulfill({ json: { url: new URL('/e2e/fixtures/secure-dialog-layout.html?checkout=1', page.url()).toString() } });
      }
      if (url.pathname.includes('extract-batch')) {
        if (scenario === 'bulk-extracting') {
          await page.evaluate(() => new Promise<void>(resolve => { window.__layout.finishExtraction = resolve; }));
        }
        return route.fulfill({ status: 503, json: { message: 'Analysis unavailable. Try again.' } });
      }
      if (url.pathname === '/api/v1/anchor/bulk/self-service') {
        if (scenario === 'mixed-submitting') return; // Hold this request without a dangling browser evaluation.
        if (scenario === 'mixed-error') return route.fulfill({ status: 500, json: { error: 'Unable to submit these documents. Please retry.' } });
        if (scenario === 'mixed-blocked') return route.fulfill({ status: 403, json: {} });
        const rows = (payload?.anchors ?? []) as Array<{ fingerprint: string }>;
        return route.fulfill({ json: { queued: rows.length, duplicates: [], errors: [], anchors: rows.map((row, i) => ({ public_id: `ARK-${i}`, fingerprint: row.fingerprint })) } });
      }
      return route.fulfill({ json: { attestation_id: USER_ID, public_id: 'ARK-FIXTURE' } });
    }
    return route.continue();
  });
  await page.goto('/e2e/fixtures/secure-dialog-layout.html');
  await expect(page.getByRole('dialog')).toBeVisible();
  return { httpRequests };
}

/** Real geometry + actionability, not a CSS-class assertion or a jsdom approximation. */
export async function assertLayout(page: Page, testInfo: TestInfo, state: string) {
  const dialog = page.getByRole('dialog');
  await dialog.evaluate(async el => {
    await Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => { })));
  });
  const geometry = await dialog.evaluate(el => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: innerWidth, height: innerHeight,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
    };
  });
  const geometryPath = testInfo.outputPath(`${state}-geometry.json`);
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await testInfo.attach(`${state}-geometry`, { path: geometryPath, contentType: 'application/json' });
  await dialog.evaluate(el => new Promise<void>(resolve => {
    el.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.scrollTo({ top: 0, behavior: 'instant' });
      resolve();
    }));
  }));
  const screenshotPath = testInfo.outputPath(`${state}.png`);
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach(`${state}-screenshot`, { path: screenshotPath, contentType: 'image/png' });
  expect(geometry.left, `${state}: left margin`).toBeGreaterThanOrEqual(8);
  expect(geometry.right, `${state}: right margin`).toBeLessThanOrEqual(geometry.width - 8);
  expect(geometry.top, `${state}: top margin`).toBeGreaterThanOrEqual(8);
  expect(geometry.bottom, `${state}: bottom margin`).toBeLessThanOrEqual(geometry.height - 8);
  expect(geometry.scrollWidth, `${state}: dialog horizontal overflow`).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${state}: page horizontal overflow`).toBeLessThanOrEqual(geometry.width);
  const fields = dialog.locator('input:visible:not([type=file]), textarea:visible, select:visible');
  for (let i = 0; i < await fields.count(); i++) {
    const field = fields.nth(i);
    await field.scrollIntoViewIfNeeded();
    await field.focus();
    await expect(field).toBeFocused();
    const bounds = await field.boundingBox();
    expect(bounds?.x, `${state}: field left`).toBeGreaterThanOrEqual(geometry.left);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0), `${state}: field right`).toBeLessThanOrEqual(geometry.right);
    expect(bounds?.y, `${state}: field top`).toBeGreaterThanOrEqual(geometry.top);
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0), `${state}: field bottom`).toBeLessThanOrEqual(geometry.bottom);
  }
  const buttons = dialog.locator('button:visible:not(:disabled)');
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    await button.scrollIntoViewIfNeeded();
    // The active transparent file input is intentionally the click-anywhere picker.
    // Its visible label is also keyboard operable, but is not the pointer hit target.
    if (await button.textContent() === 'Select Document') continue;
    await button.click({ trial: true });
    await button.focus();
    await expect(button).toBeFocused();
    const bounds = await button.boundingBox();
    expect(bounds?.x, `${state}: button left`).toBeGreaterThanOrEqual(geometry.left);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0), `${state}: button right`).toBeLessThanOrEqual(geometry.right);
  }
  if (await dialog.evaluate(el => el.scrollHeight > el.clientHeight)) {
    await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const footerPath = testInfo.outputPath(`${state}-bottom.png`);
    await page.screenshot({ path: footerPath });
    await testInfo.attach(`${state}-bottom-screenshot`, { path: footerPath, contentType: 'image/png' });
  }
}
