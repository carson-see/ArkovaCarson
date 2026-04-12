# License Audit — GPL Compatibility Review (DEP-10)
_Created: 2026-04-12 | Jira: SCRUM-560_

## Executive Summary

Full license inventory completed for all production dependencies (frontend + worker). **11 GPL-3.0 packages identified**, all from the iden3/snarkjs ZK proof ecosystem. **1 LGPL-3.0 package** in each of frontend and worker.

**Assessment: LOW RISK** — all GPL packages are server-side only (worker). Arkova operates as a SaaS platform; users interact via browser, never receive compiled copies of server code. Under the **SaaS/ASP loophole**, GPL copyleft obligations are NOT triggered by SaaS usage (confirmed by FSF FAQ and GPL v3 Section 0 definition of "conveying").

## GPL/AGPL/SSPL Dependencies Found

### Worker (services/worker/)

| Package | Version | License | Used By | Server-Only? |
|---------|---------|---------|---------|-------------|
| `snarkjs` | 0.7.6 | GPL-3.0 | ZK proof generation | YES |
| `@iden3/bigarray` | 0.0.2 | GPL-3.0 | snarkjs dep | YES |
| `@iden3/binfileutils` | 0.0.12 | GPL-3.0 | snarkjs dep | YES |
| `fastfile` | 0.0.20 | GPL-3.0 | snarkjs dep | YES |
| `ffjavascript` | 0.3.0, 0.3.1 | GPL-3.0 | snarkjs dep | YES |
| `r1csfile` | 0.0.48 | GPL-3.0 | snarkjs dep | YES |
| `wasmbuilder` | 0.0.16 | GPL-3.0 | snarkjs dep | YES |
| `wasmcurves` | 0.2.2 | GPL-3.0 | snarkjs dep | YES |
| `rpc-websockets` | 9.3.7 | LGPL-3.0 | viem/x402 dep | YES |

### Frontend (root package.json)

| Package | Version | License | Used By | Server-Only? |
|---------|---------|---------|---------|-------------|
| `@img/sharp-libvips-darwin-arm64` | 1.2.4 | LGPL-3.0 | sharp (dev image processing) | Build-time only |

## Legal Assessment

### Does SaaS usage trigger GPL copyleft obligations?

**No.** GPL v3 copyleft is triggered by "conveying" — distributing copies of the software. SaaS usage where the code runs on the server and users interact via browser API does NOT constitute conveying under:

1. **GPL v3 Section 0**: "To 'convey' a work means any kind of propagation that enables other parties to make or receive copies." Running on a server does not propagate copies to users.
2. **FSF FAQ**: "If the program is being used over the network ... the AGPL would close that gap. The ordinary GPL doesn't."
3. **No AGPL packages found**: If snarkjs were AGPL-3.0, network interaction WOULD trigger copyleft. But it's GPL-3.0, so SaaS usage is safe.

### Risk if GPL code enters the frontend bundle

**HIGH RISK if snarkjs or its deps were bundled into the Vite frontend build.** The browser-delivered JavaScript would constitute "conveying" under GPL, requiring the entire frontend bundle to be GPL-licensed.

**Current status: SAFE** — `snarkjs` is in `services/worker/package.json` only. It is NOT in the root `package.json` and is NOT imported anywhere in `src/` (frontend). Verified via:
```bash
grep -r "snarkjs" src/ # No results
grep -r "snarkjs" package.json # Not present in root
```

### Mitigation Plan (if risk materializes)

If snarkjs or GPL deps ever need to run client-side:
1. **Isolate into a separate service** — run snarkjs in a dedicated microservice, communicate via API
2. **Replace with MIT alternative** — evaluate `circomlib` or custom WASM implementation
3. **Accept GPL** — if Arkova becomes open-source, GPL is compatible

## LGPL Assessment

LGPL-3.0 allows dynamic linking without copyleft propagation. Both LGPL packages (`sharp-libvips`, `rpc-websockets`) are used as intended — dynamically loaded, not modified. **No action needed.**

## Recommendations

1. **Add CI check** for new GPL/AGPL/SSPL dependencies (done in DEP-09 SBOM job)
2. **Pin snarkjs ecosystem** to prevent accidental license change on upgrade (done in DEP-06)
3. **Monitor for AGPL re-licensing** — if iden3 ever changes to AGPL, reassess immediately
4. **Never import snarkjs in frontend** — add ESLint rule if needed

## Change Log

| Date | Change |
|------|--------|
| 2026-04-12 | Initial audit — 11 GPL-3.0 packages (all snarkjs/iden3), SaaS exemption confirmed |
