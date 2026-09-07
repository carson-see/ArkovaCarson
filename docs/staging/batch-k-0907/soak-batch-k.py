#!/usr/bin/env python3
"""Batch-K T3 soak driver — #2524 (bitcoin tx-inclusion branch, migration 0427),
#2527 (three-state verification verdict), #2499 (declared-hash anchors must not
claim a Measured fetch-time fingerprint).

Every cycle re-asserts the worker identity (/health git_sha == candidate SHA,
monotonic uptime, 100% traffic on the declared revision), the candidate source
head, and this file's own hash, then drives the three PRs' CHANGED BEHAVIOR over
real HTTP against a real isolated Postgres. A cycle that fails any assertion is
recorded FAIL and the window stops.

SCOPE / NOT-ASSERTED (§1.5). The block-125552 header, block hash, txids and
inclusion branches are REAL Bitcoin mainnet data, and the branch fold is
recomputed here independently of the worker. The OP_RETURN payload and the
app-tree leaves are SYNTHETIC: block 125552 carries no Arkova commitment. No
claim is made that any Arkova record is included in that block, nor about
production data. The chain client is mocked (ENABLE_PROD_NETWORK_ANCHORING=false),
so batch/confirmation triggers exercise the worker's own lifecycle code, not a
real broadcast.

Runs detached (PPID 1) for 48 h, 5-minute cycles.
"""
import datetime, hashlib, json, os, pathlib, subprocess, time, urllib.error, urllib.request

H = pathlib.Path(os.path.expanduser("~/arkova-soak/batch-k-0907"))
A = json.loads((H / "admission.json").read_text())
F = json.loads((H / "fixture.json").read_text())
ISO = json.loads((H / "iso-orgs.json").read_text())
MG = (H / "supabase-access.txt").read_text().strip()
CRON = (H / "cron-secret.txt").read_text().strip()
WT = pathlib.Path(A["worktree"])
REF = A["project_ref"]
BASE = A["tag_url"]
CYC = H / "cycles"; CYC.mkdir(exist_ok=True)
ENV = dict(os.environ)
utc = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
d2 = lambda b: hashlib.sha256(hashlib.sha256(b).digest()).digest()
le = lambda h: bytes.fromhex(h)[::-1]
SVC = ("SELECT set_config('request.jwt.claim.role','service_role',true),"
       " set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);")


def sql(q):
    req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/database/query",
                                 method="POST", data=json.dumps({"query": q}).encode())
    req.add_header("Authorization", "Bearer " + MG)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "arkova-batch-k-soak/1.0")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def http(path, method="GET", cron=False, timeout=90):
    """Every route on a --no-allow-unauthenticated rig needs the IAM header —
    'public' verify routes included (memory: rig-iam-header-on-every-route)."""
    hdr = {"X-Serverless-Authorization": "Bearer " + iam, "Content-Type": "application/json"}
    if cron:
        hdr["X-Cron-Secret"] = CRON
    req = urllib.request.Request(BASE + path, method=method,
                                 data=b"{}" if method == "POST" else None, headers=hdr)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            # An EMPTY body on a non-2xx is Cloud Run's IAM front door, not the app.
            return e.code, {"_raw": raw.decode("utf-8", "replace")[:400]}


# ---------------------------------------------------------------- assertions
def check_2524(out):
    """#2524: the bitcoin-tree inclusion branch is persisted AND published, and
    folds to the real block header's merkleroot when recomputed here."""
    root_le = bytes.fromhex(F["block"]["block_header"])[36:68]
    for r in F["records"]:
        st, b = http("/api/v1/verify/%s/proof" % r["public_id"])
        assert st == 200, (r["public_id"], st, b)
        bundle = b.get("proof_bundle")
        assert bundle, ("proof_bundle must not be null for a complete record", r["public_id"], b)
        assert bundle["tx_block_index"] == r["index"], (r["public_id"], bundle["tx_block_index"])
        assert bundle["tx_inclusion_branch"] == r["tx_branch"], (r["public_id"], "branch not published verbatim")
        assert bundle["block_hash"] == F["block"]["block_hash"]
        assert bundle["tx_id"] == r["txid"]
        node = le(r["txid"])
        for s in bundle["tx_inclusion_branch"]:
            o = le(s["hash"])
            node = d2((o + node) if s["position"] == "left" else (node + o))
        assert node == root_le, ("independent bitcoin-tree fold failed", r["public_id"])
        out.append({"case": "tx-inclusion branch published + independently folded",
                    "public_id": r["public_id"], "tx_block_index": bundle["tx_block_index"],
                    "branch_len": len(bundle["tx_inclusion_branch"])})
    # DB half: the branch is PERSISTED, not synthesised per request.
    rows = sql("SELECT count(*)::int AS n FROM anchor_proofs "
               "WHERE tx_inclusion_branch IS NOT NULL AND tx_block_index IS NOT NULL")
    assert rows[0]["n"] == 4, rows
    out.append({"case": "0427 columns persisted", "rows": rows[0]["n"]})


def check_2527(out):
    """#2527: the tri-state verdict travels ALONGSIDE the boolean and never
    contradicts it. All three outcomes are driven for real, then restored."""
    for r in F["records"]:
        st, b = http("/api/v1/verify/%s/proof" % r["public_id"])
        assert st == 200 and b.get("verified") is True and b.get("verdict") == "valid", (r["public_id"], st, b)
        assert b.get("verdict_note"), "a verdict must never travel without its §1.5 note"
    out.append({"case": "verdict=valid alongside verified=true", "records": len(F["records"])})

    pid = F["records"][0]["public_id"]
    orig = sql("SELECT p.anchor_id, p.merkle_index, p.proof_path FROM anchor_proofs p "
               "JOIN anchors a ON a.id=p.anchor_id WHERE a.public_id='%s'" % pid)[0]
    aid = orig["anchor_id"]
    try:
        sql(SVC + "UPDATE anchor_proofs SET merkle_index=NULL WHERE anchor_id='%s'::uuid;" % aid)
        st, b = http("/api/v1/verify/%s/proof" % pid)
        assert st == 200 and b["verified"] is True and b["verdict"] == "unverifiable", (st, b)
        out.append({"case": "no structural index -> unverifiable, verified still true",
                    "http": st, "verdict": b["verdict"]})

        bad = [dict(x) for x in orig["proof_path"]]
        bad[0]["hash"] = "0" * 64
        sql(SVC + "UPDATE anchor_proofs SET merkle_index=%d, proof_path='%s'::jsonb WHERE anchor_id='%s'::uuid;"
            % (orig["merkle_index"], json.dumps(bad), aid))
        st, b = http("/api/v1/verify/%s/proof" % pid)
        assert st == 200 and b["verified"] is False and b["verdict"] == "invalid", (st, b)
        out.append({"case": "well-formed false proof -> invalid, verified false",
                    "http": st, "verdict": b["verdict"]})

        sql(SVC + "UPDATE anchor_proofs SET proof_path='\"broken\"'::jsonb WHERE anchor_id='%s'::uuid;" % aid)
        st, b = http("/api/v1/verify/%s/proof" % pid)
        assert st == 500 and "verdict" not in b, ("malformed extraction must carry NO verdict", st, b)
        out.append({"case": "malformed stored proof -> 500 with no verdict", "http": st})
    finally:
        sql(SVC + "UPDATE anchor_proofs SET merkle_index=%d, proof_path='%s'::jsonb WHERE anchor_id='%s'::uuid;"
            % (orig["merkle_index"], json.dumps(orig["proof_path"]), aid))
    st, b = http("/api/v1/verify/%s/proof" % pid)
    assert st == 200 and b["verdict"] == "valid", ("restore failed", st, b)
    out.append({"case": "restored to valid", "http": st, "verdict": b["verdict"]})


def check_2499(out):
    """#2499: a connector-SOURCED anchor is not a connector-FETCHED one. The
    DECLARED row must carry NO re-derivability statement at all; the MEASURED
    positive control must still carry one (over-suppression is its own bug);
    the INBOUND row must be the strictly weaker declared_unverified class."""
    cases = [("ARK-BK-2499-DECLARED", None),
             ("ARK-BK-2499-MEASURED", "fetch_time_snapshot"),
             ("ARK-BK-2499-INBOUND", "declared_unverified")]
    for pid, expected in cases:
        for path in ("/api/v1/verify/%s" % pid, "/api/v1/verify/%s/proof" % pid):
            st, b = http(path)
            assert st in (200, 404), (path, st, b)
            if st != 200:
                continue
            if expected is None:
                assert "fingerprint_rederivability" not in b and "fingerprint_rederivability_note" not in b, \
                    ("declared-hash anchor falsely claims a fetch-time fingerprint", path, b)
            else:
                assert b.get("fingerprint_rederivability") == expected, (path, b.get("fingerprint_rederivability"))
                assert b.get("fingerprint_rederivability_note"), (path, "class travelled without its note")
            out.append({"case": "rederivability class", "path": path,
                        "expected": expected, "got": b.get("fingerprint_rederivability")})


def triggers(out, cycle):
    """T3: Trigger A (batch-anchors), Trigger B (check-confirmations), per-org
    isolation on the org-scoped flush, and a once-daily unscoped flush."""
    st, b = http("/jobs/check-confirmations", "POST", cron=True)
    assert st == 200, ("Trigger B", st, b)
    out.append({"case": "Trigger B: check-confirmations", "http": st, "body": b})

    if cycle == 1 or cycle % 12 == 0:
        for side, o in ISO.items():
            sql(SVC + ("INSERT INTO anchors (org_id, public_id, fingerprint, status, filename, credential_type, metadata) "
                       "SELECT '%s'::uuid, 'ARK-BK-ISO%s-C%d-'||n, encode(sha256(('bk-iso-%s-c%d-'||n)::bytea),'hex'),"
                       " 'PENDING','bk-iso-%s.pdf','OTHER',"
                       " jsonb_build_object('_fixture',true,'_synthetic',true,'soak_batch','batch-k-0907','soak_stage','isolation')"
                       " FROM generate_series(1,3) n;" % (o, side, cycle, side, cycle, side)))
        before = sql("SELECT org_id::text AS org_id, count(*)::int AS n FROM anchors "
                     "WHERE metadata->>'soak_stage'='isolation' AND status='PENDING' GROUP BY 1")
        bmap = {r["org_id"]: r["n"] for r in before}
        st, b = http("/jobs/batch-anchors?force=true&org_id=%s" % ISO["A"], "POST", cron=True)
        assert st == 200 and b.get("processed", 0) > 0, ("Trigger A org-scoped", st, b)
        after = sql("SELECT org_id::text AS org_id, count(*)::int AS n FROM anchors "
                    "WHERE metadata->>'soak_stage'='isolation' AND status='PENDING' GROUP BY 1")
        amap = {r["org_id"]: r["n"] for r in after}
        assert amap.get(ISO["B"], 0) == bmap.get(ISO["B"], 0), \
            ("org-scoped flush consumed the neighbour's workload", bmap, amap)
        assert amap.get(ISO["A"], 0) < bmap.get(ISO["A"], 0), ("org A not drained", bmap, amap)
        out.append({"case": "Trigger A org-scoped flush + per-org isolation",
                    "processed": b.get("processed"), "before": bmap, "after": amap})

    global last_flush
    if time.time() - last_flush >= 24 * 3600:
        for side, o in ISO.items():
            sql(SVC + ("INSERT INTO anchors (org_id, public_id, fingerprint, status, filename, credential_type, metadata) "
                       "SELECT '%s'::uuid,'ARK-BK-FLUSH%s-C%d-'||n, encode(sha256(('bk-flush-%s-c%d-'||n)::bytea),'hex'),"
                       " 'PENDING','bk-flush.pdf','OTHER',"
                       " jsonb_build_object('_fixture',true,'_synthetic',true,'soak_batch','batch-k-0907','soak_stage','flush')"
                       " FROM generate_series(1,2) n;" % (o, side, cycle, side, cycle)))
        st, b = http("/jobs/batch-anchors?force=true", "POST", cron=True)
        assert st == 200 and b.get("processed", 0) > 0, ("daily flush", st, b)
        S.setdefault("flushes", []).append(utc(time.time()))
        last_flush = time.time()
        out.append({"case": "daily unscoped flush", "processed": b.get("processed")})


def anti_hollow(out, cycle):
    """A cycle must leave a mark in the rig it claims to be observing."""
    tag = "BK-CYCLE-%05d" % cycle
    sql(SVC + ("INSERT INTO anchors (org_id, public_id, fingerprint, status, filename, credential_type, metadata) "
               "SELECT '%s'::uuid,'%s', encode(sha256('%s'::bytea),'hex'),'PENDING','bk-cycle.pdf','OTHER',"
               " jsonb_build_object('_fixture',true,'_synthetic',true,'soak_batch','batch-k-0907','soak_stage','cycle')"
               " WHERE NOT EXISTS (SELECT 1 FROM anchors WHERE public_id='%s');" % (ISO["A"], tag, tag, tag)))
    n = sql("SELECT count(*)::int AS n FROM anchors WHERE public_id='%s'" % tag)[0]["n"]
    assert n == 1, ("anti-hollow tagged row not readable back", tag, n)
    out.append({"case": "anti-hollow tagged row written and re-counted", "tag": tag})


# ---------------------------------------------------------------------- main
SELF = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
start = time.time()
end = start + 48 * 3600
last_flush = start
S = {"prs": [2524, 2527, 2499], "sha": A["sha"], "base_sha": A["base_sha"],
     "project_ref": REF, "cloud_run_service": A["cloud_run_service"],
     "revision": A["deployed_revision"], "image_digest": A["image_digest"],
     "tag_url": BASE, "driver_sha256": SELF, "started_at": utc(start),
     "not_before": utc(end), "status": "running", "cycles": 0, "failures": 0,
     "scope": ("Real HTTP against an isolated rig: bitcoin tx-inclusion branch persisted+published and "
               "independently folded against a REAL mainnet block-125552 header; three-state verdict driven "
               "through all three outcomes; declared/measured/inbound fingerprint classes. OP_RETURN payload "
               "and app-tree leaves are synthetic and the chain client is mocked — no production claim and no "
               "claim that any Arkova record is in block 125552.")}


def save():
    p = H / "status.tmp"
    p.write_text(json.dumps(S, indent=2))
    p.replace(H / "status.json")


save()
last_uptime = None
last_tick = None
try:
    while True:
        tick = time.time()
        i = S["cycles"] + 1
        if last_tick is not None:
            assert tick - last_tick < 900, "observation continuity gap exceeds 15 minutes"
        last_tick = tick
        assert hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest() == SELF, "driver drift"
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=WT, text=True).strip() == A["sha"], \
            "candidate source head drift"
        run = json.loads(subprocess.check_output(
            ["gcloud", "run", "services", "describe", A["cloud_run_service"], "--project=arkova1",
             "--region=us-central1", "--format=json"], env=ENV, text=True))
        assert any(t.get("revisionName") == A["deployed_revision"] and t.get("percent") == 100
                   for t in run["status"]["traffic"]), "worker revision drift"
        iam = subprocess.check_output(["gcloud", "auth", "print-identity-token"], env=ENV, text=True).strip()
        st, h = http("/health")
        assert st == 200 and h.get("git_sha") == A["sha"], ("wrong worker identity", st, h)
        assert h.get("status") == "healthy", h
        if last_uptime is not None:
            assert h["uptime"] >= last_uptime, "worker uptime reset — the soak clock restarted"
        last_uptime = h["uptime"]

        checks = []
        check_2524(checks)
        check_2527(checks)
        check_2499(checks)
        triggers(checks, i)
        anti_hollow(checks, i)

        rec = {"cycle": i, "at": utc(time.time()), "git_sha": h["git_sha"],
               "worker_uptime": h["uptime"], "checks": checks, "allExpected": True}
        (CYC / ("%05d.json" % i)).write_text(json.dumps(rec, indent=2))
        S.update(cycles=i, last_cycle_at=rec["at"], last_worker_uptime=h["uptime"])
        save()
        print("cycle", i, "PASS", len(checks), "assertions", flush=True)
        if time.time() >= end:
            assert S.get("flushes"), "daily flush never observed"
            S.update(status="completed_pending_review", completed_at=utc(time.time()))
            save()
            break
        time.sleep(max(1, 300 - (time.time() - tick)))
except BaseException as e:
    S.update(status="failed", failures=S["failures"] + 1, error=repr(e)[:2000],
             failed_at=utc(time.time()))
    save()
    raise
