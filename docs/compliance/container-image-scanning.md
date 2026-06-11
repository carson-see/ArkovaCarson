# Container-Image Vulnerability Scanning

**Control family:** CSA CCM / CAIQ — **TVM** (Threat & Vulnerability Management) + **IVS** (Infrastructure & Virtualization Security)
**Status:** Implemented (CI-enforced)
**Owner:** Engineering
**Last reviewed:** 2026-06-11

---

## 1. What this control closes

The CI pipeline already scans the **dependency graph** for CVEs and license
violations:

- `.github/workflows/sonatype-scan.yml` — Sonatype OSS Index over the npm
  dependency tree of each workspace, failing on CVSS ≥ 7 (HIGH).
- `.github/workflows/ci.yml` — `npm audit --audit-level=critical` (root +
  worker) and the GPL/AGPL/SSPL license deny-list.

These read `package.json` / `package-lock.json`. They do **not** see the
**OS / base-image layer** of the container that is actually built and shipped
to Cloud Run — the Alpine packages (`openssl`, `musl`, `busybox`, …) baked into
`node:20-alpine`. The CSA STAR / CAIQ self-assessment (TVM/IVS) flagged this:
dependency CVEs were covered, base-image CVEs were not.

This control adds a **container-image CVE scan** to the worker deploy pipeline
so the built image is scanned for OS-layer vulnerabilities **before it is pushed
or deployed**.

## 2. Scope and division of responsibility

| Layer | Scanner | Gate | Workflow |
|---|---|---|---|
| OS / base image (`apk` packages) | **Trivy** (`vuln-type: os`) | Fixable HIGH/CRITICAL → fail deploy | `deploy-worker.yml` |
| npm dependency graph (lockfile) | Sonatype OSS Index | CVSS ≥ 7 → fail PR | `sonatype-scan.yml` |
| npm dependency graph (lockfile) | `npm audit` | Critical → fail PR | `ci.yml` |

The Trivy image gate is intentionally scoped to **`vuln-type: os`** so it
complements — rather than double-gates — the dependency scanners that own the
library layer. See [§6 Follow-ups](#6-follow-ups) for the library-in-image
finding and the path to widening the gate.

## 3. How the gate works

In `deploy-worker.yml` the deploy job runs **build → scan → push → deploy**:

1. **Build image** — `docker build` on the runner, tagged `:<sha>` and `:latest`.
2. **Scan image for base-image CVEs (Trivy)** —
   `aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25` (v0.36.0,
   pinned to a 40-char commit SHA per the repo supply-chain convention):
   ```yaml
   image-ref: ${{ steps.build.outputs.image }}
   scan-type: image
   vuln-type: os
   severity: HIGH,CRITICAL
   ignore-unfixed: true
   exit-code: '1'
   ```
3. **Push image** — only runs if the scan passed (exit 0). A vulnerable image
   therefore never reaches Artifact Registry or Cloud Run.
4. **Deploy canary → promote** — unchanged.

**Gate semantics**

- **`severity: HIGH,CRITICAL` + `exit-code: '1'`** — a fixable HIGH or CRITICAL
  OS CVE fails the deploy. Mirrors the CVSS ≥ 7 gate in `sonatype-scan.yml`.
- **`ignore-unfixed: true`** — CVEs with **no upstream fix** are reported but do
  not gate. This is deliberate: an unpatchable base-image CVE must not be able
  to wedge every worker deploy. Such CVEs are tracked, not gated, and are
  addressed by moving off the affected base image.

## 4. Remediation workflow

When the gate fires, the image carries a **fixable** OS CVE. The fix is to
refresh the base-image packages. `services/worker/Dockerfile` does this in the
production stage:

```dockerfile
RUN apk upgrade --no-cache && apk add --no-cache python3 make g++
```

`apk upgrade` pulls the latest Alpine security patches for the pinned branch
(e.g. an `openssl`/`libssl3` fix published after the `node:20-alpine` tag was
cut) so the shipped image is current even when the upstream base tag lags. If a
fix is not yet in the Alpine repo, bump the base image to a patched digest.

## 5. Enforcement (anti-regression)

The scan step is a **non-removable invariant** of the deploy pipeline, guarded
at PR time by `scripts/ci/check-image-scan-gate.ts` (wired into the
`dependency-scan` job in `ci.yml`). The guard fails any PR that removes,
unpins, or weakens the gate. It asserts the scan step:

1. Uses a supported scanner (Trivy `aquasecurity/trivy-action` or Grype
   `anchore/scan-action`).
2. Is pinned to a full 40-char commit SHA (not a `@vN` / branch ref).
3. Fails the build on findings (Trivy `exit-code: '1'` / Grype `fail-build: true`).
4. Gates HIGH **and** CRITICAL severities.
5. Gates fixable CVEs only (`ignore-unfixed` / `only-fixed`).
6. Runs **after** `docker build` and **before** the deploy step.

There is **no override label** — this is a security control, not a style rule.
Unit tests: `scripts/ci/check-image-scan-gate.test.ts`.

## 6. Verification evidence (2026-06-11)

The worker image was built locally from `services/worker/Dockerfile` and scanned
with Trivy at the exact gate config (`--severity HIGH,CRITICAL --ignore-unfixed
--pkg-types os --exit-code 1`):

- **Before** the `apk upgrade` hardening: **2 fixable HIGH** OS CVEs —
  `CVE-2026-45447` (OpenSSL `PKCS7_verify()` heap use-after-free) in
  `libssl3`/`libcrypto3` `3.5.6-r0`, fixed in `3.5.7-r0`. Gate exit code **1**
  (deploy blocked) — control working as intended.
- **After** the `apk upgrade` hardening: **0** OS findings. Gate exit code **0**
  (deploy allowed).

This confirms the gate (a) detects real, shipping, fixable base-image CVEs and
(b) passes once the base image is patched.

## 7. Follow-ups

- **Library CVEs inside the image.** The full-image scan (`vuln-type: os,library`)
  additionally surfaced fixable HIGH library CVEs in the shipped `node_modules`
  (`glob`, `minimatch`, `tar`). These belong to the dependency layer
  (Sonatype / `npm audit`) and are tracked for a separate worker
  dependency-bump PR. Once that backlog is clear, widen the Trivy gate to
  `vuln-type: os,library` for defense-in-depth on the as-built image.
- **SARIF → GitHub Security tab.** Optionally add a second, non-gating Trivy run
  emitting SARIF and uploading via `github/codeql-action/upload-sarif` for
  centralized finding history (needs `security-events: write`).
- **Trivy DB rate limits.** If GHCR anonymous pulls of the Trivy vuln DB rate-limit
  in CI, pass a token to `aquasecurity/setup-trivy` (via the action's
  `token`/`trivy` inputs).

## 8. References

- `.github/workflows/deploy-worker.yml` — the scan gate (build → scan → push → deploy)
- `services/worker/Dockerfile` — base-image package refresh
- `scripts/ci/check-image-scan-gate.ts` — anti-regression guard
- `.github/workflows/sonatype-scan.yml` — dependency-graph CVE scan (library layer)
- `docs/compliance/csa-star-caiq-self-assessment.md` — TVM/IVS rows that cite this doc
- `docs/compliance/dependency-update-policy.md` — dependency remediation policy
- Trivy: https://trivy.dev/ · CCM v4: TVM-02/TVM-03, IVS-04
