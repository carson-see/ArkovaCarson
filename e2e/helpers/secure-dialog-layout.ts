import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';

declare global {
  interface Window {
    __layout: {
      scenario: string;
      instant: boolean;
      requests: Array<{ kind: string; payload?: Record<string, unknown>; records?: unknown[] }>;
      finishBulk?: () => void;
      finishExtraction?: () => void;
    };
  }
}

export const LONG_NAME = `${'document-with-a-long-filename-'.repeat(6)}.pdf`;
const USER_ID = 'b1111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = 'b2222222-2222-4222-8222-222222222222';

/** Only I/O and account/capability boundaries are mocked; all layout components run unchanged. */
export async function openLayoutFixture(page: Page, scenario = 'review', instant = false) {
  await page.addInitScript(({ scenario, instant }) => {
    Object.assign(window, { __layout: { scenario, instant, requests: [] } });
  }, { scenario, instant });
  const modules: Record<string, string> = {
    '/src/hooks/useAuth.ts': `export const useAuth = () => ({user:{id:'${USER_ID}'}});`,
    '/src/hooks/useAuth.tsx': `export const useAuth = () => ({user:{id:'${USER_ID}'}});`,
    '/src/hooks/useProfile.ts': 'export const useProfile = () => ({profile:{org_id:null}});',
    '/src/hooks/useProfile.tsx': 'export const useProfile = () => ({profile:{org_id:null}});',
    '/src/hooks/useAuditorMode.ts': 'export const useAuditorMode = () => ({isAuditorMode:false});',
    '/src/hooks/useAuditorMode.tsx': 'export const useAuditorMode = () => ({isAuditorMode:false});',
    '/src/hooks/useSecuringCapability.ts': 'export const useSecuringCapability = () => ({capability:{canSecureInstantly:window.__layout.instant,creditBalance:5,instantSecureCost:1}});',
    '/src/hooks/useBulkAnchors.ts': `export const useBulkAnchors = () => ({isProcessing:false,progress:35,processedCount:3,totalCount:10,error:null,createBulkAnchors:async records => {
      window.__layout.requests.push({kind:'bulk',records});
      return await new Promise(resolve => {window.__layout.finishBulk=()=>resolve({total:records.length,created:records.length,skipped:0,failed:0});});
    }});`,
    '/src/lib/switchboard.ts': 'export const isAIExtractionEnabled = async () => window.__layout.scenario !== "ai-off"; export const getFlag = async () => false;',
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
      function query(table){const q={};for(const method of ['select','eq','is','or','order','limit','update'])q[method]=()=>q;
        q.insert=payload=>{window.__layout.requests.push({kind:table,payload});return q;};
        q.then=resolve=>Promise.resolve({data:table==='credential_templates'?[template]:[],error:null}).then(resolve);
        q.single=async()=>{if(window.__layout.scenario==='processing')await new Promise(resolve=>{window.__layout.finishInsert=resolve;});
          return window.__layout.scenario==='error'?{data:null,error:{message:'Unable to save. Please try again.'}}:{data:{id:'${USER_ID}',public_id:'ARK-'+'A'.repeat(40)},error:null};};return q;}
      export const supabase={from:query,auth:{getSession:async()=>({data:{session:{access_token:'fixture-session',user:{id:'${USER_ID}'}}},error:null})}};`,
    '/src/lib/workerClient.ts': `export const WORKER_URL=''; export async function workerFetch(path, options){
      window.__layout.requests.push({kind:path,payload:JSON.parse(options.body||'{}')});
      if(path.includes('extract-batch')) {
        if(window.__layout.scenario==='bulk-extracting') await new Promise(resolve=>{window.__layout.finishExtraction=resolve;});
        return {ok:false,status:503,json:async()=>({message:'Analysis unavailable. Try again.'})};
      }
      if(window.__layout.scenario==='mixed-submitting') await new Promise(resolve=>{window.__layout.finishMixed=resolve;});
      if(window.__layout.scenario==='mixed-error') return {ok:false,status:500,json:async()=>({error:'Unable to submit these documents. Please retry.'})};
      if(window.__layout.scenario==='mixed-blocked') return {ok:false,status:403};
      const rows=JSON.parse(options.body).anchors;
      return {ok:true,json:async()=>({queued:rows.length,duplicates:[],errors:[],anchors:rows.map((row,i)=>({public_id:'ARK-'+i,fingerprint:row.fingerprint}))})};
    }`,
  };
  if (scenario === 'mixed-fingerprinting') {
    modules['/src/lib/fileHasher.ts'] = 'export const generateFingerprint = async () => new Promise(()=>{});';
  }
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    if (modules[url.pathname]) return route.fulfill({ contentType: 'application/javascript', body: modules[url.pathname] });
    if (url.pathname.startsWith('/api/')) {
      if (scenario === 'attestation-submitting') return; // Hold the boundary while asserting the in-flight state.
      return route.fulfill({ json: { attestation_id: USER_ID, public_id: 'ARK-FIXTURE' } });
    }
    return route.continue();
  });
  await page.goto('/e2e/fixtures/secure-dialog-layout.html');
  await expect(page.getByRole('dialog')).toBeVisible();
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
left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
};
  });
  const geometryPath = testInfo.outputPath(`${state}-geometry.json`);
  await writeFile(geometryPath, JSON.stringify(geometry, null, 2));
  await testInfo.attach(`${state}-geometry`, { path: geometryPath, contentType: 'application/json' });
  await dialog.evaluate(el => { el.scrollTop = 0; });
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
