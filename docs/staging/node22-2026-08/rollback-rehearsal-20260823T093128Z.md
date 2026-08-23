# PR #2291 rollback rehearsal — 2026-08-23T09:31:28Z

Post-close rehearsal on arkova-worker-node22-staging (clock sealed by /Users/carson/arkova-soak/node22/close-20260823T092836Z).

main head at rehearsal time: 5195af11528dcdbdac2356a51f2f93473d9bf223
!!! no AR tag for main head 5195af11528dcdbdac2356a51f2f93473d9bf223 — falling back to the PROD-SERVING digest:
    us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b
    (prod may trail main; record this substitution in the maturity record)

## Pre-deploy runtime proof of the rollback image (digest execution)
Unable to find image 'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b' locally
us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b: Pulling from arkova1/arkova-worker-images/arkova-worker
c2d2745206b4: Pulling fs layer
a78bfc92264a: Pulling fs layer
40606fb8f758: Pulling fs layer
959d1047641d: Pulling fs layer
bf7143f00435: Pulling fs layer
21674567d01d: Pulling fs layer
c6ab4dc73505: Pulling fs layer
40606fb8f758: Download complete
c6ab4dc73505: Download complete
c2d2745206b4: Download complete
959d1047641d: Download complete
21674567d01d: Download complete
bf7143f00435: Download complete
a78bfc92264a: Download complete
a78bfc92264a: Pull complete
40606fb8f758: Pull complete
959d1047641d: Pull complete
bf7143f00435: Pull complete
c6ab4dc73505: Pull complete
21674567d01d: Pull complete
c2d2745206b4: Pull complete
Digest: sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b
Status: Downloaded newer image for us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b
rollback-image runtime: v20.20.2
-> Node major 20 confirmed pre-deploy. PASS

## Deploy (creates a NEW revision — clock already sealed, see header)
Deploying container to Cloud Run service [arkova-worker-node22-staging] in project [arkova1] region [us-central1]
Deploying...
Creating Revision.............................................................................................................................................................................................................................................................................................................................................................done
Routing traffic.....done
Done.
Service [arkova-worker-node22-staging] revision [arkova-worker-node22-staging-00003-vey] has been deployed and is serving 100 percent of traffic.
Service URL: https://arkova-worker-node22-staging-270018525501.us-central1.run.app
The revision can be reached directly at https://rollback-node20---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app
new revision: arkova-worker-node22-staging-00003-vey
  rollback /api/health run 1: HTTP 200 0.779380s git_sha=5195af11528dcdbdac2356a51f2f93473d9bf223
  rollback /api/health run 2: HTTP 200 0.279374s git_sha=5195af11528dcdbdac2356a51f2f93473d9bf223
  rollback /api/health run 3: HTTP 200 0.282517s git_sha=5195af11528dcdbdac2356a51f2f93473d9bf223
-> rollback revision healthy (3/3 x 200). PASS
new revision status.imageDigest: us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:01e4592e2e0eccc2a08d6a8d71032596458393f89d5c6eec8d1acfbb203bd77b
rollback-digest runtime: v20.20.2
-> deployed rollback revision executes Node 20 by digest. PASS

## Restore traffic to arkova-worker-node22-staging-00001-8md
Updating traffic...
Routing traffic...........................done
Done.
URL: https://arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app
Traffic:
  100% arkova-worker-node22-staging-00001-8md
         pr-2291:         https://pr-2291---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app
  0%   arkova-worker-node22-staging-00003-vey
         rollback-node20: https://rollback-node20---arkova-worker-node22-staging-kvojbeutfa-uc.a.run.app
pr-2291 tag /api/health after restore: HTTP 200 0.213396s git_sha=f41192e061d72ef8866f19dbd50c16593ccbca23
-> arkova-worker-node22-staging-00001-8md back at 100%, serving the PR head. PASS
restored-digest runtime: v22.23.1
-> restored digest executes Node 22. PASS

---
Rehearsal record: /Users/carson/arkova-soak/node22/close-20260823T092836Z/rollback-rehearsal-20260823T093128Z.md
Fill 'Rollback rehearsed:' in the evidence block and the maturity template from this file.
Note for the record: rollback revision arkova-worker-node22-staging-00003-vey remains on the service until teardown
(teardown deletes the whole service; no cleanup needed here).
