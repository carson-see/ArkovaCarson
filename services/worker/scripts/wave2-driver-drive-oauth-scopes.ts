#!/usr/bin/env -S npx tsx
/**
 * Wave 2 T2 soak driver — #2245 (fix/oauth-minimal-drive-scopes).
 *
 * Proves buildAuthorizationUrl() (a) requests exactly the three minimal
 * scopes and no more, (b) never sends include_granted_scopes (the inherited-
 * scope leak — FULLSOAK 2026-08 shared-resource register #9, a single
 * connect observed minting a 33-scope token), and (c) that no runtime
 * consumer in the worker actually depends on any of the previously-
 * inherited-but-now-absent scopes (gmail.modify, calendar, contacts,
 * classroom.*, chat.*) — i.e. dropping the leak doesn't silently break a
 * caller that was (knowingly or not) relying on the wider grant.
 */
import { execSync } from 'node:child_process';
import { buildAuthorizationUrl, DRIVE_DEFAULT_SCOPES } from '../src/integrations/oauth/drive.js';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
}

check(
  'DRIVE_DEFAULT_SCOPES is exactly 3 scopes',
  DRIVE_DEFAULT_SCOPES.length === 3,
);
check(
  'DRIVE_DEFAULT_SCOPES contains only drive.file, drive.activity.readonly, userinfo.email',
  DRIVE_DEFAULT_SCOPES.every((s) =>
    s.endsWith('/drive.file') || s.endsWith('/drive.activity.readonly') || s.endsWith('/userinfo.email'),
  ),
);

const url = buildAuthorizationUrl({
  redirectUri: 'https://app.arkova.ai/oauth/drive/callback',
  state: 'wave2-driver-state-token',
  env: {
    GOOGLE_OAUTH_CLIENT_ID: 'wave2-driver-fake-client-id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'wave2-driver-fake-secret',
  } as NodeJS.ProcessEnv,
});
const parsed = new URL(url);

check(
  'authorization URL never includes include_granted_scopes at all',
  !parsed.searchParams.has('include_granted_scopes'),
);
const requestedScopes = (parsed.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
check(
  'authorization URL scope param carries exactly the 3 default scopes, nothing more',
  requestedScopes.length === 3 && requestedScopes.every((s) => DRIVE_DEFAULT_SCOPES.includes(s)),
);
check(
  'authorization URL does NOT carry any of the previously-inherited broad scopes',
  !url.includes('gmail.modify') &&
    !url.includes('/calendar') &&
    !url.includes('/contacts') &&
    !url.includes('classroom') &&
    !url.includes('chat.'),
);

// Static consumer check: grep the worker source for any reference to the
// previously-inherited scopes' corresponding APIs, to confirm nothing was
// silently relying on the wider grant this fix removes.
const droppedScopeApis = ['gmail.modify', 'googleapis.com/calendar', 'people.googleapis.com', 'classroom.googleapis.com', 'chat.googleapis.com'];
let foundConsumer = false;
for (const marker of droppedScopeApis) {
  try {
    // -F fixed-string, grep every match with its own line so comment-only
    // hits (this PR's own incident-documentation comments/tests) can be
    // told apart from a real fetch()/URL call to the API host.
    const out = execSync(
      `grep -rn --include="*.ts" -F ${JSON.stringify(marker)} src/ 2>/dev/null || true`,
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim();
    if (!out) continue;
    const realCallSites = out
      .split('\n')
      .filter((line) => {
        const codePart = line.split(':').slice(2).join(':').trim();
        // A comment-only reference (incident documentation / test names
        // describing the fix) does not count as a runtime consumer.
        return !codePart.startsWith('//') && !codePart.startsWith('*');
      });
    if (realCallSites.length > 0) {
      console.log(`  found REAL (non-comment) reference to dropped-scope API "${marker}":\n    ${realCallSites.join('\n    ')}`);
      foundConsumer = true;
    } else {
      console.log(`  "${marker}" appears only in incident-documentation comments/test descriptions (${out.split('\n').length} line(s)) — not a runtime consumer`);
    }
  } catch {
    // grep exits non-zero on no match; treated as "not found" above via `|| true`.
  }
}
check(
  'no worker source file references any API that needed the now-dropped inherited scopes',
  !foundConsumer,
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
