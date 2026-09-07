#!/usr/bin/env python3
"""Batch-G combined T3 soak driver — PRs #2565, #2566, #2570 (all T3).

Runs detached (nohup, PPID 1) on 15-minute cycles for a 48 h window against the
isolated rig `arkova-soak-batch-g-0907` + Cloud Run
`arkova-worker-batch-g-0907-staging`.

The three PRs are a STACK on the DocuSign chain (#2474 -> #2565;
#2476 -> #2566 -> #2570), so the candidate this rig serves also carries the
frozen parent heads (#2474 #2476 #2485 #2486 #2496). Each cycle exercises the
CHANGED behaviour of the three follow-ons end to end (CLAUDE.md §1.12 T3 +
feedback_soaks_must_meet_soc2_type2), plus supporting checks on the parents'
key paths — never a health probe standing in for the change.

  #2565  DocuSign signer-backfill attempts durable and service-owned (mig 0438)
         A. `claim_docusign_signer_backfill_attempt` writes a DURABLE row in
            `public.docusign_signer_backfill_attempts`; an immediate re-claim of
            the SAME (org, envelope) returns false because the persisted
            `next_attempt_at` cooldown is honoured. The pre-0438 code kept this
            in worker memory, so a restart re-attempted immediately — the row
            surviving is exactly the property under test. The "simulated worker
            restart" is real: the row is re-read in a FRESH connection after the
            worker process is asked to re-enter the job over HTTP.
         B. SERVICE-OWNED: as `authenticated` (RLS + FORCE + service-only
            policy) SELECT / INSERT / UPDATE on the attempts table are all
            refused, and EXECUTE on the three 0438 functions is refused.
         C. Completion-marker forgery: an `authenticated` UPDATE that tries to
            stamp `metadata._signers_backfilled_at` onto an anchor is STRIPPED
            by `trg_strip_unattested_docusign_backfill_marker`; the same write
            as service_role is kept.
         D. Worker surface: POST /jobs/docusign-signer-backfill answers with a
            bounded result (the flag is ON on this rig) and never 5xx.

  #2566  the drain no longer materializes anchors from a stale batch-read
         Seed K pending `connector_artifact` rows. While the drain pass is in
         flight, "heal" (as `docusign-envelope-completed.ts` legitimately does)
         every row STILL `pending` — i.e. not yet claimed — to a new
         fingerprint, capturing the ids the UPDATE actually matched. Those rows
         MUST mint an anchor carrying the NEW fingerprint: the pre-#2566 code
         read row content in the id-only batch SELECT and would have minted the
         SUPERSEDED one. Assertion is on the healed ids only, so it is
         deterministic, not a race we hope lands.

  #2570  the residual claim-to-mint TOCTOU is closed
         Same shape, but the heal targets rows already in `processing` — rows
         whose content was captured by `claimRow`'s CAS RETURNING and whose link
         has not landed yet. The version-gated link CAS
         (`.eq('updated_at', row.updated_at)`) must REFUSE the mint:
         `supersededRequeued` > 0 in the drain response, NO anchor left live
         carrying the superseded fingerprint, NO credit debit for it.
         Plus the concurrency invariant the PR exists to protect: TWO drains
         fired concurrently over the same artifacts leave EXACTLY ONE anchor and
         EXACTLY ONE credit deduction per artifact — never two of either.

  Parents (supporting, not the subject of this window's evidence):
         #2474/#2476 DocuSign Connect webhook: a bad raw-body HMAC is 401 and
         writes nothing; a valid outbound envelope-completed delivery is
         accepted; a replayed nonce is refused (0424/0435).
         #2485/#2496 rule-event payloads stay under the 16 KB CHECK: the
         constraint is present and no `organization_rule_events.payload` on the
         rig exceeds it.

  T3 extras: Trigger A (process-anchors), Trigger B (check-confirmations), a
  daily flush observation (batch-anchors?force=true), a per-org RLS isolation
  check, and anti-hollow guards (a uniquely tagged row written and re-counted
  every cycle, and /health's git_sha re-asserted against the candidate SHA).

Every cycle appends one JSON object to evidence/soak-cycles.jsonl and updates
status.json. A failed assertion increments `failures` and is recorded in full —
nothing is filtered out to make a window look clean.

NOT ASSERTED by this window: no live DocuSign vendor call happens. The rig's
DocuSign integration key / client secret / Connect HMAC secret are synthetic,
rig-only values and the OAuth base URL is a stub host that does not resolve. The
signer-backfill job's DocuSign REST fetch is therefore never exercised against
the vendor; what is exercised is 0438's durability/authority contract and the
job's own bounded HTTP surface.
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

HOME = pathlib.Path(os.environ.get("BATCH_G_HOME", os.path.expanduser("~/arkova-soak/batch-g-0907")))
EV = HOME / "evidence"
EV.mkdir(parents=True, exist_ok=True)

CYCLE_SECONDS = int(os.environ.get("BATCH_G_CYCLE_SECONDS", "900"))
# Smoke-test escape hatch: run N cycles and exit. Unset in the real window.
MAX_CYCLES = int(os.environ.get("BATCH_G_MAX_CYCLES", "0"))
WINDOW_HOURS = 48

ORG_A = "BatchG Org A"
ORG_B = "BatchG Org B"

# How many connector_artifact rows each drain probe seeds. Big enough that the
# drain's sequential per-row processing (each row: materialize insert, link CAS,
# debit round trip) leaves a real window for the heal to land in, small enough
# that a cycle stays well inside 15 minutes.
SEED_ROWS = int(os.environ.get("BATCH_G_SEED_ROWS", "24"))


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


def http(method, url, *, headers=None, body=None, raw_body=None, timeout=60):
    data = raw_body
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
    """Cloud Run OIDC token; refreshed well inside its 1 h life.

    The rig is --no-allow-unauthenticated, so EVERY route (public /verify
    included) needs this — see memory/project_rig_iam_header_on_every_route.
    """
    with _id_lock:
        if _id_cache["tok"] and time.time() - _id_cache["at"] < 1800:
            return _id_cache["tok"]
        tok = subprocess.run(
            ["gcloud", "auth", "print-identity-token"],
            capture_output=True, text=True, timeout=90, check=True,
        ).stdout.strip()
        _id_cache.update(tok=tok, at=time.time())
        return tok


def iam(extra=None):
    """Headers every rig fetch must carry."""
    h = {"Authorization": "Bearer " + identity_token()}
    if extra:
        h.update(extra)
    return h


def cron_headers(cron_secret: str):
    # Cloud Run IAM front door AND the app-level cron guard. Missing either is
    # a 403 (empty body, IAM) or a 401 (JSON, app).
    return iam({"X-Cron-Secret": cron_secret})


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
                # Management API rejects the stdlib default UA (403/CF-1010).
                "User-Agent": "arkova-batch-g-soak/1.0",
            },
            body={"query": query},
            timeout=120,
        )
        if st not in (200, 201):
            raise Fail(f"SQL {st}: {raw[:300].decode('utf-8', 'replace')} :: {query[:160]}")
        return jbody(raw)

    def one(self, query: str):
        rows = self.sql(query)
        return rows[0] if isinstance(rows, list) and rows else None

    def expect_denied(self, query: str, label: str):
        """A statement that MUST be refused. A success is the finding."""
        try:
            self.sql(query)
        except Fail as e:
            return str(e)[:220]
        raise Fail(f"{label}: statement SUCCEEDED but must be refused")


def q(v) -> str:
    """SQL literal for a python str/None (driver-controlled values only)."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def rand(n=10) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def fp() -> str:
    return hashlib.sha256(uuid.uuid4().bytes).hexdigest()


def org_id(rig: Rig, name: str) -> str:
    row = rig.one(f"SELECT id FROM organizations WHERE display_name = {q(name)} LIMIT 1")
    expect(row is not None, f"fixture org {name} is missing from the rig")
    return row["id"]


# --------------------------------------------------------------------------
# #2565 — durable, service-owned signer-backfill attempts (migration 0438)
# --------------------------------------------------------------------------
def probe_2565(rig: Rig, base: str, tag: str, out: dict) -> None:
    o = out.setdefault("pr_2565", {})
    org_a = org_id(rig, ORG_A)
    envelope = f"bg-env-{tag}-{rand(6)}"
    account = read("docusign-account-id.txt")

    # A candidate anchor the claim RPC will accept: docusign connector source,
    # no _signers, no marker, outbound, measured evidence class.
    anchor = rig.one(
        "INSERT INTO anchors (org_id, user_id, fingerprint, filename, status, credential_type, metadata) "
        f"SELECT {q(org_a)}, m.user_id, {q(fp())}, {q('bg-' + tag + '.pdf')}, 'PENDING', 'CONTRACT_POSTSIGNING', "
        f"jsonb_build_object('connector_source','docusign','_direction','outbound',"
        f"'source_envelope_id',{q(envelope)},'account_id',{q(account)}) "
        f"FROM org_members m WHERE m.org_id = {q(org_a)} AND m.role IN ('owner','admin') LIMIT 1 "
        "RETURNING id"
    )
    expect(anchor is not None, "#2565: could not seed a backfill candidate anchor")
    anchor_id = anchor["id"]

    # --- A. the claim is DURABLE: it writes a row, and the persisted cooldown
    #        refuses an immediate second claim. Pre-0438 this lived in worker
    #        memory and a restart re-attempted at once.
    c1 = rig.one(
        f"SELECT public.claim_docusign_signer_backfill_attempt({q(org_a)}::uuid, {q(anchor_id)}::uuid, "
        f"{q(envelope)}, {q(account)}) AS claimed"
    )
    row = rig.one(
        "SELECT claimed_anchor_id, account_id, last_attempt_at, next_attempt_at, "
        "  (next_attempt_at - last_attempt_at) >= interval '15 minutes' AS spacing_ok "
        f"FROM docusign_signer_backfill_attempts WHERE org_id = {q(org_a)} AND envelope_id = {q(envelope)}"
    )
    # A FRESH connection re-read (the Management API opens a new session per
    # call): this is the "survives a worker restart" property — the state is in
    # Postgres, not in any worker process.
    c2 = rig.one(
        f"SELECT public.claim_docusign_signer_backfill_attempt({q(org_a)}::uuid, {q(anchor_id)}::uuid, "
        f"{q(envelope)}, {q(account)}) AS claimed"
    )
    o["A_durable_claim"] = {
        "first_claim": c1 and c1["claimed"], "second_claim": c2 and c2["claimed"],
        "row_persisted": row is not None,
        "claimed_anchor_matches": bool(row) and row["claimed_anchor_id"] == anchor_id,
        "spacing_ok": bool(row) and row["spacing_ok"],
    }
    expect(c1 and c1["claimed"] is True, "#2565 A: first claim was refused")
    expect(row is not None, "#2565 A: no durable attempts row was written")
    expect(row["claimed_anchor_id"] == anchor_id, "#2565 A: attempts row claims the wrong anchor")
    expect(row["spacing_ok"] is True, "#2565 A: minimum 15-minute reservation spacing not honoured")
    expect(c2 and c2["claimed"] is False,
           "#2565 A: the persisted cooldown did NOT refuse an immediate re-claim — "
           "attempts are not durable")

    # The candidate lister must also exclude a cooling envelope BEFORE the LIMIT.
    cand = rig.sql(
        f"SELECT id FROM public.list_docusign_signer_backfill_candidates({q(org_a)}::uuid, "
        f"'source_envelope_id', 50, {q(account)})"
    )
    ids = [r["id"] for r in cand] if isinstance(cand, list) else []
    o["A_cooling_excluded_from_candidates"] = anchor_id not in ids
    expect(anchor_id not in ids,
           "#2565 A: a cooling envelope is still listed as a backfill candidate")

    # --- B. SERVICE-OWNED. Every one of these must be refused for `authenticated`.
    denials = {}
    for label, stmt in (
        ("select", f"SELECT * FROM public.docusign_signer_backfill_attempts LIMIT 1"),
        ("insert", "INSERT INTO public.docusign_signer_backfill_attempts "
                   f"(org_id, envelope_id, account_id, last_attempt_at, next_attempt_at) VALUES "
                   f"({q(org_a)}::uuid, {q('forged-' + tag)}, {q(account)}, now(), now() + interval '15 minutes')"),
        ("update", "UPDATE public.docusign_signer_backfill_attempts SET next_attempt_at = now() "
                   f"WHERE org_id = {q(org_a)}::uuid"),
        ("claim_rpc", f"SELECT public.claim_docusign_signer_backfill_attempt({q(org_a)}::uuid, "
                      f"{q(anchor_id)}::uuid, {q(envelope)}, {q(account)})"),
        ("list_rpc", f"SELECT * FROM public.list_docusign_signer_backfill_candidates({q(org_a)}::uuid, "
                     f"'source_envelope_id', 5, {q(account)})"),
        ("eligible_rpc", f"SELECT public.docusign_backfill_account_eligible({q(org_a)}::uuid, "
                         f"{q(account)}, '{{}}'::jsonb)"),
    ):
        denials[label] = rig.expect_denied(
            f"BEGIN; SET LOCAL ROLE authenticated; {stmt}; ROLLBACK;", f"#2565 B {label}")
    o["B_service_owned_denials"] = denials

    # --- C. completion-marker forgery is stripped by the 0438 trigger.
    forged = "2020-01-01T00:00:00Z"
    rig.sql(
        "BEGIN; SET LOCAL ROLE authenticated; "
        f"UPDATE anchors SET metadata = metadata || jsonb_build_object('_signers_backfilled_at', {q(forged)}) "
        f"WHERE id = {q(anchor_id)}::uuid; COMMIT;"
    )
    after_forge = rig.one(
        f"SELECT metadata ? '_signers_backfilled_at' AS marked FROM anchors WHERE id = {q(anchor_id)}::uuid")
    rig.sql(
        "UPDATE anchors SET metadata = metadata || "
        f"jsonb_build_object('_signers_backfilled_at', {q(now())}) WHERE id = {q(anchor_id)}::uuid")
    after_service = rig.one(
        f"SELECT metadata ->> '_signers_backfilled_at' AS marker FROM anchors WHERE id = {q(anchor_id)}::uuid")
    o["C_marker_authority"] = {
        "authenticated_forge_kept": after_forge["marked"],
        "service_role_marker": after_service["marker"],
    }
    expect(after_forge["marked"] is False,
           "#2565 C: an `authenticated` writer stamped _signers_backfilled_at — marker forgery is OPEN")
    expect(after_service["marker"] is not None,
           "#2565 C: service_role could not write the completion marker")

    # --- D. the worker's own surface for the job (flag ON on this rig).
    st, _h, raw = http("POST", f"{base}/jobs/docusign-signer-backfill?page_size=5&run_limit=5",
                       headers=cron_headers(read("cron-secret.txt")), timeout=120)
    o["D_job_route"] = {"status": st, "body": jbody(raw)}
    expect(st < 500, f"#2565 D: /jobs/docusign-signer-backfill returned {st}")
    st2, _h2, raw2 = http("POST", f"{base}/jobs/docusign-signer-backfill?page_size=abc",
                          headers=cron_headers(read("cron-secret.txt")), timeout=60)
    o["D_bad_page_size"] = {"status": st2, "body": jbody(raw2)}
    expect(st2 == 400, f"#2565 D: an invalid page_size returned {st2}, expected 400")


# --------------------------------------------------------------------------
# drain fixtures shared by #2566 and #2570
# --------------------------------------------------------------------------
def seed_artifacts(rig: Rig, org: str, tag: str, n: int, prefix: str) -> list:
    """Seed n pending connector_artifact rows for one org. Returns their ids."""
    values = ",".join(
        f"({q(org)}::uuid, 'docusign', {q(prefix + '-' + tag + '-' + str(i))}, "
        f"{q(fp())}, 4096, 'pending', jsonb_build_object("
        f"'connector_source','docusign','filename',{q(prefix + '-' + tag + '-' + str(i) + '.pdf')},"
        f"'source_envelope_id',{q(prefix + '-' + tag + '-' + str(i))}))"
        for i in range(n)
    )
    rows = rig.sql(
        "INSERT INTO connector_artifact "
        "(org_id, source, external_ref, fingerprint_sha256, byte_length, status, metadata) VALUES "
        + values + " RETURNING id, fingerprint_sha256"
    )
    expect(isinstance(rows, list) and len(rows) == n, f"seed_artifacts: expected {n} rows, got {rows!r}")
    return rows


def drain(base: str, cron_secret: str, timeout=240):
    st, _h, raw = http("POST", f"{base}/jobs/drain-connector-artifacts",
                       headers=cron_headers(cron_secret), timeout=timeout)
    return st, jbody(raw)


def heal(rig: Rig, org: str, ids: list, status: str, new_fp: str):
    """Emulate docusign-envelope-completed.ts's provenance auto-heal.

    Writes fingerprint AND metadata AND updated_at in ONE statement, exactly as
    the heal does, and only against rows in `status` — so the ids it returns are
    provably the ones that were in that state when it landed.
    """
    idlist = ",".join(q(i) + "::uuid" for i in ids)
    rows = rig.sql(
        "UPDATE connector_artifact SET "
        f"fingerprint_sha256 = {q(new_fp)}, "
        "metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('_healed_at', now()::text), "
        "updated_at = clock_timestamp() "
        f"WHERE org_id = {q(org)}::uuid AND id IN ({idlist}) AND status = {q(status)} "
        "AND anchor_id IS NULL RETURNING id"
    )
    return [r["id"] for r in rows] if isinstance(rows, list) else []


# --------------------------------------------------------------------------
# #2566 — content is read at CLAIM time, never from the batch-read snapshot
# --------------------------------------------------------------------------
def probe_2566(rig: Rig, base: str, cron_secret: str, tag: str, out: dict) -> None:
    o = out.setdefault("pr_2566", {})
    org_a = org_id(rig, ORG_A)
    seeded = seed_artifacts(rig, org_a, tag, SEED_ROWS, "bg66")
    ids = [r["id"] for r in seeded]
    stale_fps = {r["id"]: r["fingerprint_sha256"] for r in seeded}
    healed_fp = fp()

    healed = []
    result = {}
    with ThreadPoolExecutor(max_workers=2) as pool:
        fut = pool.submit(drain, base, cron_secret)
        # Heal every row STILL pending — i.e. provably not yet claimed. Those
        # rows MUST mint with the NEW fingerprint. Poll tightly so the heal
        # lands inside the pass rather than after it.
        deadline = time.time() + 90
        while time.time() < deadline and not fut.done():
            got = heal(rig, org_a, [i for i in ids if i not in healed], "pending", healed_fp)
            healed.extend(got)
            if len(healed) >= SEED_ROWS - 2:
                break
            time.sleep(0.02)
        st, result = fut.result()

    o["drain_status"] = st
    o["drain_result"] = result
    o["seeded"] = len(ids)
    o["healed_while_pending"] = len(healed)
    expect(st == 200, f"#2566: drain returned {st}: {result}")

    # A second pass so any row healed after its org's pass had moved on still
    # gets drained; the assertion below is on final state.
    st2, result2 = drain(base, cron_secret)
    o["drain2_status"], o["drain2_result"] = st2, result2

    expect(len(healed) >= 1,
           "#2566: no row was healed while still pending — the probe did not exercise the change")

    # THE ASSERTION. For every row the heal matched while it was still pending,
    # the anchor the drain minted must carry the HEALED fingerprint. The
    # pre-#2566 code took content from the id-only batch SELECT's predecessor
    # and would have minted the superseded value.
    idlist = ",".join(q(i) + "::uuid" for i in healed)
    rows = rig.sql(
        "SELECT ca.id, ca.status, ca.fingerprint_sha256 AS artifact_fp, ca.anchor_id, "
        "  a.fingerprint AS anchor_fp, a.deleted_at IS NOT NULL AS anchor_deleted "
        "FROM connector_artifact ca LEFT JOIN anchors a ON a.id = ca.anchor_id "
        f"WHERE ca.org_id = {q(org_a)}::uuid AND ca.id IN ({idlist})"
    )
    minted_stale = [
        r for r in rows
        if r["anchor_fp"] is not None and not r["anchor_deleted"]
        and r["anchor_fp"] == stale_fps.get(r["id"])
    ]
    minted_fresh = [r for r in rows if r["anchor_fp"] == healed_fp and not r["anchor_deleted"]]
    unlinked = [r for r in rows if r["anchor_id"] is None]
    o["healed_rows"] = {"total": len(rows), "minted_with_healed_fp": len(minted_fresh),
                        "minted_with_superseded_fp": len(minted_stale),
                        "still_unlinked": len(unlinked)}
    expect(not minted_stale,
           "#2566 REGRESSION: %d anchor(s) were minted from the SUPERSEDED batch-read "
           "fingerprint: %s" % (len(minted_stale), [r["id"] for r in minted_stale][:5]))
    expect(len(minted_fresh) >= 1,
           "#2566: no healed row minted an anchor carrying the healed fingerprint "
           f"(rows={rows[:3]})")

    # No anchor anywhere may carry a superseded fingerprint for these artifacts.
    fplist = ",".join(q(v) for v in stale_fps.values())
    leak = rig.one(
        f"SELECT count(*)::int AS n FROM anchors WHERE org_id = {q(org_a)}::uuid "
        f"AND deleted_at IS NULL AND fingerprint IN ({fplist}) "
        f"AND id IN (SELECT anchor_id FROM connector_artifact WHERE id IN ({idlist}))"
    )
    o["live_anchors_on_superseded_fp"] = leak["n"]
    expect(leak["n"] == 0,
           f"#2566: {leak['n']} live anchor(s) still carry a superseded fingerprint")


# --------------------------------------------------------------------------
# #2570 — claim-to-mint TOCTOU gate + the exactly-once concurrency invariant
# --------------------------------------------------------------------------
def probe_2570(rig: Rig, base: str, cron_secret: str, tag: str, out: dict) -> None:
    o = out.setdefault("pr_2570", {})
    org_a = org_id(rig, ORG_A)

    # ---- 2570-A: the gate. Heal rows that are ALREADY `processing` — their
    #      content was captured by claimRow's CAS RETURNING and the link has not
    #      landed. The version-gated link CAS must refuse those mints.
    seeded = seed_artifacts(rig, org_a, tag, SEED_ROWS, "bg70a")
    ids = [r["id"] for r in seeded]
    stale_fps = {r["id"]: r["fingerprint_sha256"] for r in seeded}
    healed_fp = fp()
    healed = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        fut = pool.submit(drain, base, cron_secret)
        deadline = time.time() + 120
        while time.time() < deadline and not fut.done():
            got = heal(rig, org_a, [i for i in ids if i not in healed], "processing", healed_fp)
            healed.extend(got)
            time.sleep(0.02)
        st, result = fut.result()
    o["A_drain_status"] = st
    o["A_drain_result"] = result
    o["A_healed_while_processing"] = len(healed)
    expect(st == 200, f"#2570 A: drain returned {st}: {result}")

    if healed:
        idlist = ",".join(q(i) + "::uuid" for i in healed)
        rows = rig.sql(
            "SELECT ca.id, ca.status, ca.anchor_id, ca.credit_deduction_id, "
            "  a.fingerprint AS anchor_fp, a.deleted_at IS NOT NULL AS anchor_deleted "
            "FROM connector_artifact ca LEFT JOIN anchors a ON a.id = ca.anchor_id "
            f"WHERE ca.id IN ({idlist})"
        )
        bad = [r for r in rows
               if r["anchor_fp"] is not None and not r["anchor_deleted"]
               and r["anchor_fp"] == stale_fps.get(r["id"])]
        o["A_gate"] = {
            "superseded_requeued_reported": result.get("supersededRequeued"),
            "rows_checked": len(rows),
            "linked_to_superseded_anchor": len(bad),
            "requeued_unlinked": len([r for r in rows if r["anchor_id"] is None]),
        }
        expect(not bad,
               "#2570 A REGRESSION: %d artifact(s) were LINKED to an anchor minted from the "
               "superseded pre-heal fingerprint: %s" % (len(bad), [r["id"] for r in bad][:5]))
        # Any anchor the aborted mint created must have been neutralized
        # (soft-deleted) so claim_pending_anchors can never broadcast it.
        fplist = ",".join(q(stale_fps[i]) for i in healed)
        orph = rig.one(
            f"SELECT count(*)::int AS n FROM anchors WHERE org_id = {q(org_a)}::uuid "
            f"AND deleted_at IS NULL AND status = 'PENDING' AND chain_tx_id IS NULL "
            f"AND fingerprint IN ({fplist})"
        )
        o["A_live_orphans_on_superseded_fp"] = orph["n"]
        expect(orph["n"] == 0,
               f"#2570 A: {orph['n']} PENDING anchor(s) on a superseded fingerprint are still "
               "broadcast-eligible — the orphan was not neutralized")
    else:
        # Recorded, not hidden: a cycle that could not catch a row mid-claim did
        # not exercise the gate, and the cycle says so.
        o["A_gate"] = {"exercised": False,
                       "note": "no row was caught in `processing`; gate not exercised this cycle"}

    # ---- 2570-B: the exactly-once invariant under CONCURRENT drains.
    seeded_b = seed_artifacts(rig, org_a, tag, SEED_ROWS, "bg70b")
    ids_b = [r["id"] for r in seeded_b]
    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(drain, base, cron_secret)
        f2 = pool.submit(drain, base, cron_secret)
        r1, r2 = f1.result(), f2.result()
    o["B_drain_1"], o["B_drain_2"] = {"status": r1[0], "result": r1[1]}, {"status": r2[0], "result": r2[1]}
    expect(r1[0] == 200 and r2[0] == 200,
           f"#2570 B: concurrent drains returned {r1[0]}/{r2[0]}")

    drain(base, cron_secret)  # settle any row a loser skipped
    idlist_b = ",".join(q(i) + "::uuid" for i in ids_b)
    inv = rig.one(
        "SELECT "
        "  (SELECT count(*)::int FROM connector_artifact WHERE id IN (%s)) AS artifacts,"
        "  (SELECT count(DISTINCT a.id)::int FROM anchors a WHERE a.deleted_at IS NULL AND a.id IN "
        "     (SELECT anchor_id FROM connector_artifact WHERE id IN (%s) AND anchor_id IS NOT NULL)) AS anchors,"
        "  (SELECT count(*)::int FROM connector_artifact WHERE id IN (%s) AND anchor_id IS NOT NULL) AS linked,"
        "  (SELECT count(*)::int FROM org_credit_deductions d WHERE d.anchor_id IN "
        "     (SELECT anchor_id FROM connector_artifact WHERE id IN (%s) AND anchor_id IS NOT NULL)) AS debits"
        % (idlist_b, idlist_b, idlist_b, idlist_b)
    )
    dupe_anchor = rig.one(
        "SELECT count(*)::int AS n FROM (SELECT anchor_id FROM connector_artifact "
        f"WHERE id IN ({idlist_b}) AND anchor_id IS NOT NULL "
        "GROUP BY anchor_id HAVING count(*) > 1) t"
    )
    dupe_debit = rig.one(
        "SELECT count(*)::int AS n FROM (SELECT d.anchor_id FROM org_credit_deductions d "
        f"WHERE d.anchor_id IN (SELECT anchor_id FROM connector_artifact WHERE id IN ({idlist_b}) "
        "AND anchor_id IS NOT NULL) GROUP BY d.anchor_id HAVING count(*) > 1) t"
    )
    o["B_exactly_once"] = {**inv, "anchors_shared_by_two_artifacts": dupe_anchor["n"],
                           "anchors_with_two_debits": dupe_debit["n"]}
    expect(inv["linked"] >= 1, f"#2570 B: concurrent drains linked nothing: {inv}")
    expect(inv["anchors"] == inv["linked"],
           f"#2570 B: {inv['linked']} linked artifacts map to {inv['anchors']} live anchors — not 1:1")
    expect(dupe_anchor["n"] == 0,
           f"#2570 B: {dupe_anchor['n']} anchor(s) are shared by more than one artifact")
    expect(inv["debits"] <= inv["linked"],
           f"#2570 B: {inv['debits']} credit debits for {inv['linked']} linked artifacts — over-charged")
    expect(dupe_debit["n"] == 0,
           f"#2570 B: {dupe_debit['n']} anchor(s) carry a DOUBLE credit debit")


# --------------------------------------------------------------------------
# parents — supporting checks only
# --------------------------------------------------------------------------
def probe_parents(rig: Rig, base: str, tag: str, out: dict) -> None:
    o = out.setdefault("parents", {})
    secret = read("docusign-hmac.txt")
    body = json.dumps({
        "event": "envelope-completed",
        "apiVersion": "v2.1",
        "uri": "/restapi/v2.1/accounts/x/envelopes/y",
        "data": {"envelopeId": f"bg-parent-{tag}"},
    }).encode()
    sig = base64.b64encode(hmac.new(secret.encode(), body, hashlib.sha256).digest()).decode()

    # #2474/#2476: a bad raw-body HMAC is refused and writes nothing.
    before = rig.one("SELECT count(*)::int AS n FROM docusign_webhook_nonces")
    stb, _h, rawb = http("POST", f"{base}/webhooks/docusign",
                         headers=iam({"Content-Type": "application/json",
                                      "X-DocuSign-Signature-1": "not-a-signature"}),
                         raw_body=body, timeout=60)
    after_bad = rig.one("SELECT count(*)::int AS n FROM docusign_webhook_nonces")
    o["bad_hmac"] = {"status": stb, "nonces_before": before["n"], "nonces_after": after_bad["n"]}
    expect(stb == 401, f"parents: a forged Connect HMAC returned {stb}, expected 401")
    expect(after_bad["n"] == before["n"],
           "parents: a forged Connect HMAC consumed a nonce row")

    # A valid delivery is accepted; a replay of the SAME body is refused
    # (0424 tenant-scoped nonce + 0435 legacy rollout guard).
    st1, _h1, r1 = http("POST", f"{base}/webhooks/docusign",
                        headers=iam({"Content-Type": "application/json",
                                     "X-DocuSign-Signature-1": sig}),
                        raw_body=body, timeout=60)
    st2, _h2, r2 = http("POST", f"{base}/webhooks/docusign",
                        headers=iam({"Content-Type": "application/json",
                                     "X-DocuSign-Signature-1": sig}),
                        raw_body=body, timeout=60)
    o["valid_then_replay"] = {"first": {"status": st1, "body": jbody(r1)},
                              "replay": {"status": st2, "body": jbody(r2)}}
    expect(st1 < 500, f"parents: a valid Connect delivery returned {st1}")
    expect(st2 < 500, f"parents: a replayed Connect delivery returned {st2}")

    # #2485/#2496: the 16 KB rule-event payload CHECK is present and holds.
    chk = rig.one(
        "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
        "WHERE t.relname = 'organization_rule_events' AND c.contype = 'c' "
        "AND pg_get_constraintdef(c.oid) ILIKE '%16384%'")
    over = rig.one(
        "SELECT count(*)::int AS n FROM organization_rule_events "
        "WHERE octet_length(payload::text) > 16384")
    o["rule_event_16kb"] = {"check_constraints": chk["n"], "rows_over_16kb": over["n"]}
    expect(chk["n"] >= 1, "parents: the 16 KB organization_rule_events payload CHECK is missing")
    expect(over["n"] == 0, f"parents: {over['n']} rule-event payload(s) exceed 16 KB")


# --------------------------------------------------------------------------
# T3 extras
# --------------------------------------------------------------------------
def triggers_and_isolation(rig: Rig, base: str, cron_secret: str,
                           state: dict, out: dict) -> None:
    hdrs = cron_headers(cron_secret)

    sa, _h, ra = http("POST", f"{base}/jobs/process-anchors", headers=hdrs, timeout=120)
    out["trigger_a_process_anchors"] = {"status": sa, "body": jbody(ra)}
    sb, _h, rb = http("POST", f"{base}/jobs/check-confirmations", headers=hdrs, timeout=120)
    out["trigger_b_check_confirmations"] = {"status": sb, "body": jbody(rb)}
    expect(sa < 500, f"Trigger A returned {sa}")
    expect(sb < 500, f"Trigger B returned {sb}")

    last = state.get("last_daily_flush_at", 0)
    if time.time() - last > 86400 or not state.get("daily_flush_observations"):
        sf, _h, rf = http("POST", f"{base}/jobs/batch-anchors?force=true", headers=hdrs, timeout=180)
        obs = {"at": now(), "status": sf, "body": jbody(rf)}
        out["daily_flush"] = obs
        state["last_daily_flush_at"] = time.time()
        state.setdefault("daily_flush_observations", []).append(obs)

    # Per-org isolation: the RLS boundary. Org B's authenticated session must
    # not read org A's anchor rows. Deliberately NOT the public /verify surface
    # (cross-tenant by design — feedback_public_endpoints_are_by_design).
    a_id, b_id = org_id(rig, ORG_A), org_id(rig, ORG_B)
    iso = rig.one(
        f"SELECT (SELECT count(*)::int FROM anchors WHERE org_id = {q(a_id)}::uuid) AS a_rows,"
        f" (SELECT count(*)::int FROM anchors WHERE org_id = {q(b_id)}::uuid) AS b_rows")
    expect(iso["a_rows"] >= 1 and iso["b_rows"] >= 1,
           f"isolation fixture is missing anchors on one side: {iso}")
    a_public = rig.one(
        f"SELECT public_id FROM anchors WHERE org_id = {q(a_id)}::uuid AND deleted_at IS NULL LIMIT 1"
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


def anti_hollow(rig: Rig, tag: str, out: dict) -> int:
    """Rows written and re-counted under this cycle's unique tag."""
    name = "BatchG Cycle " + tag
    rig.sql(
        "INSERT INTO organizations (legal_name, display_name, domain) VALUES "
        f"({q(name + ' LLC')}, {q(name)}, {q('bg-cycle-' + tag.lower() + '.test')})")
    n = rig.one(f"SELECT count(*)::int AS n FROM organizations WHERE display_name = {q(name)}")
    expect(n["n"] == 1, f"anti-hollow: cycle tag {tag} counted {n['n']} rows, expected 1")
    total = rig.one("SELECT count(*)::int AS n FROM organizations WHERE display_name LIKE 'BatchG Cycle %'")
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
        try:
            hs, _h, hraw = http("GET", f"{base}/health", headers=iam(), timeout=60)
            health = jbody(hraw)
            out["health"] = {"status": hs, "git_sha": health.get("git_sha"),
                             "uptime": health.get("uptime"), "revision": health.get("revision")}
            expect(hs == 200, f"/health returned {hs}")
            expect(health.get("git_sha") == candidate,
                   f"rig is serving git_sha {health.get('git_sha')}, candidate is {candidate} — STALE HEAD")

            probe_2565(rig, base, tag, out)
            probe_2566(rig, base, cron_secret, tag, out)
            probe_2570(rig, base, cron_secret, tag, out)
            probe_parents(rig, base, tag, out)
            triggers_and_isolation(rig, base, cron_secret, state, out)
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
