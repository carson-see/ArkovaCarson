#!/usr/bin/env python3
"""Local SQL regression, not full-schema or soak evidence.

Requires PostgreSQL17 binaries and a NEW output directory. Example:
python3 services/worker/scripts/test-docusign-backfill-attempts.py \
  --pg-bin /path/to/postgresql/bin --output /external/evidence/new-run
All writes target an owned disposable cluster on a private Unix socket.
"""

import argparse
import datetime
import hashlib
import json
from pathlib import Path
from lib.local_postgres import LocalPostgres, quote

if not __debug__:
    raise RuntimeError("Assertions must be enabled for this regression")
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--pg-bin", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
migration = repo / "supabase/migrations/0438_docusign_backfill_attempt_authority.sql"
A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
U = "11111111-1111-4111-8111-111111111111"
I = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
J = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
ACCOUNT = "account-a"
OTHER_ACCOUNT = "account-b"
checks = []


def role(name):
    return (
        "SET ROLE "
        + name
        + "; SET request.jwt.claims="
        + quote(json.dumps({"role": name, "sub": U}))
        + "; "
    )


def passed(case):
    checks.append({"case": case, "passed": True})
    print("PASS", case, flush=True)


with LocalPostgres(args.output, args.pg_bin) as db:
    baseline = (
        repo / "supabase/migrations/00000000000000_baseline_at_main_HEAD.sql"
    ).read_text()
    start = baseline.index('CREATE OR REPLACE FUNCTION "public"."get_caller_role"')
    caller = baseline[start : baseline.index("\nALTER FUNCTION ", start)]
    db.query(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE org_integrations(org_id uuid,provider text,account_id text,revoked_at timestamptz); CREATE TABLE member_integrations(org_id uuid,provider text,account_id text,revoked_at timestamptz); CREATE TABLE anchors(id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES organizations,user_id uuid NOT NULL,metadata jsonb DEFAULT '{}',fingerprint_source text,deleted_at timestamptz,created_at timestamptz DEFAULT now()); ALTER TABLE anchors ENABLE ROW LEVEL SECURITY; ALTER TABLE anchors FORCE ROW LEVEL SECURITY; CREATE POLICY own_anchor ON anchors TO authenticated USING(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid) WITH CHECK(user_id=(current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid); GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role; GRANT SELECT,INSERT,UPDATE ON anchors TO authenticated; GRANT ALL ON anchors,organizations,org_integrations,member_integrations TO service_role; "
        + caller
    )
    db.query(
        "INSERT INTO organizations VALUES ("
        + quote(A)
        + "),("
        + quote(B)
        + "); INSERT INTO org_integrations(org_id,provider,account_id) VALUES ("
        + quote(A)
        + ",'docusign',"
        + quote(ACCOUNT)
        + ");"
    )
    # Before the new migration exists, this test deliberately exercises the old
    # behavior: authenticated metadata can forge completion. It must fail RED.
    if migration.exists():
        db.query(migration.read_text())
    db.query(
        role("authenticated")
        + "INSERT INTO anchors(id,org_id,user_id,metadata) VALUES ("
        + ",".join(map(quote, [I, A, U]))
        + ',\'{"connector_source":"docusign","external_ref":"envelope-1","_signers_backfilled_at":"forged"}\');'
    )
    metadata = db.value("SELECT metadata FROM anchors WHERE id=" + quote(I))
    assert (
        "_signers_backfilled_at" not in metadata
    ), "authenticated user forged the completion marker"
    passed("authenticated INSERT cannot forge completion marker")
    db.query(
        role("service_role")
        + 'UPDATE anchors SET metadata=metadata||\'{"_signers_backfilled_at":"trusted"}\' WHERE id='
        + quote(I)
    )
    db.query(
        role("authenticated")
        + 'UPDATE anchors SET metadata=metadata-\'_signers_backfilled_at\'||\'{"_signers_backfilled_at":"forged2","user_note":"retained"}\' WHERE id='
        + quote(I)
    )
    metadata = db.value("SELECT metadata FROM anchors WHERE id=" + quote(I))
    assert (
        metadata["_signers_backfilled_at"] == "trusted"
        and metadata["user_note"] == "retained"
    )
    passed("authenticated UPDATE preserves trusted marker and unrelated metadata")
    db.query(
        role("authenticated")
        + "UPDATE anchors SET metadata='[1,2]' WHERE id="
        + quote(I)
    )
    assert (
        db.value("SELECT metadata FROM anchors WHERE id=" + quote(I))[
            "_signers_backfilled_at"
        ]
        == "trusted"
    )
    passed("non-object metadata cannot erase a protected completion marker")
    db.query(
        role("service_role")
        + "UPDATE anchors SET metadata=metadata-'_signers_backfilled_at' WHERE id="
        + quote(I)
    )
    claim = (
        "SELECT to_jsonb(public.claim_docusign_signer_backfill_attempt("
        + ",".join(map(quote, [A, I, "envelope-1", ACCOUNT]))
        + "))"
    )
    for name in ["anon", "authenticated"]:
        assert db.query(role(name) + claim, success=False).returncode != 0
        passed(name + " cannot reserve or inspect service-only attempt state")
    # An inherited org-level marker has no account credentials; one real
    # member grant still constitutes exactly one active DocuSign account.
    db.query(
        "UPDATE org_integrations SET account_id=NULL; INSERT INTO member_integrations(org_id,provider,account_id) VALUES ("
        + quote(A)
        + ",'docusign',"
        + quote(ACCOUNT)
        + ");"
    )
    assert (
        db.value(role("service_role") + claim) is True
    ), "NULL inherited marker incorrectly makes a single member account ambiguous"
    passed("credential-free inherited marker does not block the sole member account")
    db.query(
        "DELETE FROM member_integrations; UPDATE org_integrations SET account_id="
        + quote(ACCOUNT)
        + "; TRUNCATE docusign_signer_backfill_attempts;"
    )
    assert db.value(role("service_role") + claim) is True
    assert db.value(role("service_role") + claim) is False
    passed("server cooldown refuses a repeated attempt")
    # Retry failures and metadata-CAS failures cannot undo this reservation.
    assert (
        db.value("SELECT to_jsonb(count(*)) FROM docusign_signer_backfill_attempts")
        == 1
    )
    assert (
        db.value(
            role("service_role")
            + "SELECT to_jsonb(public.claim_docusign_signer_backfill_attempt("
            + ",".join(map(quote, [B, I, "envelope-1", ACCOUNT]))
            + "))"
        )
        is False
    )
    passed("wrong-org anchor claim leaves attempt state unchanged")
    # A different anchor for the SAME envelope shares one attempt budget.
    db.query(
        role("service_role")
        + "INSERT INTO anchors(id,org_id,user_id,metadata) VALUES ("
        + ",".join(map(quote, [J, A, U]))
        + ',\'{"connector_source":"docusign","external_ref":"envelope-1"}\');'
    )
    duplicate = (
        "SELECT to_jsonb(public.claim_docusign_signer_backfill_attempt("
        + ",".join(map(quote, [A, J, "envelope-1", ACCOUNT]))
        + "))"
    )
    assert db.value(role("service_role") + duplicate) is False
    passed("duplicate anchor for same org/envelope cannot poll twice")
    # A cooling first candidate does not hide a later eligible envelope.
    db.query(
        role("service_role")
        + "UPDATE anchors SET metadata=jsonb_set(metadata,'{external_ref}','\"envelope-2\"') WHERE id="
        + quote(J)
    )
    candidates = (
        "SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM public.list_docusign_signer_backfill_candidates("
        + quote(A)
        + ",'external_ref',1,"
        + quote(ACCOUNT)
        + ")"
    )
    assert db.value(role("service_role") + candidates) == [J]
    passed("due-candidate query advances past a cooling envelope")
    db.query(
        "UPDATE docusign_signer_backfill_attempts SET last_attempt_at=now()-interval '16 minutes',next_attempt_at=now()-interval '1 minute';"
    )
    assert db.value(role("service_role") + claim) is True
    passed("elapsed cooldown permits a paced retry")
    db.query("TRUNCATE docusign_signer_backfill_attempts;")
    first = db.session("backfill-first-claim")
    second = db.session("backfill-second-claim")
    first.write("BEGIN; " + role("service_role") + claim + ";")
    assert first.read() == "true"
    second.write("BEGIN; " + role("service_role") + claim + ";")
    db.wait_for_lock("backfill-second-claim")
    first.write("COMMIT;")
    assert second.read() == "false"
    second.write("COMMIT;")
    assert (
        db.value("SELECT to_jsonb(count(*)) FROM docusign_signer_backfill_attempts")
        == 1
    )
    passed("concurrent SQL sessions grant exactly one envelope attempt")
    # Ambiguous legacy rows must not let the first wrong account monopolize
    # the org/envelope attempt. Known owning-account metadata selects one.
    db.query(
        "TRUNCATE docusign_signer_backfill_attempts; INSERT INTO member_integrations(org_id,provider,account_id) VALUES ("
        + quote(A)
        + ",'docusign',"
        + quote(OTHER_ACCOUNT)
        + ");"
    )
    assert db.value(role("service_role") + claim) is False
    assert db.value(role("service_role") + candidates) == []
    passed("ambiguous legacy envelope is neither selected nor reserved")
    db.query(
        role("service_role")
        + "UPDATE anchors SET metadata=metadata||jsonb_build_object('account_id',"
        + quote(ACCOUNT)
        + ") WHERE id="
        + quote(I)
    )
    wrong_account = (
        "SELECT to_jsonb(public.claim_docusign_signer_backfill_attempt("
        + ",".join(map(quote, [A, I, "envelope-1", OTHER_ACCOUNT]))
        + "))"
    )
    assert db.value(role("service_role") + wrong_account) is False
    assert db.value(role("service_role") + claim) is True
    passed("only the active account identified by metadata gets a claim")
    db.query("TRUNCATE docusign_signer_backfill_attempts;")
    db.query(
        role("service_role")
        + "UPDATE anchors SET metadata=metadata||jsonb_build_object('_sending_account_id',"
        + quote(OTHER_ACCOUNT)
        + ") WHERE id="
        + quote(I)
    )
    assert db.value(role("service_role") + claim) is False
    passed("conflicting server account metadata fails closed")
    db.query(
        role("service_role")
        + "UPDATE anchors SET metadata=metadata-'_sending_account_id' WHERE id="
        + quote(I)
    )
    for name, assignment in [
        ("inbound", 'metadata=metadata||\'{"_direction":"inbound"}\''),
        ("declared inbound", "fingerprint_source='issuer_record_attestation'"),
        ("deleted", "deleted_at=now()"),
        ("completed", 'metadata=metadata||\'{"_signers_backfilled_at":"done"}\''),
        ("wrong connector", 'metadata=metadata||\'{"connector_source":"other"}\''),
    ]:
        saved = db.value("SELECT to_jsonb(a) FROM anchors a WHERE id=" + quote(I))
        db.query(
            role("service_role")
            + "UPDATE anchors SET "
            + assignment
            + " WHERE id="
            + quote(I)
        )
        assert db.value(role("service_role") + claim) is False
        assert (
            db.value("SELECT to_jsonb(count(*)) FROM docusign_signer_backfill_attempts")
            == 0
        )
        db.query(
            role("service_role")
            + "UPDATE anchors SET metadata="
            + quote(json.dumps(saved["metadata"]))
            + "::jsonb,fingerprint_source=NULL,deleted_at=NULL WHERE id="
            + quote(I)
        )
        passed(name + " cannot reserve an attempt or call the provider")
    db.query(
        "UPDATE org_integrations SET revoked_at=now() WHERE account_id="
        + quote(ACCOUNT)
    )
    assert db.value(role("service_role") + claim) is False
    passed("revoked integration cannot reserve a backfill attempt")
    # Operational rollback retains security protections and the durable
    # reservation; reapply only the exact RPC definitions from the migration.
    db.query(
        "UPDATE org_integrations SET revoked_at=NULL WHERE account_id=" + quote(ACCOUNT)
    )
    assert db.value(role("service_role") + claim) is True
    durable = db.value(
        "SELECT jsonb_agg(to_jsonb(a) ORDER BY org_id,envelope_id) FROM docusign_signer_backfill_attempts a"
    )
    rpc_names = [
        "list_docusign_signer_backfill_candidates(uuid,text,integer,text)",
        "claim_docusign_signer_backfill_attempt(uuid,uuid,text,text)",
        "docusign_backfill_account_eligible(uuid,text,jsonb)",
    ]
    original_definitions = db.value(
        "SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('list_docusign_signer_backfill_candidates','claim_docusign_signer_backfill_attempt','docusign_backfill_account_eligible')"
    )
    db.query(
        "BEGIN; "
        + "".join("DROP FUNCTION public." + name + ";" for name in rpc_names)
        + "COMMIT;"
    )
    assert (
        db.value(
            "SELECT jsonb_agg(to_jsonb(a) ORDER BY org_id,envelope_id) FROM docusign_signer_backfill_attempts a"
        )
        == durable
    )
    assert (
        db.value(
            "SELECT to_jsonb(count(*)) FROM pg_trigger WHERE tgname='trg_strip_unattested_docusign_backfill_marker'"
        )
        == 1
    )
    passed("committed rollback retains reservations and completion-marker protection")
    source = migration.read_text()
    rpc_sql = source[
        source.index(
            "CREATE OR REPLACE FUNCTION public.docusign_backfill_account_eligible"
        ) : source.index("NOTIFY pgrst, 'reload schema';")
    ]
    db.query("BEGIN; " + rpc_sql + "NOTIFY pgrst, 'reload schema'; COMMIT;")
    actual_definitions = db.value(
        "SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('list_docusign_signer_backfill_candidates','claim_docusign_signer_backfill_attempt','docusign_backfill_account_eligible')"
    )
    assert actual_definitions == original_definitions
    assert db.value(role("service_role") + claim) is False
    assert (
        db.value(
            "SELECT jsonb_agg(to_jsonb(a) ORDER BY org_id,envelope_id) FROM docusign_signer_backfill_attempts a"
        )
        == durable
    )
    passed("exact RPC reapply restores definitions and ACLs without erasing cooldown")
    (db.output / "result.json").write_text(
        json.dumps(
            {
                "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "checks": checks,
                "migration_sha256": hashlib.sha256(migration.read_bytes()).hexdigest(),
                "qualification": "isolated local focused schema only",
            },
            indent=2,
        )
    )
