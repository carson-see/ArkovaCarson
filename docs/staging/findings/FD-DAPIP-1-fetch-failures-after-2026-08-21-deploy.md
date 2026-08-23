# FD-DAPIP-1 — `/jobs/fetch-dapip` failing on the new prod revision, cause unresolved

**Filed:** 2026-08-21
**Severity:** Medium — a public-records ingestion job, not customer-facing and not
data-corrupting. Recorded because it appeared immediately after a deploy I made.
**Status:** OPEN. Causation not established either way.

## What changed

| Revision | fetch-dapip outcomes, 24 h |
|---|---|
| `arkova-worker-01313-ram` (old) | **100 × 200, 0 × 500** |
| `arkova-worker-01316-zit` (new) | **4 × 200, 6 × 500** |

The new revision went live ~13:26Z on 2026-08-21. Its **first** `fetch-dapip` run at
13:30:04Z failed, four then succeeded, and failures resumed from 14:20Z.

## The error

```
DAPIP fetch failed: fetch failed: certificate has expired
  caused by: Error: certificate has expired
    at TLSSocket.onConnectSecure (node:_tls_wrap:1699:34)
    at async fetchDapipInstitutions (file:///app/dist/jobs/dapipFetcher.js:108:23)
```

Target: `https://surveys.ope.ed.gov/dapip/api/search/advanced`.

## What I checked, and what it rules out

**The upstream certificate is valid.** Verified independently from outside GCP:

```
subject= /C=US/O=U.S. Department of Education/CN=ed.gov
issuer=  /C=US/O=DigiCert Inc/CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1
notBefore=Feb  5 00:00:00 2026 GMT
notAfter =Feb  7 23:59:59 2027 GMT
```

**Not a single bad backend, as far as I can see.** 12 independent TLS connections plus 12
HTTPS requests all returned `ssl_verify=0` (success). I could not reproduce the failure
from outside GCP at all.

**Not an obvious dependency cause.** The only `services/worker` delta in that deploy is
#2290's bump of 12 packages (`@aws-sdk/client-kms`, `@peculiar/asn1-*`, `@sentry/node`,
`@supabase/supabase-js`, `jose`, `resend`). None of these participate in Node's `fetch`
TLS path — undici and the CA store are built into Node, which this PR does not change.

## What remains unexplained

Two facts sit awkwardly together:

1. The old revision logged **zero** failures in 24 h; the new one fails ~60 % of runs. That
   correlation with the deploy is hard to dismiss.
2. The failure is **intermittent** (successes interleaved), which does *not* fit a stale CA
   bundle in the rebuilt image — that would fail consistently.

A plausible remaining hypothesis is that the rebuild pulled a newer base image whose trust
store or TLS defaults differ, and that the upstream presents different chains per edge node
depending on egress path — but **I have not verified either half**, and it should not be
written up as the cause until someone does.

## Why I did not roll prod back

The affected job is public-records ingestion. It is not customer-facing, does not corrupt
data, and that pipeline's feeder crons are already paused with a large pending backlog, so
it is not on the critical path. Rolling back a correctly-soaked dependency bump for a
non-critical ingestion job, on unresolved causation, is the worse trade.

## Correction to the record

When I first saw a single `fetch-dapip` 500 shortly after the deploy, I reported it as
transient on the basis of "29 × 200 vs 1 × 500 over 12 h". **That reading was wrong** — it
pooled both revisions. Split by revision the picture reverses: the old revision was clean
and the new one is not. The conclusion "no deploy-caused regression" was premature and is
withdrawn.

## Next steps for whoever picks this up

1. Get the container's view: exec/log the resolved certificate chain and the Node version
   and CA bundle in `arkova-worker-01316-zit`, and compare with `01313-ram`.
2. Check whether the Docker base image tag floated between the two builds.
3. If it is the base image, pin it — an unpinned base makes every rebuild a silent
   uncontrolled variable.
