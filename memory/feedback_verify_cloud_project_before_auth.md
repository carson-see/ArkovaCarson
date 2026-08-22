---
name: verify-cloud-project-before-auth
description: A gcloud "permission denied" usually means the project ID is wrong, not that credentials expired. Verify the project exists before concluding anything about auth — and never route it to Carson as a reauth request.
type: feedback
---

The GCP project is **`arkova1`**. Every `gcloud` invocation needs `--project=arkova1`.

When a `gcloud` call fails in a way that looks like credentials, **verify the project exists
before concluding anything about authentication**:

```
gcloud projects list
```

**Why:** on 2026-08-21 a project ID of `arkova-mvp` was used — derived from the repo directory
name `arkova-mvpcopy-main`. **That project has never existed.** Cloud Run reports a nonexistent
project as a **permission denied**, which reads exactly like an expired credential, so the
conclusion drawn was "we are partly blind on prod, Carson must run an interactive
`gcloud auth login`." That was reported for roughly 24 hours, it was false, and it violated
`memory/feedback_worker_hands_off.md`'s sibling principle that operator time is not the first
resort. Nothing was wrong with auth: the active service account
`270018525501-compute@developer.gserviceaccount.com` works and holds `roles/owner`. The Logging
API is the honest surface — it says `NOT_FOUND: projects/arkova-mvp does not exist` — while
Cloud Run masks the same condition as an access problem.

**How to apply:**
- Never infer a cloud project, dataset, or bucket ID from a local directory name. Read it from
  a deploy workflow (`.github/workflows/deploy-worker.yml`) or `gcloud projects list`.
- Treat a `gcloud` permission error as **ambiguous** until the project is confirmed to exist.
  Check the project first; check credentials second.
- **An empty result from the wrong project is a `NOT_FOUND` artifact, never "zero events."**
  Do not read it as evidence of absence — that inverts the meaning of a security or outage query.
- The same reasoning applies to any inherited "I do not have access to X" claim. Re-test it in
  the current session before repeating it; two such claims (gcloud and the Supabase MCP) were
  both self-inflicted and both false.
- `timeout` is not on `PATH` on macOS (it is GNU coreutils, i.e. `gtimeout`). A command prefixed
  with it fails as `command not found`, which is easily misread as the query itself failing.

**Enforcement:** Documentation only. There is no reliable detector for "the operator used the
wrong project ID," and a lint that pattern-matched project strings would fire on legitimate
multi-project work. This is human judgement, recorded because it cost about a day.
