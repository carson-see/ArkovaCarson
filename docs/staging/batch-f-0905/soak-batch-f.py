#!/usr/bin/env python3
"""Batch-F combined T3 soak driver — PRs #2663 (T2), #2655 (T3), #2658 (T3).

Runs detached (nohup, PPID 1) on 15-minute cycles for a 48 h window against the
isolated rig `arkova-soak-batch-f-0905` + Cloud Run `arkova-worker-batch-f-0905-staging`.

Each cycle exercises the CHANGED behaviour of all three PRs end to end
(CLAUDE.md §1.12 T3 + feedback_soaks_must_meet_soc2_type2), not a health probe
beside it:

  #2663  cron /jobs limiter keyed per job path
         A. 40 DISTINCT /jobs/<name> POSTs inside one minute with valid cron
            auth  -> assert ZERO 429 (the old global 30/min bucket refused the
            31st onwards; this is the regression that skipped Cloud Scheduler runs).
         B. 11 POSTs against ONE path -> the 11th MUST be 429 and MUST carry
            Retry-After (the per-path bucket still bounds a runaway trigger).

  #2655  OAuth mailbox confirmation before org association
         Real GoTrue admin signup -> provider flipped to google (the migration's
         AFTER INSERT OR UPDATE OF raw_app_meta_data trigger path) -> assert
         enrollment row, requires_oauth_email_confirmation() true,
         auto_associate_profile_to_org_by_email_domain() refuses while pending,
         then claim/register/sent/complete -> association happens EXACTLY ONCE,
         and a replayed complete is invalid_link with no second association.
         Worker HTTP surface: GET /api/auth/email-confirmation with the pending
         identity's JWT, and POST .../complete with a junk token -> 400.

  #2658  a capped organization is not a test organization
         New signup org -> seed trigger writes cap_enforced = true (not merely
         a recorded, inert quota); the kept 4-arg admin RPC writes cap_enforced;
         the capped org's 11th anchor is refused 402 quota_exhausted with a
         §1.3-clean message; and the Login Defense-shaped row (anchor_quota = 15,
         is_test = false, cap_enforced = false) stays INERT and untouched.

  Plus: Trigger A (process-anchors), Trigger B (check-confirmations), a daily
  flush observation (batch-anchors?force=true), a per-org RLS isolation check,
  and anti-hollow guards (rows written and re-counted per cycle under a unique
  cycle tag).

Every cycle appends one JSON object to evidence/soak-cycles.jsonl and updates
status.json. A failed assertion increments `failures` and is recorded in full —
nothing is filtered out to make a window look clean.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
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
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HOME = pathlib.Path(os.environ.get("BATCH_F_HOME", os.path.expanduser("~/arkova-soak/batch-f-0905")))
EV = HOME / "evidence"
EV.mkdir(parents=True, exist_ok=True)

CYCLE_SECONDS = int(os.environ.get("BATCH_F_CYCLE_SECONDS", "900"))
# Smoke-test escape hatch: run N cycles and exit. Unset in the real window.
MAX_CYCLES = int(os.environ.get("BATCH_F_MAX_CYCLES", "0"))
WINDOW_HOURS = 48
TEST_DOMAIN = "arkova-batch-f.test"

# ---- 40 distinct cron job paths for the no-429 burst (#2663 A). ------------
# Deliberately read-mostly / public-record fetch + monitor jobs: on a mock rig
# with ENABLE_PROD_NETWORK_ANCHORING=false none of them spend or broadcast.
BURST_PATHS = [
    "proof-coverage-monitor", "platform-health-digest", "process-revocations",
    "webhook-retries", "credit-expiry", "generate-reports",
    "reconcile-credit-conservation", "anchor-expiry-sweep",
    "refresh-treasury-cache", "treasury-alert-check", "ce-key-expiry-check",
    "ce-registry-drift-check", "queue-reminders", "org-queue-scheduler",
    "drain-connector-artifacts", "rules-engine", "rule-action-dispatcher",
    "ai-credit-reconcile", "workspace-subscription-renewal", "fetch-edgar",
    "fetch-uspto", "fetch-federal-register", "fetch-openalex",
    "fetch-courtlistener", "fetch-state-courts", "fetch-state-bills",
    "embed-public-records", "fetch-dapip", "fetch-acnc",
    "check-attestation-expiry", "monitor-fees", "grace-expiry-sweep",
    "monthly-allocation-rollover", "reconcile-stripe", "financial-report",
    "payment-recovery", "monitor-stuck-txs", "detect-reorgs",
    "classify-proof-backcatalog", "queue-digest",
]
assert len(BURST_PATHS) == 40, len(BURST_PATHS)
assert len(set(BURST_PATHS)) == 40

# The single-path saturation target. NOT in BURST_PATHS, so its 10/min bucket
# is untouched when the 11-hit run starts.
SATURATE_PATH = "materialize-proof-backcatalog"


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read(name: str) -> str:
    return (HOME / name).read_text().strip()


class Fail(Exception):
    pass


def expect(cond: bool, msg: str) -> None:
    if not cond:
        raise Fail(msg)


# --------------------------------------------------------------------------
# transports
# --------------------------------------------------------------------------
class CIHeaders(dict):
    """HTTP/2 lowercases header names; look them up case-insensitively."""

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
            raw = r.read()
            return r.status, CIHeaders(r.headers), raw
    except urllib.error.HTTPError as e:
        return e.code, CIHeaders(e.headers), e.read()
    except Exception as e:  # transport-level: recorded, never silently dropped
        return 0, CIHeaders({"x-transport-error": type(e).__name__ + ": " + str(e)[:200]}), b""


def jbody(raw):
    try:
        return json.loads(raw)
    except Exception:
        return {"_raw": raw[:400].decode("utf-8", "replace")}


_id_lock = threading.Lock()
_id_cache = {"tok": None, "at": 0.0}


def identity_token() -> str:
    """Cloud Run OIDC token; refreshed well inside its 1 h life."""
    with _id_lock:
        if _id_cache["tok"] and time.time() - _id_cache["at"] < 1800:
            return _id_cache["tok"]
        tok = subprocess.run(
            ["gcloud", "auth", "print-identity-token"],
            capture_output=True, text=True, timeout=90, check=True,
        ).stdout.strip()
        _id_cache.update(tok=tok, at=time.time())
        return tok


class Rig:
    """SQL against the rig via the Supabase Management API (runs as postgres).

    Statements are capped server-side at ~60 s and a timeout still COMMITS, so a
    timeout is surfaced, never blindly retried.
    """

    def __init__(self, ref: str, mgmt: str):
        self.ref, self.mgmt = ref, mgmt

    def sql(self, query: str):
        st, _, raw = http(
            "POST",
            f"https://api.supabase.com/v1/projects/{self.ref}/database/query",
            headers={
                "Authorization": "Bearer " + self.mgmt,
                # Management API rejects the stdlib default UA.
                "User-Agent": "arkova-batch-f-soak/1.0",
            },
            body={"query": query},
            timeout=120,
        )
        if st != 200 and st != 201:
            raise Fail(f"SQL {st}: {raw[:300].decode('utf-8', 'replace')} :: {query[:160]}")
        return jbody(raw)

    def one(self, query: str):
        rows = self.sql(query)
        return rows[0] if isinstance(rows, list) and rows else None


def q(v) -> str:
    """SQL literal for a python str/None (driver-controlled values only)."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def rand(n=10) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


# --------------------------------------------------------------------------
# per-PR probes
# --------------------------------------------------------------------------
def probe_2663(base: str, cron_secret: str, out: dict) -> None:
    """#2663 — per-job-path cron limiter."""
    tok = identity_token()
    hdrs = {"Authorization": "Bearer " + tok, "X-Cron-Secret": cron_secret}

    # --- A. 40 distinct paths inside one minute -> zero 429 -----------------
    t0 = time.time()

    def fire(p):
        st, h, raw = http("POST", f"{base}/jobs/{p}", headers=hdrs, timeout=30)
        return p, st, h.get("Retry-After"), h.get("X-RateLimit-Remaining")

    # All 40 in flight at once: the limiter counts on arrival, so this IS the
    # coinciding-Cloud-Scheduler-cadence burst that the old global bucket refused.
    with ThreadPoolExecutor(max_workers=40) as ex:
        results = list(ex.map(fire, BURST_PATHS))
    elapsed_a = round(time.time() - t0, 2)
    codes = {}
    for _p, st, _ra, _rem in results:
        codes[str(st)] = codes.get(str(st), 0) + 1
    rate_limited = [p for p, st, _ra, _rem in results if st == 429]
    out["pr2663_burst"] = {
        "distinct_paths": len(BURST_PATHS),
        "elapsed_seconds": elapsed_a,
        "status_histogram": codes,
        "rate_limited_paths": rate_limited,
        "transport_errors": [p for p, st, _r, _m in results if st == 0],
    }
    expect(elapsed_a < 60, f"#2663 burst took {elapsed_a}s — not inside one minute, result is not probative")
    expect(not rate_limited, f"#2663 REGRESSION: 429 on distinct job paths {rate_limited}")

    # --- B. 11 hits on ONE path -> exactly one 429, carrying Retry-After -----
    # Fired concurrently for the same reason as the burst; completion order is
    # not deterministic, so the assertion is on the COUNT (10 admitted by the
    # per-path 10/min bucket, the 11th refused), not on which one lost.
    t0 = time.time()

    def hit(i):
        st, h, _raw = http("POST", f"{base}/jobs/{SATURATE_PATH}", headers=hdrs, timeout=30)
        return {"n": i + 1, "status": st, "retry_after": h.get("Retry-After")}

    with ThreadPoolExecutor(max_workers=11) as ex:
        saturate = list(ex.map(hit, range(11)))
    elapsed_b = round(time.time() - t0, 2)
    refused = [a for a in saturate if a["status"] == 429]
    out["pr2663_saturate"] = {
        "path": SATURATE_PATH,
        "elapsed_seconds": elapsed_b,
        "attempts": saturate,
        "refused_count": len(refused),
    }
    expect(elapsed_b < 60, f"#2663 saturation took {elapsed_b}s — the 60s window rolled, result is not probative")
    expect(len(refused) == 1,
           f"#2663 per-path bucket refused {len(refused)} of 11 hits on one path, expected exactly 1: "
           f"{[a['status'] for a in saturate]}")
    expect(refused[0]["retry_after"] is not None,
           "#2663 the per-path 429 carried no Retry-After header (§1.10)")


def probe_2655(rig: Rig, base: str, supa_url: str, service_key: str, tag: str, out: dict) -> None:
    """#2655 — mailbox confirmation gates org association, exactly once."""
    email = f"bf-oauth-{tag}-{rand(6)}@{TEST_DOMAIN}"
    pw = "Batch-F-" + rand(16) + "!"

    # 1. Real GoTrue signup. email_confirm=False: this identity has NOT proved
    #    its mailbox, which is the cohort 0436 exists to gate. (A signup that
    #    ALREADY held mailbox proof is asserted separately at step 6 — the
    #    migration deliberately carries that proof forward instead of
    #    re-challenging, and conflating the two hides the real gate.)
    st, _h, raw = http(
        "POST", f"{supa_url}/auth/v1/admin/users",
        headers={"apikey": service_key, "Authorization": "Bearer " + service_key},
        body={"email": email, "password": pw, "email_confirm": False,
              "app_metadata": {"provider": "google", "providers": ["google"]}},
    )
    expect(st in (200, 201), f"#2655 GoTrue admin signup failed {st}: {raw[:200]}")
    uid = jbody(raw)["id"]

    # 2. Ensure the identity presents as an OAuth provider. GoTrue stamps
    #    provider=email for an admin-created user, so this is the trigger's
    #    `UPDATE OF raw_app_meta_data` arm — the real Google-conversion path.
    rig.sql(
        "UPDATE auth.users SET raw_app_meta_data = "
        "jsonb_build_object('provider','google','providers',jsonb_build_array('google')) "
        f"WHERE id = {q(uid)}::uuid;"
    )

    enrolled = rig.one(
        "SELECT (confirmed_at IS NULL) AS pending, email FROM private.oauth_email_confirmations "
        f"WHERE user_id = {q(uid)}::uuid"
    )
    expect(enrolled is not None, "#2655 enrollment trigger did not create a confirmation row for an OAuth signup")
    expect(enrolled["pending"] is True, "#2655 new OAuth signup was enrolled already-confirmed")

    req = rig.one(f"SELECT private.requires_oauth_email_confirmation({q(uid)}::uuid) AS r")
    expect(req["r"] is True, "#2655 requires_oauth_email_confirmation() false for a pending OAuth signup")

    # 3. Association MUST be refused while the mailbox is unproven.
    assoc = rig.one(
        f"SELECT public.auto_associate_profile_to_org_by_email_domain({q(uid)}::uuid, {q(email)}) AS org"
    )
    expect(assoc["org"] is None,
           f"#2655 REGRESSION: domain association returned {assoc['org']} before mailbox confirmation")
    pre = rig.one(f"SELECT count(*)::int AS n FROM org_members WHERE user_id = {q(uid)}::uuid")
    expect(pre["n"] == 0, f"#2655 REGRESSION: {pre['n']} org_members rows before confirmation")

    # 3b. Worker HTTP surface for the pending identity. GoTrue refuses a
    #     password grant to an unconfirmed address, so email_confirmed_at is
    #     stamped directly — this touches neither raw_app_meta_data (so the
    #     enrollment trigger does not re-fire) nor the confirmation row, which
    #     stays pending. That is the point: a GoTrue-confirmed session must
    #     STILL be told mailbox proof is required by Arkova's own gate.
    rig.sql(f"UPDATE auth.users SET email_confirmed_at = now() WHERE id = {q(uid)}::uuid "
            "AND email_confirmed_at IS NULL;")
    still_pending = rig.one(
        f"SELECT (confirmed_at IS NULL) AS pending FROM private.oauth_email_confirmations "
        f"WHERE user_id = {q(uid)}::uuid")
    expect(still_pending["pending"] is True, "#2655 confirmation row resolved itself without proof")
    tokst, _th, tokraw = http(
        "POST", f"{supa_url}/auth/v1/token?grant_type=password",
        headers={"apikey": service_key}, body={"email": email, "password": pw},
    )
    expect(tokst == 200, f"#2655 password grant for the pending identity failed {tokst}: {tokraw[:200]}")
    jwt = jbody(tokraw).get("access_token")
    hs2, _h2, r2 = http("GET", f"{base}/api/auth/email-confirmation",
                        headers={"Authorization": "Bearer " + jwt,
                                 "X-Serverless-Authorization": "Bearer " + identity_token()})
    body2 = jbody(r2)
    out["pr2655_http_status_endpoint"] = {"status": hs2, "body": body2}
    expect(hs2 == 200 and body2.get("required") is True,
           f"#2655 worker status endpoint did not report confirmation required: {hs2} {body2}")

    junk = "z" * 64
    js, _jh, jr = http("POST", f"{base}/api/auth/email-confirmation/complete",
                       headers={"Authorization": "Bearer " + identity_token()},
                       body={"token": junk})
    out["pr2655_http_complete_junk"] = {"status": js, "body": jbody(jr)}
    expect(js == 400, f"#2655 junk confirmation token returned {js}, expected 400 invalid_confirmation_link")

    # 4. Prove the mailbox through the real RPC lifecycle and assert the
    #    association happens EXACTLY ONCE.
    claim = rig.one(f"SELECT public.manage_oauth_email_confirmation('claim', {q(uid)}::uuid) AS s")["s"]
    expect(claim.get("attemptId"), f"#2655 claim did not lease an attempt: {claim}")
    digest = hashlib.sha256((tag + uid).encode()).hexdigest()
    reg = rig.one(
        "SELECT public.manage_oauth_email_confirmation('register', "
        f"{q(uid)}::uuid, {q(email)}, {q(digest)}, {q(claim['attemptId'])}::uuid) AS s"
    )["s"]
    expect(reg.get("required") is True, f"#2655 register rejected: {reg}")
    sent = rig.one(
        "SELECT public.manage_oauth_email_confirmation('sent', "
        f"{q(uid)}::uuid, NULL, {q(digest)}, {q(claim['attemptId'])}::uuid) AS s"
    )["s"]
    expect(sent.get("sent") is True, f"#2655 sent rejected: {sent}")

    done = rig.one(
        "SELECT public.manage_oauth_email_confirmation('complete', "
        f"{q(uid)}::uuid, {q(email)}, {q(digest)}) AS s"
    )["s"]
    expect(done.get("required") is False, f"#2655 complete rejected: {done}")

    post = rig.one(
        f"SELECT (SELECT count(*)::int FROM org_members WHERE user_id = {q(uid)}::uuid) AS members,"
        f" (SELECT count(*)::int FROM audit_events WHERE actor_id = {q(uid)}::uuid"
        "   AND event_type = 'profile.org_auto_associated') AS audits"
    )
    expect(post["members"] == 1,
           f"#2655 confirmation associated {post['members']} orgs, expected exactly 1")
    expect(post["audits"] == 1,
           f"#2655 {post['audits']} association audit events, expected exactly 1")

    # 5. Replay: a second complete must be refused and must NOT re-associate.
    replay = rig.one(
        "SELECT public.manage_oauth_email_confirmation('complete', "
        f"{q(uid)}::uuid, {q(email)}, {q(digest)}) AS s"
    )["s"]
    expect(replay.get("error") == "invalid_link", f"#2655 replayed complete was accepted: {replay}")
    again = rig.one(f"SELECT count(*)::int AS n FROM org_members WHERE user_id = {q(uid)}::uuid")
    expect(again["n"] == 1, f"#2655 replay produced {again['n']} memberships — association is not exactly-once")

    # 6. Discriminator: an account that ALREADY proved its mailbox as an email
    #    identity must NOT be re-challenged when it links Google. Without this
    #    the "pending" result above is indistinguishable from a trigger that
    #    enrolls everyone.
    linked_email = f"bf-linked-{tag}-{rand(6)}@{TEST_DOMAIN}"
    lst, _lh, lraw = http(
        "POST", f"{supa_url}/auth/v1/admin/users",
        headers={"apikey": service_key, "Authorization": "Bearer " + service_key},
        body={"email": linked_email, "password": "Batch-F-" + rand(16) + "!", "email_confirm": True},
    )
    expect(lst in (200, 201), f"#2655 linked-account signup failed {lst}: {lraw[:200]}")
    luid = jbody(lraw)["id"]
    rig.sql(
        "UPDATE auth.users SET raw_app_meta_data = "
        "jsonb_build_object('provider','google','providers',jsonb_build_array('google')) "
        f"WHERE id = {q(luid)}::uuid;"
    )
    linked = rig.one(
        f"SELECT (confirmed_at IS NOT NULL) AS carried, "
        f"private.requires_oauth_email_confirmation({q(luid)}::uuid) AS gated "
        f"FROM private.oauth_email_confirmations WHERE user_id = {q(luid)}::uuid"
    )
    expect(linked is not None and linked["carried"] is True and linked["gated"] is False,
           f"#2655 a mailbox-proved email account was re-challenged on linking Google: {linked}")
    out["pr2655_linked_account"] = {"user_id": luid, "state": linked}

    out["pr2655"] = {
        "user_id": uid, "email": email,
        "enrolled_pending": True, "association_before_confirmation": None,
        "members_after_confirmation": post["members"], "audits": post["audits"],
        "replay_error": replay.get("error"), "members_after_replay": again["n"],
    }


def probe_2658(rig: Rig, base: str, tag: str, hmac_secret: str, out: dict) -> None:
    """#2658 — cap_enforced is the switch; is_test is billing only."""
    actor = rig.one("SELECT id FROM auth.users ORDER BY created_at LIMIT 1")
    actor_id = actor["id"] if actor else None

    # 1. A NEW signup org must get an ENFORCED free-tier cap from the trigger.
    org = rig.one(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q('BatchF Signup ' + tag + ' LLC')}, {q('BatchF Signup ' + tag)}, "
        f"{q('bf-signup-' + rand(8) + '.test')}) RETURNING id"
    )
    seeded = rig.one(
        f"SELECT anchor_quota, is_test, cap_enforced FROM org_credits WHERE org_id = {q(org['id'])}::uuid"
    )
    expect(seeded is not None, "#2658 seed_free_tier_org_credits did not fire for a new top-level org")
    expect(seeded["anchor_quota"] == 10, f"#2658 seeded quota {seeded['anchor_quota']}, expected 10")
    expect(seeded["cap_enforced"] is True,
           "#2658 REGRESSION (F1): new signup seeded with cap_enforced=false — a recorded but INERT cap")

    # 2. The KEPT 4-arg admin RPC must write cap_enforced, not just is_test.
    rig.sql(
        f"SELECT public.admin_set_org_anchor_quota({q(org['id'])}::uuid, 7, true, "
        f"{q(actor_id)}::uuid)"
    )
    four_on = rig.one(
        f"SELECT anchor_quota, is_test, cap_enforced FROM org_credits WHERE org_id = {q(org['id'])}::uuid"
    )
    expect(four_on["cap_enforced"] is True and four_on["anchor_quota"] == 7,
           f"#2658 4-arg RPC did not write an enforced cap: {four_on}")
    rig.sql(
        f"SELECT public.admin_set_org_anchor_quota({q(org['id'])}::uuid, 7, false, "
        f"{q(actor_id)}::uuid)"
    )
    four_off = rig.one(
        f"SELECT anchor_quota, is_test, cap_enforced FROM org_credits WHERE org_id = {q(org['id'])}::uuid"
    )
    expect(four_off["cap_enforced"] is False,
           f"#2658 4-arg RPC with is_test=false left the cap enforced: {four_off}")

    # 3. The structural invariant: an enforced cap with no number is refused.
    bad = None
    try:
        rig.sql(f"UPDATE org_credits SET cap_enforced = true, anchor_quota = NULL "
                f"WHERE org_id = {q(org['id'])}::uuid")
        bad = "accepted"
    except Fail as e:
        bad = "rejected: " + str(e)[:120]
    expect(bad.startswith("rejected"),
           "#2658 org_credits_cap_enforced_needs_quota did not block an enforced cap with a NULL quota")

    # 4. The capped org's 11th anchor is refused 402 with a §1.3-clean message.
    capped = rig.one(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q('BatchF Capped ' + tag + ' LLC')}, {q('BatchF Capped ' + tag)}, "
        f"{q('bf-capped-' + rand(8) + '.test')}) RETURNING id"
    )
    cap_uid = rig.one("SELECT id FROM auth.users ORDER BY created_at LIMIT 1")["id"]
    rig.sql(
        f"SELECT public.admin_set_org_cap({q(capped['id'])}::uuid, 10, true, false, {q(actor_id)}::uuid)"
    )
    # 10 existing non-deleted anchors -> the next submit is the 11th.
    rig.sql(
        "INSERT INTO anchors (fingerprint, public_id, status, org_id, user_id, filename, credential_type) "
        "SELECT encode(sha256((" + q(tag + capped['id']) + " || g::text)::bytea), 'hex'), "
        "'ARK-2026-BF' || substr(md5(random()::text), 1, 8), 'PENDING', "
        f"{q(capped['id'])}::uuid, {q(cap_uid)}::uuid, 'batch-f-cap-fill', 'OTHER' "
        "FROM generate_series(1, 10) g;"
    )
    raw_key = "ak_bf" + rand(40)  # apiKeyAuth only extracts keys prefixed ak_
    key_hash = hmac.new(hmac_secret.encode(), raw_key.encode(), hashlib.sha256).hexdigest()
    rig.sql(
        "INSERT INTO api_keys (org_id, created_by, name, key_hash, key_prefix, scopes) VALUES ("
        f"{q(capped['id'])}::uuid, {q(cap_uid)}::uuid, {q('batch-f-' + tag)}, {q(key_hash)}, "
        f"{q(raw_key[:12])}, ARRAY['anchor:write','anchor:read'])"
    )
    st, _h, raw = http(
        "POST", f"{base}/api/v1/anchor",
        headers={"Authorization": "Bearer " + identity_token(), "X-API-Key": raw_key},
        body={"fingerprint": hashlib.sha256(("bf-11th-" + tag + capped["id"]).encode()).hexdigest(),
              "credential_type": "OTHER"},
    )
    body = jbody(raw)
    out["pr2658_11th_anchor"] = {"status": st, "body": body}
    expect(st == 402, f"#2658 11th anchor on a capped org returned {st}, expected 402 quota_exhausted")
    expect(body.get("error") == "quota_exhausted", f"#2658 402 body was not quota_exhausted: {body}")
    msg = (body.get("message") or "").lower()
    banned = [w for w in ("wallet", "gas", "hash", "block", "transaction", "crypto",
                          "blockchain", "bitcoin", "testnet", "mainnet", "utxo", "broadcast")
              if w in msg]
    expect(not banned, f"#2658 402 message carries §1.3-banned terms {banned}: {body.get('message')}")

    # 5. Login Defense shape: a RECORDED but INERT quota must stay inert and untouched.
    ld = rig.one(
        f"SELECT org_id, anchor_quota, is_test, cap_enforced FROM org_credits "
        f"WHERE org_id = (SELECT id FROM organizations WHERE display_name = 'BatchF Preserved Quota' LIMIT 1)"
    )
    expect(ld is not None, "#2658 preserved-quota fixture org is missing from the rig")
    expect(ld["anchor_quota"] == 15 and ld["is_test"] is False and ld["cap_enforced"] is False,
           f"#2658 preserved-quota row was mutated: {ld}")
    ld_key = read("preserved-org-api-key.txt")
    st2, _h2, raw2 = http(
        "POST", f"{base}/api/v1/anchor",
        headers={"Authorization": "Bearer " + identity_token(), "X-API-Key": ld_key},
        body={"fingerprint": hashlib.sha256(("bf-ld-" + tag).encode()).hexdigest(),
              "credential_type": "OTHER"},
    )
    out["pr2658_preserved_quota_anchor"] = {"status": st2, "quota_row": ld}
    expect(st2 in (200, 201),
           f"#2658 REGRESSION: an INERT recorded quota refused an anchor ({st2}) — "
           f"Login Defense would start being capped at 15 by accident: {jbody(raw2)}")

    out["pr2658"] = {"signup_org": org["id"], "seeded": seeded,
                     "four_arg_on": four_on, "four_arg_off": four_off,
                     "check_constraint": bad[:60], "capped_org": capped["id"]}


def triggers_and_isolation(rig: Rig, base: str, cron_secret: str, tag: str,
                           state: dict, out: dict) -> None:
    """T3 extras: Trigger A, Trigger B, daily flush, per-org isolation."""
    hdrs = {"Authorization": "Bearer " + identity_token(), "X-Cron-Secret": cron_secret}

    sa, _h, ra = http("POST", f"{base}/jobs/process-anchors", headers=hdrs, timeout=90)
    out["trigger_a_process_anchors"] = {"status": sa, "body": jbody(ra)}
    sb, _h, rb = http("POST", f"{base}/jobs/check-confirmations", headers=hdrs, timeout=90)
    out["trigger_b_check_confirmations"] = {"status": sb, "body": jbody(rb)}
    expect(sa < 500, f"Trigger A returned {sa}")
    expect(sb < 500, f"Trigger B returned {sb}")

    # Daily flush: one forced batch-anchors observation per 24 h.
    last = state.get("last_daily_flush_at", 0)
    if time.time() - last > 86400 or not state.get("daily_flush_observations"):
        sf, _h, rf = http("POST", f"{base}/jobs/batch-anchors?force=true", headers=hdrs, timeout=120)
        obs = {"at": now(), "status": sf, "body": jbody(rf)}
        out["daily_flush"] = obs
        state["last_daily_flush_at"] = time.time()
        state.setdefault("daily_flush_observations", []).append(obs)

    # Per-org isolation: the RLS boundary. Org B's authenticated session must
    # not be able to read org A's anchor rows. Deliberately NOT the public
    # /verify endpoint — that surface is cross-tenant by design.
    iso = rig.one(
        "SELECT (SELECT count(*)::int FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "        WHERE o.display_name = 'BatchF Isolation A') AS a_rows,"
        " (SELECT count(*)::int FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "        WHERE o.display_name = 'BatchF Isolation B') AS b_rows"
    )
    expect(iso["a_rows"] >= 1 and iso["b_rows"] >= 1,
           f"isolation fixture is missing anchors on one side: {iso}")
    a_public = rig.one(
        "SELECT a.public_id FROM anchors a JOIN organizations o ON o.id = a.org_id "
        "WHERE o.display_name = 'BatchF Isolation A' LIMIT 1"
    )["public_id"]
    supa_url = read("supabase-url.txt")
    service_key = read("service-role-key.txt")
    ts, _th, tr = http("POST", f"{supa_url}/auth/v1/token?grant_type=password",
                       headers={"apikey": service_key},
                       body={"email": read("isolation-b-user.txt"),
                             "password": read("isolation-b-password.txt")})
    expect(ts == 200, f"isolation: org B password grant failed {ts}: {tr[:200]}")
    jwt = jbody(tr)["access_token"]
    rs, _rh, rr = http("GET", f"{supa_url}/rest/v1/anchors?select=public_id,org_id",
                       headers={"apikey": service_key, "Authorization": "Bearer " + jwt})
    rows = jbody(rr)
    visible = [r.get("public_id") for r in rows] if isinstance(rows, list) else []
    out["per_org_isolation"] = {"counts": iso, "org_a_anchor": a_public,
                                "org_b_session_status": rs,
                                "org_b_visible_rows": len(visible),
                                "org_a_anchor_visible_to_org_b": a_public in visible}
    expect(rs == 200, f"per-org isolation probe could not read as org B: {rs} {rr[:200]}")
    expect(a_public not in visible,
           f"per-org isolation FAILED: org B's session read org A's anchor {a_public}")


def anti_hollow(rig: Rig, tag: str, out: dict) -> int:
    """Rows written and re-counted under this cycle's unique tag."""
    rig.sql(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q('BatchF Cycle ' + tag + ' LLC')}, {q('BatchF Cycle ' + tag)}, "
        f"{q('bf-cycle-' + tag.lower() + '.test')})"
    )
    n = rig.one(f"SELECT count(*)::int AS n FROM organizations WHERE display_name = {q('BatchF Cycle ' + tag)}")
    expect(n["n"] == 1, f"anti-hollow: cycle tag {tag} counted {n['n']} rows, expected 1")
    total = rig.one("SELECT count(*)::int AS n FROM organizations WHERE display_name LIKE 'BatchF Cycle %'")
    out["anti_hollow"] = {"cycle_tag": tag, "rows_this_cycle": n["n"], "tagged_rows_total": total["n"]}
    return total["n"]


# --------------------------------------------------------------------------
def main() -> int:
    ref = read("rig-ref.txt")
    base = read("service-url.txt")
    supa_url = f"https://{ref}.supabase.co"
    rig = Rig(ref, read("supabase-access.txt"))
    service_key = read("service-role-key.txt")
    cron_secret = read("cron-secret.txt")
    hmac_secret = read("api-key-hmac.txt")
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
        try:
            hs, _h, hraw = http("GET", f"{base}/health",
                                headers={"Authorization": "Bearer " + identity_token()}, timeout=45)
            health = jbody(hraw)
            out["health"] = {"status": hs, "git_sha": health.get("git_sha"),
                             "uptime": health.get("uptime"), "revision": health.get("revision")}
            expect(hs == 200, f"/health returned {hs}")
            expect(health.get("git_sha") == candidate,
                   f"rig is serving git_sha {health.get('git_sha')}, candidate is {candidate} — STALE HEAD")

            probe_2663(base, cron_secret, out)
            probe_2655(rig, base, supa_url, service_key, tag, out)
            probe_2658(rig, base, tag, hmac_secret, out)
            triggers_and_isolation(rig, base, cron_secret, tag, state, out)
            tagged = anti_hollow(rig, tag, out)

            out["result"] = "PASS"
            status["cycles"] = status.get("cycles", 0) + 1
            status["tagged_rows"] = tagged
        except Exception as e:  # every failure is recorded in full, never filtered
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
              f"cycles={status.get('cycles', 0)} failures={status.get('failures', 0)}",
              flush=True)

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
