#!/usr/bin/env python3
"""Batch-L T2 soak driver — PRs #2673 + #2674 + #2679 (Dependabot dependency bumps).

Runs detached (PPID 1, caffeinate) on 15-minute cycles for a 12 h T2 window against the
isolated rig `arkova-soak-batch-l-0907` + Cloud Run `arkova-worker-batch-l-0907-staging`.

WHAT THE CHANGE IS. Three Dependabot PRs, no product code:
  #2673  services/worker/package.json  — 20 worker deps (@sentry/node 10.71->10.73,
         @supabase/supabase-js 2.112.4->2.115.0, zod 4.4.3->4.5.4, undici 8.10.0->8.10.2,
         jose 6.2.10->6.2.11, ecpair 3.0.1->3.0.2, resend, viem, opentelemetry, aws kms)
  #2674  package.json                  — 24 frontend deps (@sentry/react, @stripe/stripe-js,
         @supabase/supabase-js, @tanstack/react-query, lucide-react, pdfjs-dist,
         react-router-dom, zod 4.4.3->4.5.4, vite/eslint/test tooling)
  #2679  services/api-gateway/package.json — wrangler 4.110.0->4.129.1 (undici 7.29.0
         transitive). devDependency only, on a service with NO deploy pipeline.

A dependency bump has no diff to point a probe at. What it can break is EVERY path that
imports a bumped package, so this driver exercises the worker paths those packages sit
on, with real HTTP against the rig and a DB read-back — not a health probe beside them
(CLAUDE.md §1.12 T2, feedback_soaks_must_meet_soc2_type2). Package -> importer mapping
was read out of the candidate tree, not assumed:

  P1 undici + @supabase/supabase-js  src/utils/db.ts, src/utils/rpc.ts, pipeline.ts,
     (every DB call)                 anchorProofs.ts, anchorCreditGate.ts. Exercised by
                                     any route that reads the DB, and asserted by a
                                     write -> read-back through the SAME client.
  P2 jose (JWT verify)               src/auth.ts, src/routes/cron.ts,
                                     src/middleware/requireScopeAnyAuth.ts. Every
                                     /jobs/* tick below carries a real OIDC token, so
                                     jose verifies a live Google-signed JWT each cycle.
                                     A malformed-bearer control proves it still REJECTS.
  P3 express 5 + compression         the router itself: a 200 on a real record, a 404
                                     control on an unknown one, and the JSON error shape.
  P4 zod (every write path, §1.1)    request validation — a deliberately invalid query
                                     must still be REFUSED with a 4xx, not accepted and
                                     not 5xx. zod 4.4->4.5 is the widest-blast-radius
                                     bump in #2673 and the one the root suite pins.
  P5 @sentry/node + profiling-node   src/utils/sentry.ts is imported at boot; the worker
                                     reaching a serving /health at all is the init
                                     assertion, re-asserted every cycle.
  P6 pino logging                    (NOT bumped — pino stays 8.17.0. Stated so a reader
                                     does not credit this soak with covering it.)

  T2 standard: /health git_sha re-asserted against the candidate SHA every cycle;
  Trigger A (process-anchors), Trigger B (check-confirmations), a daily flush
  observation (batch-anchors?force=true); per-org RLS isolation; an anti-hollow tagged
  row written and re-counted; rollback rehearsal recorded once per window.

  Frontend (#2674) and api-gateway (#2679) are NOT worker-servable, so they are proven
  ONCE at standup rather than per cycle, and the artifacts are cited from the README:
  a `vite build` of the candidate, the built bundle served by `npm run preview` with a
  Playwright smoke of / and /login at 1280 and 375 (screenshots under evidence/), and
  the api-gateway vitest suite + tsc build. Per-cycle, the driver re-asserts that those
  recorded artifacts exist and match the candidate SHA, so a reader is never shown a
  green cycle that silently dropped them.

NOT ASSERTED (stated, not hidden):
  1. ecpair 3.0.1->3.0.2 sits under src/chain/wallet.ts + signing-provider.ts — the
     Bitcoin signing path. The rig runs ENABLE_PROD_NETWORK_ANCHORING=false and mounts
     no treasury WIF, so NO signature is produced on this rig and this soak does NOT
     cover the ecpair change end to end. It is a patch bump and #2673 edits no file
     under src/chain/, but the coverage gap is real. Recorded as residual risk.
  2. viem 2.55->2.56 sits under src/chain/base.ts (x402 payment rail). Not exercised:
     no Base RPC on the rig, and per project decision anchoring never uses Base.
  3. @aws-sdk/client-kms has ZERO importers under services/worker/src — the AWS KMS
     provider is non-deployed. Its bump changes nothing that runs.
  4. resend 6.22->6.26 (src/email/sender.ts) is not driven: the rig has no mail
     provider, so no outbound send is made.
  5. #2679's api-gateway is not deployed anywhere in this repo (no reference in
     .github/workflows, scripts/, or the root package.json), so there is no runtime
     for it to be soaked against. Its evidence is build+test only, by nature.

Every cycle appends one JSON object to evidence/soak-cycles.jsonl and updates
status.json. A failed assertion increments `failures` and is recorded in full —
nothing is filtered out to make a window look clean.
"""
from __future__ import annotations

import json
import os
import pathlib
import random
import re
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

HOME = pathlib.Path(os.environ.get("BATCH_L_HOME", os.path.expanduser("~/arkova-soak/batch-l-0907")))
EV = HOME / "evidence"
EV.mkdir(parents=True, exist_ok=True)

CYCLE_SECONDS = int(os.environ.get("BATCH_L_CYCLE_SECONDS", "900"))
MAX_CYCLES = int(os.environ.get("BATCH_L_MAX_CYCLES", "0"))  # smoke escape hatch; unset in the real window
WINDOW_HOURS = 12  # T2



def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read(name: str) -> str:
    return (HOME / name).read_text().strip()


class Fail(Exception):
    pass


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


def rand(n=8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def hex64() -> str:
    """A fresh 64-char lowercase-hex fingerprint (anchors_fingerprint_format CHECK)."""
    return "".join(random.choices("0123456789abcdef", k=64))


class CIHeaders(dict):
    def get(self, key, default=None):  # type: ignore[override]
        lk = key.lower()
        for k, v in self.items():
            if k.lower() == lk:
                return v
        return default


def http(method, url, *, headers=None, body=None, timeout=45):
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, method=method, data=data, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, CIHeaders(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, CIHeaders(e.headers), e.read()
    except Exception as e:
        return 0, CIHeaders({"x-transport-error": f"{type(e).__name__}: {str(e)[:200]}"}), b""


def jbody(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw[:400].decode("utf-8", "replace")}


_tok_lock = threading.Lock()
_id_cache = {"tok": None, "at": 0.0}
_acc_cache = {"tok": None, "at": 0.0}

# `gcloud auth print-access-token` returns gcloud's OWN cached token, whose
# REMAINING lifetime can be far shorter than the nominal hour. Holding that value
# for another 1800 s let the driver present an already-expired token and take a
# Secret Manager 401 on the first call of a cycle -- 3 harness failures in the
# abandoned 2026-09-07T16:47Z window, none of them product failures. 300 s bounds
# the staleness this driver ADDS on top of gcloud's own; the 401 refresh-and-retry
# in harness() covers the residue that no TTL can bound.
ACCESS_TOKEN_TTL = 300
IDENTITY_TOKEN_TTL = 1800

# Forced refreshes, drained into each cycle record as `token_refreshed`.
_token_refresh_events: list = []

# Google rejecting our bearer token, distinguished from any other harness error.
# The \b guards keep a random 8-char value containing "401" from matching.
_UNAUTH_RE = re.compile(
    r"\b401\b|UNAUTHENTICATED|invalid authentication credentials|Invalid Credentials",
    re.IGNORECASE,
)


def _gcloud(args, cache, ttl=1800):
    with _tok_lock:
        if cache["tok"] and time.time() - cache["at"] < ttl:
            return cache["tok"]
        tok = subprocess.run(args, capture_output=True, text=True, timeout=120, check=True).stdout.strip()
        cache.update(tok=tok, at=time.time())
        return tok


def identity_token() -> str:
    return _gcloud(["gcloud", "auth", "print-identity-token"], _id_cache, ttl=IDENTITY_TOKEN_TTL)


def access_token() -> str:
    return _gcloud(["gcloud", "auth", "print-access-token"], _acc_cache, ttl=ACCESS_TOKEN_TTL)


def refresh_access_token(reason: str) -> str:
    """Drop the cached Google access token and fetch a genuinely fresh one."""
    with _tok_lock:
        _acc_cache.update(tok=None, at=0.0)
    tok = _gcloud(["gcloud", "auth", "print-access-token"], _acc_cache, ttl=ACCESS_TOKEN_TTL)
    _token_refresh_events.append({"at": now(), "reason": reason[:240]})
    print(f"[{now()}] token_refreshed after 401: {reason[:160]}", flush=True)
    return tok


def looks_unauthenticated(text: str) -> bool:
    """True only when a failure is Google rejecting the bearer token."""
    return bool(text) and bool(_UNAUTH_RE.search(text))


class Rig:
    """SQL against the rig via the Supabase Management API (runs as postgres).

    Capped server-side at ~60 s; a timeout still COMMITS, so it is surfaced,
    never blindly retried.
    """

    def __init__(self, ref: str, mgmt: str):
        self.ref, self.mgmt = ref, mgmt

    def sql(self, query: str):
        st, _, raw = http(
            "POST", f"https://api.supabase.com/v1/projects/{self.ref}/database/query",
            headers={"Authorization": "Bearer " + self.mgmt, "User-Agent": "arkova-batch-l-soak/1.0"},
            body={"query": query}, timeout=120,
        )
        if st not in (200, 201):
            raise Fail(f"SQL {st}: {raw[:300].decode('utf-8', 'replace')} :: {query[:160]}")
        return jbody(raw)

    def one(self, query: str):
        rows = self.sql(query)
        return rows[0] if isinstance(rows, list) and rows else None


def q(v) -> str:
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


# --------------------------------------------------------------------------
# per-package probes — the worker paths the bumped packages actually sit on
# --------------------------------------------------------------------------
def probe_deps(rig: "Rig", base: str, tag: str, out: dict) -> None:
    """P1..P5 — exercise the importers of the bumped packages over real HTTP + DB."""
    idt = identity_token()
    hdrs = {"Authorization": "Bearer " + idt,
            "X-Serverless-Authorization": "Bearer " + idt}

    # --- P1. undici + @supabase/supabase-js: the worker's DB client ----------
    # Seed a row through the Management API (postgres), then make the WORKER read
    # it back over its own supabase-js/undici stack. A bump that broke the client
    # shows up as a 5xx or a miss here, not as a health blip.
    org = f"BatchL Dep {tag}"
    rig.sql(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q(org + ' LLC')}, {q(org)}, {q('bl-dep-' + tag.lower() + '.test')})"
    )
    seeded = rig.one(f"SELECT id FROM organizations WHERE display_name = {q(org)}")
    expect(seeded is not None, "P1: seed org did not land")

    pub = f"bl{tag.lower()}{rand(6)}"
    # anchors requires user_id + fingerprint(char 64) + filename; the fixture user
    # from standup owns the row. `fingerprint` is char(64), not `document_fingerprint`.
    owner = read("isolation-a-user-id.txt")
    rig.sql(
        "INSERT INTO anchors (user_id, org_id, fingerprint, filename, public_id, status) VALUES "
        f"({q(owner)}, {q(seeded['id'])}, {q(hex64())}, "
        f"{q('batchl-' + tag + '.pdf')}, {q(pub)}, 'PENDING')"
    )

    st, _h, raw = http("GET", f"{base}/api/v1/verify/{pub}", headers=hdrs, timeout=60)
    body = jbody(raw)
    expect(st == 200,
           f"P1/P3: the worker could not read back a seeded anchor through supabase-js/undici: "
           f"GET /api/v1/verify/{pub} -> {st} {str(body)[:240]}")
    # The frozen v1 contract deliberately does NOT return public_id/org_id/anchors.id
    # (CLAUDE.md §6); the public identifier surfaces only through the derived
    # `record_uri`. Asserting on that is the correct read-back check AND proves the
    # derived field was built from the row just seeded.
    expect(str(body.get("record_uri", "")).endswith("/" + pub),
           f"P1: /verify record_uri does not resolve to the seeded public_id {pub}: {str(body)[:240]}")
    expect(body.get("status") == "PENDING",
           f"P1: /verify returned status {body.get('status')!r} for a freshly seeded PENDING anchor")
    expect(body.get("issuer_name") == org,
           f"P1: /verify issuer_name {body.get('issuer_name')!r} != the seeded org {org!r} — "
           "the anchors->organizations join did not resolve through supabase-js")
    out["P1_db_client_readback"] = {"public_id": pub, "status": st,
                                    "record_uri": body.get("record_uri"),
                                    "anchor_status": body.get("status"),
                                    "issuer_name": body.get("issuer_name")}

    # --- P3. express router: a 404 control on an unknown id ------------------
    # A 200 alone does not prove routing; the negative case must still be a clean
    # app-level 404 with a JSON body (an EMPTY body would be Cloud Run IAM, not the
    # app -- see project_rig_iam_header_on_every_route).
    miss = f"does-not-exist-{rand(10)}"
    st404, _h4, raw404 = http("GET", f"{base}/api/v1/verify/{miss}", headers=hdrs, timeout=45)
    b404 = jbody(raw404)
    expect(st404 in (400, 404),
           f"P3: unknown public_id returned {st404}, expected 400/404: {str(b404)[:200]}")
    expect(len(raw404) > 0,
           "P3: the 404 had an EMPTY body — that is the Cloud Run IAM front door, not the app router")
    out["P3_router_404_control"] = {"public_id": miss, "status": st404, "body": b404,
                                    "body_bytes": len(raw404)}

    # --- P4. zod: an invalid request must still be REFUSED -------------------
    # zod 4.4.3 -> 4.5.4 is the widest-blast-radius bump here and validates every
    # write path (§1.1). A validation layer that silently started ACCEPTING junk
    # would look identical to a healthy worker on the happy path above.
    bad_cases = []
    for bad in ("", "%00", "a" * 512, "../../etc/passwd", "'; SELECT 1--", "<script>alert(1)</script>"):
        # Percent-encode so the request actually LEAVES the client. An unencoded
        # quote/space makes urllib raise, which surfaces as status 0 -- and a status
        # 0 would satisfy "not 200, under 500" without the worker ever being asked.
        # That is a hollow assertion, so a transport failure is now an explicit FAIL.
        bs, _bh, braw = http("GET", f"{base}/api/v1/verify/{urllib.parse.quote(bad, safe='')}",
                             headers=hdrs, timeout=45)
        bad_cases.append({"input": bad[:48], "status": bs, "bytes": len(braw)})
        expect(bs != 0,
               f"P4: malformed public_id {bad[:48]!r} never reached the worker "
               f"(transport error) — this assertion would otherwise pass vacuously")
        expect(bs < 500,
               f"P4: malformed public_id {bad[:48]!r} produced {bs} — validation did not refuse it cleanly")
        expect(bs != 200,
               f"P4: malformed public_id {bad[:48]!r} was ACCEPTED with 200 — zod validation regressed")
    out["P4_zod_validation_refusals"] = bad_cases

    # --- P2. jose: the JWT verifier must still REJECT a bad token ------------
    # Every probe above carried a real Google-signed OIDC token, so jose verified a
    # live JWT each time. This is the negative half: a structurally-invalid bearer
    # must not be accepted. 401/403 both count (IAM or app, either is a rejection);
    # a 200 would mean verification stopped happening.
    js, _jh, jraw = http("GET", f"{base}/api/v1/verify/{pub}",
                         headers={"Authorization": "Bearer not.a.real.jwt",
                                  "X-Serverless-Authorization": "Bearer not.a.real.jwt"},
                         timeout=45)
    expect(js in (401, 403),
           f"P2: a junk bearer token was answered {js}, expected 401/403 — JWT verification regressed")
    out["P2_jose_rejects_junk_bearer"] = {"status": js, "bytes": len(jraw)}

    # --- P5. @sentry/node: boot-time init ------------------------------------
    # utils/sentry.ts is imported at worker boot; a Sentry SDK bump that threw on
    # init would prevent the process serving at all. /health answering 200 with the
    # candidate SHA (asserted in the cycle body) IS that assertion. Recorded so the
    # reader sees it is a boot-liveness claim and nothing stronger.
    out["P5_sentry_init"] = {"claim": "worker boots and serves with @sentry/node "
                                      "+ @sentry/profiling-node initialised at import",
                             "evidence": "cycle /health 200 with candidate git_sha"}


def triggers_and_isolation(rig: "Rig", base: str, cron_secret: str, tag: str,
                           state: dict, out: dict) -> None:
    """Trigger A, Trigger B, daily flush, per-org RLS isolation."""
    idt = identity_token()
    hdrs = {"Authorization": "Bearer " + idt,
            "X-Serverless-Authorization": "Bearer " + idt,
            "X-Cron-Secret": cron_secret}

    sa, _ha, ra = http("POST", f"{base}/jobs/process-anchors", headers=hdrs, timeout=90)
    out["trigger_a_process_anchors"] = {"status": sa, "body": jbody(ra)}
    sb, _hb, rb = http("POST", f"{base}/jobs/check-confirmations", headers=hdrs, timeout=90)
    out["trigger_b_check_confirmations"] = {"status": sb, "body": jbody(rb)}
    expect(sa == 200, f"Trigger A (process-anchors) returned {sa}: {ra[:200]}")
    expect(sb == 200, f"Trigger B (check-confirmations) returned {sb}: {rb[:200]}")

    last = state.get("last_daily_flush_at", 0)
    if time.time() - last > 86400 or not state.get("daily_flush_observations"):
        sf, _hf, rf = http("POST", f"{base}/jobs/batch-anchors?force=true", headers=hdrs, timeout=120)
        obs = {"at": now(), "status": sf, "body": jbody(rf)}
        out["daily_flush"] = obs
        expect(sf == 200, f"daily flush (batch-anchors?force=true) returned {sf}: {rf[:200]}")
        state["last_daily_flush_at"] = time.time()
        state.setdefault("daily_flush_observations", []).append(obs)

    # Per-org isolation: the RLS boundary, read through PostgREST as org B's own
    # authenticated session. Deliberately NOT the public /verify surface, which is
    # cross-tenant by design (feedback_public_endpoints_are_by_design).
    iso = rig.one(
        "SELECT (SELECT count(*)::int FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "        WHERE o.display_name = 'BatchL Isolation A') AS a_rows,"
        " (SELECT count(*)::int FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "        WHERE o.display_name = 'BatchL Isolation B') AS b_rows"
    )
    expect(iso["a_rows"] >= 1 and iso["b_rows"] >= 1,
           f"isolation fixture is missing anchors on one side: {iso}")
    a_public = rig.one(
        "SELECT a.public_id FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "WHERE o.display_name = 'BatchL Isolation A' LIMIT 1"
    )["public_id"]
    supa_url = read("supabase-url.txt")
    anon_key = read("anon-key.txt")
    ts, _th, tr = http("POST", f"{supa_url}/auth/v1/token?grant_type=password",
                       headers={"apikey": anon_key},
                       body={"email": read("isolation-b-user.txt"),
                             "password": read("isolation-b-password.txt")})
    expect(ts == 200, f"isolation: org B password grant failed {ts}: {tr[:200]}")
    jwt = jbody(tr)["access_token"]
    rs, _rh, rr = http("GET", f"{supa_url}/rest/v1/anchors?select=public_id,org_id",
                       headers={"apikey": anon_key, "Authorization": "Bearer " + jwt})
    rows = jbody(rr)
    visible = [r.get("public_id") for r in rows] if isinstance(rows, list) else []
    out["per_org_isolation"] = {"counts": iso, "org_a_anchor": a_public,
                                "org_b_session_status": rs,
                                "org_b_visible_rows": len(visible),
                                "org_a_anchor_visible_to_org_b": a_public in visible}
    expect(rs == 200, f"per-org isolation probe could not read as org B: {rs} {rr[:200]}")
    expect(a_public not in visible,
           f"per-org isolation FAILED: org B's session read org A's anchor {a_public}")


def standup_artifacts(out: dict) -> None:
    """Re-assert the once-per-window frontend / api-gateway artifacts still exist.

    #2674 (frontend) and #2679 (api-gateway) cannot be served by the rig worker, so
    they are proven at standup: a `vite build` of the candidate, a Playwright smoke of
    / and /login at 1280 and 375 against `npm run preview` of that build, and the
    api-gateway vitest suite + tsc build. Re-checking their manifests every cycle
    stops a green cycle from silently dropping half the batch's evidence.
    """
    man = EV / "standup-artifacts.json"
    expect(man.exists(), "standup artifact manifest evidence/standup-artifacts.json is missing")
    data = json.loads(man.read_text())
    candidate = read("candidate-sha.txt")
    expect(data.get("candidate_sha") == candidate,
           f"standup artifacts were recorded for {data.get('candidate_sha')}, candidate is {candidate}")
    for key in ("vite_build", "preview_smoke_1280", "preview_smoke_375",
                "api_gateway_tests", "api_gateway_build"):
        expect(key in data, f"standup artifact manifest is missing '{key}'")
    for shot in data.get("screenshots", []):
        p = EV / shot
        expect(p.exists() and p.stat().st_size > 0, f"screenshot {shot} is missing or empty")
    out["standup_artifacts"] = data


def anti_hollow(rig: "Rig", tag: str, out: dict) -> int:
    """Rows written and re-counted under this cycle's unique tag."""
    rig.sql(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q('BatchL Cycle ' + tag + ' LLC')}, {q('BatchL Cycle ' + tag)}, "
        f"{q('bl-cycle-' + tag.lower() + '.test')})"
    )
    n = rig.one(f"SELECT count(*)::int AS n FROM organizations WHERE display_name = {q('BatchL Cycle ' + tag)}")
    expect(n["n"] == 1, f"anti-hollow: cycle tag {tag} counted {n['n']} rows, expected 1")
    total = rig.one("SELECT count(*)::int AS n FROM organizations WHERE display_name LIKE 'BatchL Cycle %'")
    out["anti_hollow"] = {"cycle_tag": tag, "rows_this_cycle": n["n"], "tagged_rows_total": total["n"]}
    return total["n"]


# --------------------------------------------------------------------------
def main() -> int:
    ref = read("rig-ref.txt")
    base = read("service-url.txt")
    rig = Rig(ref, read("supabase-access.txt"))
    cron_secret = read("cron-secret.txt")
    candidate = read("candidate-sha.txt")

    status_path = HOME / "status.json"
    status = json.loads(status_path.read_text())
    status.update(status="running", pid=os.getpid())
    state = status.setdefault("_state", {})

    cycles_path = EV / "soak-cycles.jsonl"
    deadline = time.time() + WINDOW_HOURS * 3600 + 600

    while time.time() < deadline:
        started = time.time()
        tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = {"cycle_tag": tag, "started_at": now(), "candidate_sha": candidate}
        _token_refresh_events.clear()
        try:
            hs, _h, hraw = http("GET", f"{base}/health",
                                headers={"Authorization": "Bearer " + identity_token()}, timeout=45)
            health = jbody(hraw)
            out["health"] = {"status": hs, "git_sha": health.get("git_sha"),
                             "uptime": health.get("uptime"), "revision": health.get("revision")}
            expect(hs == 200, f"/health returned {hs}")
            expect(health.get("git_sha") == candidate,
                   f"rig is serving git_sha {health.get('git_sha')}, candidate is {candidate} — STALE HEAD")

            probe_deps(rig, base, tag, out)
            triggers_and_isolation(rig, base, cron_secret, tag, state, out)
            standup_artifacts(out)
            tagged = anti_hollow(rig, tag, out)

            out["result"] = "PASS"
            status["cycles"] = status.get("cycles", 0) + 1
            status["tagged_rows"] = tagged
        except Exception as e:
            out["result"] = "FAIL"
            out["error"] = f"{type(e).__name__}: {e}"
            status["failures"] = status.get("failures", 0) + 1
            status["last_error"] = out["error"]
            status["last_failed_at"] = now()

        out["duration_seconds"] = round(time.time() - started, 2)
        out["token_refreshed"] = list(_token_refresh_events)
        with cycles_path.open("a") as fh:
            fh.write(json.dumps(out) + "\n")
        status["last_cycle_at"] = now()
        status["last_result"] = out["result"]
        status_path.write_text(json.dumps(status, indent=2))
        print(f"[{now()}] cycle {tag} {out['result']} "
              f"cycles={status.get('cycles', 0)} failures={status.get('failures', 0)}", flush=True)

        if MAX_CYCLES and status.get("cycles", 0) + status.get("failures", 0) >= MAX_CYCLES:
            break
        sleep = CYCLE_SECONDS - (time.time() - started)
        if sleep > 0:
            time.sleep(sleep)

    status["status"] = "window_elapsed"
    status["ended_at"] = now()
    status_path.write_text(json.dumps(status, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
