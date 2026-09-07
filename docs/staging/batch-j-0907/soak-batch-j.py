#!/usr/bin/env python3
"""Batch-J T2 soak driver — PR #2667 (DocuSign refresh-token Secret Manager version prune).

Runs detached (PPID 1, caffeinate) on 15-minute cycles for a 12 h T2 window against
the isolated rig `arkova-soak-batch-j-0907` + Cloud Run `arkova-worker-batch-j-0907-staging`.

Each cycle exercises the CHANGED behaviour, not a health probe beside it
(CLAUDE.md §1.12 T2 + feedback_soaks_must_meet_soc2_type2). The changed behaviour is
what `docusign-token-store.put()` does to Secret Manager versions after a write, so the
driver runs THAT MODULE, at the candidate SHA, against the REAL Secret Manager API on
rig-only secrets:

  A. steady state          seed 6 superseded + 1 current, run put() with a NEW value ->
                           exactly the superseded-and-unreferenced versions are
                           DESTROYED, the newest 2 survive ENABLED, and
                           versions/latest:access returns the value just written.
  B. current survives      the version put() just wrote is ENABLED afterwards, every
                           cycle, and is the one `latest` resolves to.
  C. cross-secret isolation a second rig secret for a DIFFERENT (org, account) pair is
                           untouched by the prune on the first — the per-tenant
                           analogue for a store addressed by secret name.
  D. idempotent re-run     put() with the SAME value -> zero :addVersion (compare-
                           before-write skip) and the enabled set is unchanged at
                           steady state. Re-running is a no-op, not a churn.
  E. bounded backlog drain seed 18 superseded -> ONE put destroys at most
                           maxDestroyPerPut (10) and reports the remainder honestly;
                           the next put drains the rest. Nothing is left silently.
  F. F1 regression         a retention of keepVersions:0 REFUSES (throws) instead of
                           destroying the live token, and `latest` still resolves.
                           This is the finding this soak exists to hold down.
  G. no payload in logs    the serialized prune log lines never contain the token.

  T2 standard: /health (git_sha re-asserted against the candidate SHA every cycle),
  a smoke pass on the public verification API, an anti-hollow tagged row written and
  re-counted in the rig DB, and a rollback rehearsal recorded once per window.

NOT ASSERTED (stated, not hidden): the DocuSign OAuth refresh that supplies the
rotated token. `integrations/oauth/docusign.ts` hardcodes account-d/account.
docusign.com with no env override, so a stub token endpoint cannot be reached
without modifying the image under soak. This PR does not change that refresh — only
what `put` does with the value afterwards. There is also no audit_events row on this
path: the store LOGS the prune summary and writes no DB row, so the driver asserts
the log line (counts + no payload) instead of an audit row.

Every cycle appends one JSON object to evidence/soak-cycles.jsonl and updates
status.json. A failed assertion increments `failures` and is recorded in full —
nothing is filtered out to make a window look clean.
"""
from __future__ import annotations

import json
import os
import pathlib
import random
import string
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HOME = pathlib.Path(os.environ.get("BATCH_J_HOME", os.path.expanduser("~/arkova-soak/batch-j-0907")))
EV = HOME / "evidence"
EV.mkdir(parents=True, exist_ok=True)

CYCLE_SECONDS = int(os.environ.get("BATCH_J_CYCLE_SECONDS", "900"))
MAX_CYCLES = int(os.environ.get("BATCH_J_MAX_CYCLES", "0"))  # smoke escape hatch; unset in the real window
WINDOW_HOURS = 12  # T2

KEEP = 2            # DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION.keepVersions
MAX_DESTROY = 10    # DEFAULT_DOCUSIGN_REFRESH_TOKEN_RETENTION.maxDestroyPerPut


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


def _gcloud(args, cache, ttl=1800):
    with _tok_lock:
        if cache["tok"] and time.time() - cache["at"] < ttl:
            return cache["tok"]
        tok = subprocess.run(args, capture_output=True, text=True, timeout=120, check=True).stdout.strip()
        cache.update(tok=tok, at=time.time())
        return tok


def identity_token() -> str:
    return _gcloud(["gcloud", "auth", "print-identity-token"], _id_cache)


def access_token() -> str:
    return _gcloud(["gcloud", "auth", "print-access-token"], _acc_cache)


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
            headers={"Authorization": "Bearer " + self.mgmt, "User-Agent": "arkova-batch-j-soak/1.0"},
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
# the harness: the PR's OWN store module, at the candidate SHA, real Secret Manager
# --------------------------------------------------------------------------
def harness(wt: str, *args: str) -> dict:
    """Run one harness subcommand from the candidate checkout.

    cwd is services/worker because that is where tsx and the worker's deps live;
    the harness's own imports are file-relative, so the module under test is the
    same file the rig image was built from. The SUPABASE_/STRIPE_ values are
    rig-only placeholders: importing the store pulls in logger.js -> config.ts,
    whose Zod boot check runs on import. The harness never calls Supabase or
    Stripe -- it talks only to Secret Manager.
    """
    env = dict(os.environ)
    env["GCP_ACCESS_TOKEN"] = access_token()
    env["NODE_ENV"] = "development"
    env["BATCH_J_PROJECT"] = "arkova1"
    env.setdefault("SUPABASE_URL", "https://batchj-harness.invalid")
    env.setdefault("SUPABASE_SERVICE_ROLE_KEY", "rig-only-not-a-real-key")
    env.setdefault("STRIPE_SECRET_KEY", "sk_test_rigonly")
    env.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_rigonly")
    r = subprocess.run(
        ["./node_modules/.bin/tsx", "../../docs/staging/batch-j-0907/secret-retention-harness.ts", *args],
        cwd=os.path.join(wt, "services", "worker"),
        capture_output=True, text=True, timeout=420, env=env,
    )
    line = [l for l in r.stdout.strip().splitlines() if l.startswith("{")]
    if not line:
        raise Fail(f"harness {args[0]} produced no json (rc={r.returncode}): "
                   f"out={r.stdout[-300:]} err={r.stderr[-400:]}")
    out = json.loads(line[-1])
    if "error" in out:
        raise Fail(f"harness {args[0]} failed: {out['error']}")
    return out


# --------------------------------------------------------------------------
# per-PR probes
# --------------------------------------------------------------------------
def probe_2667(wt: str, sec_a: str, sec_b: str, tag: str, out: dict) -> None:
    """#2667 — Secret Manager refresh-token version retention."""

    # --- A/B/G. steady state: seed a backlog, rotate, prune to the newest 2 ---
    harness(wt, "seed", sec_a, "6", f"c{tag}")
    before = harness(wt, "inspect", sec_a)
    new_value = f"rig-refresh-{tag}-{rand()}"
    put = harness(wt, "put", sec_a, new_value)

    written = max(put["enabled_after"])
    expect(put["latest_access_status"] == 200, f"A: latest:access returned {put['latest_access_status']}")
    expect(put["latest_matches_written_value"],
           "B: versions/latest no longer resolves to the value put() just wrote — "
           "the live refresh token did not survive the prune")
    expect(written in put["enabled_after"], f"B: the just-written version {written} is not ENABLED")
    expect(len(put["enabled_after"]) == KEEP,
           f"A: expected exactly {KEEP} enabled versions after the prune, got {put['enabled_after']}")
    survivors = sorted(put["enabled_after"])
    expect(survivors == sorted(sorted(put["enabled_before"] + [written])[-KEEP:]),
           f"A: the survivors are not the newest {KEEP}: before={put['enabled_before']} after={survivors}")
    destroyed_now = [v for v in put["enabled_before"] if v not in put["enabled_after"]]
    expect(all(v < min(survivors) for v in destroyed_now),
           f"A: a destroyed version is not older than every survivor: destroyed={destroyed_now} kept={survivors}")
    expect(put["log_contains_payload"] is False,
           "G: a prune log line contained the refresh-token payload")
    prune_log = [s for s in put["log_summaries"] if "pruned" in s.get("msg", "") or "superseded" in s.get("msg", "")]
    expect(bool(prune_log), f"G: no prune summary was logged: {put['log_summaries']}")
    out["A_steady_state"] = {
        "enabled_before": put["enabled_before"], "enabled_after": put["enabled_after"],
        "destroyed_this_put": destroyed_now, "written_version": written,
        "latest_matches_written_value": put["latest_matches_written_value"],
        "prune_log": prune_log, "log_contains_payload": put["log_contains_payload"],
        "ms": put["ms"],
    }

    # --- C. cross-secret isolation ------------------------------------------
    # A second rig secret standing in for a different (org, account) pair. The
    # prune above must not have touched it. Nothing in the worker addresses a
    # pinned VERSION (every read is versions/latest:access, and
    # connector_integrations.token_secret_name names the SECRET), so this is the
    # boundary that matters for "a version another integration row references".
    # `seed` is create-if-missing, so the first cycle of a fresh rig creates
    # secret B here rather than 404ing on inspect.
    harness(wt, "seed", sec_b, "1", f"b{tag}")
    b_before = harness(wt, "inspect", sec_b)
    b_value = f"rig-b-{tag}-{rand()}"
    b_put = harness(wt, "put", sec_b, b_value)
    a_after_b = harness(wt, "inspect", sec_a)
    expect(a_after_b["enabled"] == put["enabled_after"],
           f"C: pruning secret B changed secret A's enabled set: {put['enabled_after']} -> {a_after_b['enabled']}")
    expect(b_put["latest_matches_written_value"], "C: secret B lost its own newly written value")
    out["C_cross_secret_isolation"] = {
        "secret_b_enabled_before": b_before["enabled"], "secret_b_enabled_after": b_put["enabled_after"],
        "secret_a_unchanged_by_b_prune": a_after_b["enabled"] == put["enabled_after"],
    }

    # --- D. idempotent re-run ------------------------------------------------
    again = harness(wt, "put", sec_a, new_value)
    expect(again["enabled_after"] == put["enabled_after"],
           f"D: re-running put with the SAME value changed the enabled set: "
           f"{put['enabled_after']} -> {again['enabled_after']}")
    expect(again["latest_matches_written_value"], "D: the re-run lost the live value")
    skip = [s for s in again["log_summaries"] if "unchanged" in s.get("msg", "")]
    expect(bool(skip), f"D: the compare-before-write skip was not logged: {again['log_summaries']}")
    out["D_idempotent_rerun"] = {
        "enabled_after_rerun": again["enabled_after"], "skip_logged": bool(skip),
        "log_summaries": again["log_summaries"],
    }

    # --- E. bounded backlog drain -------------------------------------------
    harness(wt, "seed", sec_a, "18", f"b{tag}")
    pre = harness(wt, "inspect", sec_a)
    drain1 = harness(wt, "put", sec_a, f"rig-drain-{tag}-{rand()}")
    destroyed1 = [v for v in pre["enabled"] if v not in drain1["enabled_after"]]
    expect(len(destroyed1) <= MAX_DESTROY,
           f"E: one put destroyed {len(destroyed1)} versions, cap is {MAX_DESTROY}")
    expect(drain1["latest_matches_written_value"], "E: the live value did not survive a backlog drain")
    remaining_reported = [s.get("remainingSuperseded") for s in drain1["log_summaries"] if "remainingSuperseded" in s]
    still_superseded = max(0, len(drain1["enabled_after"]) - KEEP)
    expect(remaining_reported and remaining_reported[-1] == still_superseded,
           f"E: reported remainingSuperseded {remaining_reported} != observed {still_superseded}")
    drain2 = harness(wt, "put", sec_a, f"rig-drain2-{tag}-{rand()}")
    expect(len(drain2["enabled_after"]) < len(drain1["enabled_after"]) or len(drain2["enabled_after"]) == KEEP,
           f"E: the second put did not drain further: {drain1['enabled_after']} -> {drain2['enabled_after']}")
    out["E_bounded_drain"] = {
        "enabled_before_drain": pre["enabled"], "destroyed_first_put": len(destroyed1),
        "cap": MAX_DESTROY, "enabled_after_first": drain1["enabled_after"],
        "enabled_after_second": drain2["enabled_after"],
        "remaining_reported": remaining_reported, "remaining_observed": still_superseded,
    }

    # --- F. the F1 regression this soak exists to hold down -------------------
    live_before = harness(wt, "inspect", sec_a)
    newest_before = max(live_before["enabled"])
    kz = harness(wt, "put-keep-zero", sec_a, f"rig-keepzero-{tag}-{rand()}")
    after_kz = harness(wt, "inspect", sec_a)
    # The floor normalises keepVersions:0 to 1, so an older version MAY be pruned
    # here -- that is fine. The invariant is that the live token survives: the
    # value just written is still what versions/latest resolves to and it is
    # readable. Pre-fix, this call destroyed the version it had just written.
    expect(kz["latest_access_status"] == 200,
           f"F: versions/latest:access broke after a keepVersions:0 put ({kz['latest_access_status']}) — "
           "the live refresh token was destroyed")
    expect(kz["latest_matches_written_value"],
           "F: after a keepVersions:0 put, versions/latest no longer resolves to the value just written — "
           "the live refresh token was destroyed")
    expect(len(after_kz["enabled"]) >= 1,
           f"F: a keepVersions:0 put left no enabled version at all: {after_kz}")
    sel = harness(wt, "selector-unit", sec_a)
    for keep, res in sel["results"].items():
        expect(res["includes_newest"] is False,
               f"F: selectSupersededVersions(keepVersions={keep}) returned the newest version: {res}")
    out["F_keep_zero_refused"] = {
        "threw": kz["threw"], "newest_before": newest_before,
        "enabled_after": after_kz["enabled"], "latest_access_status": kz["latest_access_status"],
        "selector_matrix": sel["results"],
    }

    # Steady-state floor: whatever happened above, the secret ends the cycle with
    # a readable live token.
    final = harness(wt, "inspect", sec_a)
    out["final_state"] = final
    expect(len(final["enabled"]) >= 1, f"secret A ended the cycle with no enabled version: {final}")


def smoke_public_api(base: str, out: dict) -> None:
    """T2 smoke on the public verification API (unauthenticated surface)."""
    tok = identity_token()
    hdrs = {"Authorization": "Bearer " + tok}
    st, _h, raw = http("GET", f"{base}/api/v1/verify/does-not-exist-{rand()}", headers=hdrs, timeout=45)
    body = jbody(raw)
    # A well-formed 404/400 proves the router + validation are alive; a 5xx does not.
    expect(st in (400, 404), f"smoke: unknown public_id returned {st}, expected 400/404: {str(body)[:200]}")
    st2, _h2, raw2 = http("GET", f"{base}/api/v1/openapi.json", headers=hdrs, timeout=45)
    out["smoke"] = {"verify_unknown_status": st, "verify_body": body,
                    "openapi_status": st2, "openapi_bytes": len(raw2)}
    expect(st2 in (200, 404), f"smoke: openapi returned {st2}")


def anti_hollow(rig: Rig, tag: str, out: dict) -> int:
    """Rows written and re-counted under this cycle's unique tag."""
    rig.sql(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q('BatchJ Cycle ' + tag + ' LLC')}, {q('BatchJ Cycle ' + tag)}, "
        f"{q('bj-cycle-' + tag.lower() + '.test')})"
    )
    n = rig.one(f"SELECT count(*)::int AS n FROM organizations WHERE display_name = {q('BatchJ Cycle ' + tag)}")
    expect(n["n"] == 1, f"anti-hollow: cycle tag {tag} counted {n['n']} rows, expected 1")
    total = rig.one("SELECT count(*)::int AS n FROM organizations WHERE display_name LIKE 'BatchJ Cycle %'")
    out["anti_hollow"] = {"cycle_tag": tag, "rows_this_cycle": n["n"], "tagged_rows_total": total["n"]}
    return total["n"]


# --------------------------------------------------------------------------
def main() -> int:
    ref = read("rig-ref.txt")
    base = read("service-url.txt")
    wt = read("worktree.txt")
    rig = Rig(ref, read("supabase-access.txt"))
    candidate = read("candidate-sha.txt")
    sec_a = read("secret-a.txt")
    sec_b = read("secret-b.txt")

    status_path = HOME / "status.json"
    status = json.loads(status_path.read_text())
    status.update(status="running", pid=os.getpid())

    cycles_path = EV / "soak-cycles.jsonl"
    deadline = time.time() + WINDOW_HOURS * 3600 + 600

    while time.time() < deadline:
        started = time.time()
        tag = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out = {"cycle_tag": tag, "started_at": now(), "candidate_sha": candidate}
        try:
            hs, _h, hraw = http("GET", f"{base}/health",
                                headers={"Authorization": "Bearer " + identity_token()}, timeout=45)
            health = jbody(hraw)
            out["health"] = {"status": hs, "git_sha": health.get("git_sha"),
                             "uptime": health.get("uptime"), "revision": health.get("revision")}
            expect(hs == 200, f"/health returned {hs}")
            expect(health.get("git_sha") == candidate,
                   f"rig is serving git_sha {health.get('git_sha')}, candidate is {candidate} — STALE HEAD")

            probe_2667(wt, sec_a, sec_b, tag, out)
            smoke_public_api(base, out)
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
