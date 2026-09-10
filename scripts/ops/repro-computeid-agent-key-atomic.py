#!/usr/bin/env python3
"""SCRUM-4535 / SCRUM-4536 / SCRUM-4558 / SCRUM-4559: reproduce old bugs and verify migration 0448.

Usage: python3 scripts/ops/repro-computeid-agent-key-atomic.py [--output receipt.json]
Requires Docker and its local postgres:17 image. Creates one uniquely named,
network-disabled, unpublished, temporary database and removes it in finally.
Accepts no database URL or external target; cannot connect to staging or production.

Uses actual baseline enum/table column definitions and CHECKs, with real concurrent
PostgreSQL sessions and fault-injection triggers. This targeted fixture does not
replay the entire production catalog, RLS, foreign keys, or hosted PostgREST.
The signed HTTP and binding tests separately cover authentication/event ordering.
"""
import argparse
import json
import pathlib
import re
import signal
import subprocess
import time
import uuid

SOURCE = pathlib.Path(__file__).resolve().parents[2]
CONTAINER = 'arkova-computeid-repro-' + uuid.uuid4().hex[:12]
PSQL = ['docker', 'exec', '-i', CONTAINER, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres']

ORG = '11111111-1111-1111-1111-111111111111'
AGENT = '22222222-2222-2222-2222-222222222222'
KEY = '33333333-3333-4333-8333-333333333333'
PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f'
T1, T2, T3 = ['2026-09-07T%02d:00:00.000Z' % h for h in (10, 11, 12)]


def sql(text, check=True):
    r = subprocess.run(PSQL, input=text, text=True, capture_output=True, timeout=10)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def metadata(event, timestamp, suspended=False):
    value = {'issuer': 'computeid', 'passport_id': PASSPORT, 'bound_at': T1,
             'receipt_issued_at': T1, 'receipt_expires_at': T3,
             'last_event': event, 'last_event_at': timestamp}
    if suspended:
        value['suspended_by'] = 'computeid'
    return json.dumps({'computeid': value})


def cas(old_status, old_time, status, event, timestamp):
    return f"""UPDATE public.agents SET status='{status}', metadata='{metadata(event, timestamp)}'::jsonb
      WHERE org_id='{ORG}' AND id='{AGENT}' AND status='{old_status}'
      AND metadata->'computeid'->>'last_event_at'='{old_time}';"""


KEY_RESTORE = f"""UPDATE public.api_keys SET is_active=true, revoked_at=NULL, revocation_reason=NULL
  WHERE org_id='{ORG}' AND agent_id='{AGENT}' AND is_active=false
  AND revocation_reason='computeid:passport.suspended';"""
KEY_REVOKE = f"""UPDATE public.api_keys SET is_active=false, revoked_at='{T3}',
  revocation_reason='computeid:passport.revoked'
  WHERE org_id='{ORG}' AND agent_id='{AGENT}' AND is_active=true;"""


def state():
    r = sql(f"""SELECT json_build_object('agent_status',a.status,'metadata',a.metadata,
        'key_active',k.is_active,'key_reason',k.revocation_reason)
        FROM public.agents a JOIN public.api_keys k ON k.agent_id=a.id WHERE a.id='{AGENT}';""")
    return json.loads(r.stdout)


def reset():
    sql(f"""TRUNCATE public.api_keys,public.agents;
      INSERT INTO public.agents(id,org_id,name,registered_by,status,metadata)
      VALUES ('{AGENT}','{ORG}','isolated-concurrency-fixture','{ORG}','suspended',
        '{metadata('passport.suspended',T1,True)}'::jsonb);
      INSERT INTO public.api_keys(id,org_id,agent_id,key_prefix,key_hash,name,created_by,
        is_active,revoked_at,revocation_reason)
      VALUES ('{KEY}','{ORG}','{AGENT}','fixture1','not-a-real-key','isolated fixture','{ORG}',
        false,'{T1}','computeid:passport.suspended');""")


def process():
    return subprocess.Popen(PSQL, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1)


def send(p, text):
    p.stdin.write(text + '\n')
    p.stdin.flush()


def marker(p, expected):
    while True:
        line = p.stdout.readline()
        if not line:
            raise AssertionError(f'missing marker {expected}: {p.stderr.read()}')
        if line.strip() == expected:
            return


def reproduce_old_handler():
    baseline = (SOURCE / 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql').read_text()
    pieces = []
    for enum in ['agent_type', 'agent_status', 'api_key_rate_limit_tier']:
        pieces.append(re.search(r'CREATE TYPE "public"\."' + enum + r'" AS ENUM \(.*?\);', baseline, re.S).group())
    for table in ['agents', 'api_keys', 'webhook_dlq']:
        pieces.append(re.search(r'CREATE TABLE IF NOT EXISTS "public"\."' + table + r'" \(.*?\n\);', baseline, re.S).group())
    pieces.append(re.search(r'CREATE TABLE IF NOT EXISTS "public"\."audit_events" \(.*?WITH \(.*?\);', baseline, re.S).group())
    ddl = '\n'.join(pieces)
    sql(ddl)
    sql((SOURCE / 'supabase/migrations/0309_expand_audit_event_category_constraint.sql').read_text())
    result = {'server_version': sql('SHOW server_version;').stdout.strip(),
              'scope': 'Isolated PostgreSQL 17; exact baseline enums/table column definitions and checks. '
                       'This is a targeted concurrency fixture, not a full production catalog replay.',
              'network': 'Docker --network none; no published ports'}

    # Each statement uses its own transaction, exactly like the existing PostgREST calls.
    reset()
    sql(cas('suspended', T1, 'active', 'passport.reinstated', T2))
    sql("""CREATE FUNCTION fixture_fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.is_active THEN RAISE EXCEPTION 'injected key write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_restore BEFORE UPDATE ON public.api_keys FOR EACH ROW
      EXECUTE FUNCTION fixture_fail_restore();""")
    failed = sql(KEY_RESTORE, check=False)
    assert failed.returncode != 0 and 'injected key write failure' in failed.stderr
    partial = state()
    assert partial['agent_status'] == 'active' and partial['key_active'] is False
    assert partial['metadata']['computeid']['last_event_at'] == T2
    result['partial_write'] = {'observed': partial, 'restore_error': failed.stderr.strip(),
      'retry_implication': 'The persisted timestamp/event is an exact replay; the independently '
                          'reproduced signed HTTP test skips its second key update.'}
    sql('DROP TRIGGER fixture_fail_restore ON public.api_keys; DROP FUNCTION fixture_fail_restore();')

    # Two real concurrent psql sessions: pause the reinstate request after its committed
    # row CAS but before its key UPDATE, then complete the later revocation.
    reset()
    blocker = process()
    restoring = process()
    try:
        send(blocker, "SELECT pg_advisory_lock(2668,1); SELECT 'LOCKED';")
        marker(blocker, 'LOCKED')
        send(restoring, cas('suspended', T1, 'active', 'passport.reinstated', T2) +
             " SELECT 'ROW_COMMITTED'; SELECT pg_advisory_lock(2668,1); " + KEY_RESTORE +
             " SELECT pg_advisory_unlock(2668,1); SELECT 'RESTORED';")
        marker(restoring, 'ROW_COMMITTED')
        sql(KEY_REVOKE + cas('active', T2, 'revoked', 'passport.revoked', T3))
        before_release = state()
        assert before_release['agent_status'] == 'revoked' and before_release['key_active'] is False
        assert before_release['key_reason'] == 'computeid:passport.suspended'
        send(blocker, "SELECT pg_advisory_unlock(2668,1);")
        marker(restoring, 'RESTORED')
        final = state()
        assert final['agent_status'] == 'revoked' and final['key_active'] is True
        result['concurrent_late_restore'] = {'after_revoke_before_late_restore': before_release,
                                            'after_late_restore': final,
                                            'forbidden_revoked_with_active_key_reproduced': True}
    finally:
        for p in [blocker, restoring]:
            try:
                send(p, '\\q')
                p.communicate(timeout=5)
            except Exception:
                p.kill()
                p.communicate()
    # Newly visible admission: revoke sees no key, then a delayed original
    # INSERT uses its active default. A stale admin PATCH can also resurrect it.
    reset()
    sql(f"DELETE FROM public.api_keys WHERE id='{KEY}'; UPDATE public.agents SET status='active' WHERE id='{AGENT}';")
    sql(KEY_REVOKE + cas('active', T1, 'revoked', 'passport.revoked', T3))
    sql(f"""INSERT INTO public.api_keys(id,org_id,agent_id,key_prefix,key_hash,name,created_by)
      VALUES ('{KEY}','{ORG}','{AGENT}','fixture1','not-a-real-key','late admission','{ORG}');""")
    late = state()
    assert late['agent_status'] == 'revoked' and late['key_active'] is True
    result['late_admission_key'] = late
    sql(f"UPDATE public.agents SET status='active' WHERE id='{AGENT}' AND org_id='{ORG}';")
    revived = state()
    assert revived['agent_status'] == 'active' and revived['metadata']['computeid']['last_event'] == 'passport.revoked'
    result['stale_patch_resurrection'] = revived
    return result


def call(expected, event, timestamp, next_status, enforcement, org=None, passport=None):
    meta = json.loads(metadata(event, timestamp, next_status == 'suspended'))
    update = {'metadata': meta, 'status': next_status}
    if next_status == 'active': update['suspended_at'] = None
    if next_status == 'revoked': update['revoked_at'] = timestamp
    if next_status == 'suspended': update['suspended_at'] = timestamp
    return f"""SELECT public.apply_computeid_agent_transition(
      '{org or ORG}','{AGENT}','{passport or PASSPORT}',
      '{expected['agent_status']}','{json.dumps(expected['metadata'])}'::jsonb,
      '{json.dumps(update)}'::jsonb,'{enforcement}','{event}','{timestamp}');"""


def value(query):
    return sql(query).stdout.strip()


def wait_for(query):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if value(query) == 't': return
        time.sleep(.02)
    raise AssertionError('session did not reach its controlled lock barrier')


def verify_atomic_rpc():
    results = {}
    reset()
    initial = state()
    restore = call(initial, 'passport.reinstated', T2, 'active', 'reactivate')
    sql("""CREATE FUNCTION fixture_fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.is_active THEN RAISE EXCEPTION 'injected key write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_restore BEFORE UPDATE ON public.api_keys FOR EACH ROW
      EXECUTE FUNCTION fixture_fail_restore();""")
    failed = sql(restore, check=False)
    assert failed.returncode and 'injected key write failure' in failed.stderr
    assert state() == initial, 'agent state committed despite key failure'
    sql('DROP TRIGGER fixture_fail_restore ON public.api_keys; DROP FUNCTION fixture_fail_restore();')
    assert value(restore) == 't'
    assert state()['agent_status'] == 'active' and state()['key_active'] is True
    results['failed_key_update_rolls_back_agent_and_identical_retry_succeeds'] = True

    reset()
    initial = state()
    restore = call(initial, 'passport.reinstated', T2, 'active', 'reactivate')
    revoke = call(initial, 'passport.revoked', T3, 'revoked', 'deactivate')
    assert value(revoke) == 't'
    assert value(restore) == 'f'
    assert state()['agent_status'] == 'revoked' and state()['key_active'] is False
    results['revoke_wins_stale_restoration_cannot_write'] = True

    # Pause inside the RPC's key UPDATE, after its agent UPDATE but before commit.
    # Another session must block at the shared agent lock, not pass it and race keys.
    reset()
    initial = state()
    restore = call(initial, 'passport.reinstated', T2, 'active', 'reactivate')
    revoke_stale = call(initial, 'passport.revoked', T3, 'revoked', 'deactivate')
    sql("""CREATE FUNCTION fixture_pause_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.is_active THEN PERFORM pg_advisory_xact_lock(2668,2); END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_pause_restore BEFORE UPDATE ON public.api_keys FOR EACH ROW
      EXECUTE FUNCTION fixture_pause_restore();""")
    blocker, restoring, revoking = process(), process(), process()
    try:
        send(blocker, "SELECT pg_advisory_lock(2668,2); SELECT 'LOCKED';")
        marker(blocker, 'LOCKED')
        send(restoring, "SET application_name='pr2668_restore'; " + restore + " SELECT 'RESTORED';")
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_restore' AND wait_event='advisory');")
        assert state() == initial, 'uncommitted row transition became visible'
        send(revoking, "SET application_name='pr2668_revoke'; " + revoke_stale + " SELECT 'REVOKE_RETURNED';")
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_revoke' AND wait_event_type='Lock');")
        send(blocker, 'SELECT pg_advisory_unlock(2668,2);')
        assert restoring.stdout.readline().strip() == 't'
        marker(restoring, 'RESTORED')
        assert revoking.stdout.readline().strip() == 'f'
        marker(revoking, 'REVOKE_RETURNED')
        active = state()
        assert active['agent_status'] == 'active' and active['key_active'] is True
        assert value(call(active, 'passport.revoked', T3, 'revoked', 'deactivate')) == 't'
        assert state()['agent_status'] == 'revoked' and state()['key_active'] is False
        results['overlapping_sessions_serialize_and_stale_revoke_retries_safely'] = True
    finally:
        for p in [blocker, restoring, revoking]:
            try:
                send(p, '\\q')
                p.communicate(timeout=5)
            except Exception:
                p.kill()
                p.communicate()
        sql('DROP TRIGGER fixture_pause_restore ON public.api_keys; DROP FUNCTION fixture_pause_restore();')

    reset()
    initial = state()
    wrong_org = '99999999-9999-4999-8999-999999999999'
    assert value(call(initial, 'passport.reinstated', T2, 'active', 'reactivate', org=wrong_org)) == 'f'
    assert value(call(initial, 'passport.reinstated', T2, 'active', 'reactivate', passport=wrong_org)) == 'f'
    assert state() == initial
    results['organization_and_passport_binding_mismatch_reject_without_writes'] = True
    sql("UPDATE public.agents SET metadata=metadata || '{\"unrelated\":\"preserve\"}'::jsonb;")
    changed = state()
    assert value(call(initial, 'passport.reinstated', T2, 'active', 'reactivate')) == 'f'
    assert state() == changed
    results['full_metadata_cas_preserves_concurrent_unrelated_write'] = True

    reset()
    sql("UPDATE public.api_keys SET revocation_reason='manual-admin-revocation';")
    assert value(call(state(), 'passport.reinstated', T2, 'active', 'reactivate')) == 't'
    assert state()['key_active'] is False and state()['key_reason'] == 'manual-admin-revocation'
    results['manual_key_revocations_are_not_restored'] = True

    reset()
    sql("UPDATE public.agents SET metadata=metadata #- '{computeid,suspended_by}';")
    before = state()
    assert sql(call(before, 'passport.reinstated', T2, 'active', 'reactivate'), check=False).returncode
    assert state() == before
    results['organization_owned_suspension_cannot_be_lifted_by_rpc'] = True

    reset()
    assert value(call(state(), 'passport.revoked', T3, 'revoked', 'deactivate')) == 't'
    before = state()
    assert sql(call(before, 'passport.reinstated', T3, 'active', 'reactivate'), check=False).returncode
    assert state() == before
    results['terminal_revocation_is_enforced_inside_transaction'] = True

    signature = 'public.apply_computeid_agent_transition(uuid,uuid,uuid,public.agent_status,jsonb,jsonb,text,text,timestamptz)'
    acl = json.loads(value(f"SELECT json_build_object('anon',has_function_privilege('anon','{signature}','EXECUTE'),'authenticated',has_function_privilege('authenticated','{signature}','EXECUTE'),'service_role',has_function_privilege('service_role','{signature}','EXECUTE'));"))
    assert acl == {'anon': False, 'authenticated': False, 'service_role': True}
    for role in ['anon', 'authenticated']:
        denied = sql(f'SET ROLE {role}; ' + call(before, 'passport.revoked', T3, 'revoked', 'deactivate'), check=False)
        assert denied.returncode and 'permission denied' in denied.stderr
    results['anon_authenticated_execution_denied_service_only_acl'] = acl
    reset()
    assert value('SET ROLE service_role; ' + call(state(), 'passport.reinstated', T2, 'active', 'reactivate')) == 't'
    results['actual_service_role_rpc_execution_succeeds'] = True

    reset()
    before = state()
    audit_count = value(f"SELECT count(*) FROM public.audit_events WHERE target_id='{AGENT}';")
    sql(f"""CREATE FUNCTION fixture_fail_transition_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.target_id='{AGENT}' THEN RAISE EXCEPTION 'injected transition audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_transition_audit BEFORE INSERT ON public.audit_events FOR EACH ROW
      EXECUTE FUNCTION fixture_fail_transition_audit();""")
    try:
        failed = sql(call(before, 'passport.reinstated', T2, 'active', 'reactivate'), check=False)
        assert failed.returncode and 'injected transition audit failure' in failed.stderr
        assert state() == before
        assert value(f"SELECT count(*) FROM public.audit_events WHERE target_id='{AGENT}';") == audit_count
    finally:
        sql('DROP TRIGGER fixture_fail_transition_audit ON public.audit_events; DROP FUNCTION fixture_fail_transition_audit();')
    assert value(call(before, 'passport.reinstated', T2, 'active', 'reactivate')) == 't'
    assert int(value(f"SELECT count(*) FROM public.audit_events WHERE target_id='{AGENT}';")) == int(audit_count) + 1
    results['transition_audit_failure_rolls_back_agent_key_clock_and_retry_records_audit'] = True

    # The migration is additive: reapply and rollback/reapply alter no existing rows.
    before = state()
    migration = (SOURCE / 'supabase/migrations/0448_computeid_agent_key_transition_atomic.sql').read_text()
    sql(migration)
    assert state() == before
    sql(f'''DROP TRIGGER enforce_agent_key_active_authority ON public.api_keys;
      DROP TRIGGER enforce_agent_revocation_terminal ON public.agents;
      DROP FUNCTION public.enforce_agent_key_active_authority();
      DROP FUNCTION public.enforce_agent_revocation_terminal();
      DROP FUNCTION public.record_computeid_passport_revocation(uuid,timestamptz);
      DROP FUNCTION public.admit_computeid_agent(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz);
      DROP FUNCTION {signature};''')
    assert state() == before
    sql(migration)
    assert state() == before
    results['migration_reapply_and_rollback_reapply_preserve_rows'] = True
    receipt = {'server_version': value('SHOW server_version;'), 'scope': 'Targeted real PostgreSQL fixture; no live database writes.', 'checks': results}
    return receipt



def verify_agent_authority():
    results = {}
    def active_without_key():
        reset()
        sql(f"DELETE FROM public.api_keys WHERE id='{KEY}'; UPDATE public.agents SET status='active' WHERE id='{AGENT}';")
        return {'agent_status': 'active', 'metadata': json.loads(metadata('passport.suspended', T1, True))}
    def insert_key(active=True, org=ORG):
        return f"""INSERT INTO public.api_keys(id,org_id,agent_id,key_prefix,key_hash,name,created_by,is_active)
          VALUES ('{KEY}','{org}','{AGENT}','fixture1','not-a-real-key','authority fixture','{ORG}',{str(active).lower()});"""
    def close_sessions(*sessions):
        for session in sessions:
            try:
                if session.poll() is None: send(session, '\\q')
                session.communicate(timeout=5)
            except Exception:
                session.kill(); session.communicate()

    expected = active_without_key()
    assert value(call(expected, 'passport.revoked', T3, 'revoked', 'deactivate')) == 't'
    denied = sql(insert_key(), check=False)
    assert denied.returncode and 'agent_key_inactive_or_wrong_org' in denied.stderr
    assert value(f"SELECT count(*) FROM public.api_keys WHERE agent_id='{AGENT}';") == '0'
    assert value(f"SELECT status FROM public.agents WHERE id='{AGENT}';") == 'revoked'
    results['late_admission_key_rejected_after_revocation'] = True

    stale_patch = sql(f"UPDATE public.agents SET status='active' WHERE id='{AGENT}' AND org_id='{ORG}';", check=False)
    assert stale_patch.returncode and 'agent_revocation_is_terminal' in stale_patch.stderr
    sql(f"UPDATE public.agents SET name='permitted non-status edit' WHERE id='{AGENT}';")
    assert value(f"SELECT status FROM public.agents WHERE id='{AGENT}';") == 'revoked'
    results['stale_admin_patch_cannot_resurrect_but_nonstatus_edit_remains_allowed'] = True

    # A key INSERT holds a parent share lock through commit. Revocation must wait,
    # then see and deactivate the newly committed key in its own transaction.
    expected = active_without_key()
    inserting, revoking = process(), process()
    try:
        send(inserting, "BEGIN; " + insert_key() + " SELECT 'KEY_INSERTED';")
        marker(inserting, 'KEY_INSERTED')
        send(revoking, "SET application_name='pr2668_revoke_after_mint'; " + call(expected, 'passport.revoked', T3, 'revoked', 'deactivate'))
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_revoke_after_mint' AND wait_event_type='Lock');")
        send(inserting, "COMMIT; SELECT 'KEY_COMMITTED';"); marker(inserting, 'KEY_COMMITTED')
        assert revoking.stdout.readline().strip() == 't'
        assert state()['agent_status'] == 'revoked' and state()['key_active'] is False
        results['key_insert_wins_lock_then_revoke_deactivates_committed_key'] = True
    finally: close_sessions(inserting, revoking)

    # Reverse ordering: revoke's parent update lock blocks a new key until the
    # transaction commits. The key guard then reads REVOKED and rejects it.
    expected = active_without_key()
    revoking, inserting, patching = process(), process(), process()
    try:
        send(revoking, 'BEGIN; ' + call(expected, 'passport.revoked', T3, 'revoked', 'deactivate') + " SELECT 'REVOKE_OPEN';")
        marker(revoking, 'REVOKE_OPEN')
        send(inserting, "SET application_name='pr2668_mint_after_revoke'; " + insert_key())
        send(patching, f"SET application_name='pr2668_patch_after_revoke'; UPDATE public.agents SET status='active' WHERE id='{AGENT}';")
        for application in ['pr2668_mint_after_revoke', 'pr2668_patch_after_revoke']:
            wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{application}' AND wait_event_type='Lock');")
        send(revoking, "COMMIT; SELECT 'REVOKED';"); marker(revoking, 'REVOKED')
        _, mint_error = inserting.communicate(timeout=5)
        _, patch_error = patching.communicate(timeout=5)
        assert inserting.returncode and 'agent_key_inactive_or_wrong_org' in mint_error
        assert patching.returncode and 'agent_revocation_is_terminal' in patch_error
        assert value(f"SELECT status FROM public.agents WHERE id='{AGENT}';") == 'revoked'
        assert value(f"SELECT count(*) FROM public.api_keys WHERE agent_id='{AGENT}';") == '0'
        results['revoke_wins_lock_then_both_new_key_and_stale_patch_are_rejected'] = True
    finally: close_sessions(revoking, inserting, patching)

    active_without_key()
    wrong_org = '99999999-9999-4999-8999-999999999999'
    denied = sql(insert_key(org=wrong_org), check=False)
    assert denied.returncode and 'agent_key_inactive_or_wrong_org' in denied.stderr
    sql(f"UPDATE public.agents SET status='suspended' WHERE id='{AGENT}';")
    denied = sql(insert_key(), check=False)
    assert denied.returncode and 'agent_key_inactive_or_wrong_org' in denied.stderr
    sql(insert_key(active=False))
    denied = sql(f"UPDATE public.api_keys SET is_active=true WHERE id='{KEY}';", check=False)
    assert denied.returncode and 'agent_key_inactive_or_wrong_org' in denied.stderr
    results['wrong_org_and_inactive_parent_cannot_receive_or_reactivate_key'] = True

    # Legacy callers may acquire an existing key lock before its parent. Force
    # that inversion against receiver's parent-first lock: PostgreSQL aborts one
    # whole transaction; retrying the receiver reaches revoked/inactive safely.
    expected = active_without_key()
    sql(insert_key())
    updating, revoking = process(), process()
    try:
        send(updating, f"BEGIN; SELECT id FROM public.api_keys WHERE id='{KEY}' FOR UPDATE; SELECT 'KEY_LOCKED';")
        marker(updating, 'KEY_LOCKED')
        send(revoking, f"BEGIN; SELECT id FROM public.agents WHERE id='{AGENT}' FOR UPDATE; SELECT 'PARENT_LOCKED';")
        marker(revoking, 'PARENT_LOCKED')
        send(updating, f"SET application_name='pr2668_existing_key_update'; UPDATE public.api_keys SET is_active=true WHERE id='{KEY}'; COMMIT;")
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_existing_key_update' AND wait_event_type='Lock');")
        send(revoking, call(expected, 'passport.revoked', T3, 'revoked', 'deactivate') + ' COMMIT;')
        _, update_error = updating.communicate(timeout=8)
        _, revoke_error = revoking.communicate(timeout=8)
        assert (updating.returncode != 0) != (revoking.returncode != 0)
        assert 'deadlock detected' in update_error + revoke_error
        if revoking.returncode:
            assert value(call(expected, 'passport.revoked', T3, 'revoked', 'deactivate')) == 't'
        final = state()
        assert final['agent_status'] == 'revoked' and final['key_active'] is False
        results['existing_key_parent_lock_inversion_aborts_atomically_and_revoke_retry_succeeds'] = True
    finally: close_sessions(updating, revoking)

    return results


def verify_passport_admission():
    results = {}
    passport = 'c5b5e6ab-3e37-4371-8fcf-13eb268115e5'
    other_org = '99999999-9999-4999-8999-999999999999'
    signature = 'public.admit_computeid_agent(uuid,uuid,uuid,timestamptz,text,text[],text,text,text,timestamptz)'
    authority_signature = 'public.record_computeid_passport_revocation(uuid,timestamptz)'
    def reset_admission():
        sql(f"""DELETE FROM public.api_keys WHERE agent_id IN (SELECT id FROM public.agents WHERE name LIKE 'atomic-admission-fixture%');
          DELETE FROM public.agents WHERE name LIKE 'atomic-admission-fixture%';
          DELETE FROM public.computeid_passport_authority WHERE passport_id='{passport}';""")
    def admit(org=ORG, key_char='a'):
        return f"""SELECT public.admit_computeid_agent(p_org_id=>'{org}',p_principal_id=>'{ORG}',
          p_passport_id=>'{passport}',p_receipt_issued_at=>clock_timestamp()-interval '1 minute',
          p_receipt_expires_at=>clock_timestamp()+interval '30 minutes',p_name=>'atomic-admission-fixture',
          p_scopes=>ARRAY['verify'],p_key_hash=>repeat('{key_char}',64),p_key_prefix=>'ak_live_abcd');"""
    def record():
        return f"SELECT public.record_computeid_passport_revocation('{passport}',clock_timestamp());"
    def counts():
        return json.loads(value(f"""SELECT json_build_object(
          'agents',(SELECT count(*) FROM public.agents WHERE name LIKE 'atomic-admission-fixture%'),
          'keys',(SELECT count(*) FROM public.api_keys WHERE agent_id IN (SELECT id FROM public.agents WHERE name LIKE 'atomic-admission-fixture%')),
          'authority',(SELECT count(*) FROM public.computeid_passport_authority WHERE passport_id='{passport}'));
          """))
    def enforce():
        return f"""SELECT public.apply_computeid_agent_transition(a.org_id,a.id,'{passport}',a.status,a.metadata,
          jsonb_build_object('status','revoked','revoked_at',clock_timestamp(),'metadata',
            jsonb_set(jsonb_set(a.metadata,'{{computeid,last_event}}','\"passport.revoked\"'),
              '{{computeid,last_event_at}}',to_jsonb(clock_timestamp()))),
          'deactivate','passport.revoked',clock_timestamp())
          FROM public.agents a WHERE name LIKE 'atomic-admission-fixture%';"""
    def close(*sessions):
        for session in sessions:
            try:
                if session.poll() is None: send(session, '\\q')
                session.communicate(timeout=6)
            except Exception:
                session.kill(); session.communicate()

    reset_admission()
    first = json.loads(value(admit()))
    assert first['agent']['status'] == 'active' and first['key']['id']
    assert counts() == {'agents': 1, 'keys': 1, 'authority': 1}
    audits = json.loads(value(f"SELECT json_agg(event_type ORDER BY event_type) FROM public.audit_events WHERE target_id IN ('{first['agent']['id']}','{first['key']['id']}');"))
    assert audits == ['AGENT_KEY_CREATED', 'AGENT_PASSPORT_ADMITTED']
    assert value(f"SELECT key_hash FROM public.api_keys WHERE id='{first['key']['id']}';") == 'a' * 64
    results['agent_hash_only_key_and_both_audits_commit_together'] = True
    assert json.loads(value(admit(key_char='b')))['error'] == 'passport_already_bound'
    assert counts()['keys'] == 1
    assert value(f"SELECT key_hash FROM public.api_keys WHERE id='{first['key']['id']}';") == 'a' * 64
    results['uncertain_committed_reply_retry_does_not_duplicate_delete_or_detach_key'] = True

    assert value(record()) == 't'
    assert json.loads(value(admit(other_org))) == {'error': 'passport_revoked'}
    fresh = admit(other_org).replace("clock_timestamp()-interval '1 minute'", "clock_timestamp()")
    assert json.loads(value(fresh)) == {'error': 'passport_revoked'}
    assert value(record()) == 't'  # Retry still succeeds so caller continues all agents.
    sql(enforce())
    assert value("SELECT bool_and(NOT is_active) FROM public.api_keys WHERE agent_id IN (SELECT id FROM public.agents WHERE name LIKE 'atomic-admission-fixture%');") == 't'
    results['global_terminal_tombstone_blocks_other_org_and_newer_receipt_retries_still_enforce'] = True

    # An orphan authenticated revoke must survive the absence of any agent.
    reset_admission()
    assert value(record()) == 't'
    assert json.loads(value(admit(other_org)))['error'] == 'passport_revoked'
    assert counts() == {'agents': 0, 'keys': 0, 'authority': 1}
    results['orphan_revocation_is_durable_before_first_admission'] = True

    # Only the service-owned ledger determines global terminal authority.
    reset_admission()
    sql(f"""INSERT INTO public.agents(org_id,registered_by,name,status,metadata)
      VALUES ('{ORG}','{ORG}','atomic-admission-fixture-forged','revoked',
      '{{"computeid":{{"issuer":"computeid","passport_id":"{passport}","last_event":"passport.revoked"}}}}');""")
    assert 'agent' in json.loads(value(admit(other_org)))
    results['tenant_binding_metadata_cannot_forge_global_provider_authority'] = True

    # Faults anywhere in the transaction, including audit insertion, roll back
    # the agent, key, audits AND the newly created sentinel together.
    for target in ['api_keys', 'audit_events']:
        reset_admission()
        sql(f"""CREATE FUNCTION fixture_fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected atomic admission failure'; END $$;
          CREATE TRIGGER fixture_fail_admission BEFORE INSERT ON public.{target}
          FOR EACH ROW EXECUTE FUNCTION fixture_fail_admission();""")
        try:
            failed = sql(admit(), check=False)
            assert failed.returncode and 'injected atomic admission failure' in failed.stderr
            assert counts() == {'agents': 0, 'keys': 0, 'authority': 0}
        finally:
            sql(f'DROP TRIGGER fixture_fail_admission ON public.{target}; DROP FUNCTION fixture_fail_admission();')
        assert 'agent' in json.loads(value(admit()))
        results[f'{target}_failure_rolls_back_complete_admission_and_retry_succeeds'] = True

    # Admission wins the sentinel lock: revoke waits, then discovers the committed
    # agent and deactivates its key. This covers the previously empty-row gap.
    reset_admission()
    admitting, revoking = process(), process()
    try:
        send(admitting, 'BEGIN; ' + admit() + " SELECT 'ADMITTED_OPEN';"); marker(admitting, 'ADMITTED_OPEN')
        send(revoking, "SET application_name='pr2668_authority_revoke'; " + record())
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_authority_revoke' AND wait_event_type='Lock');")
        send(admitting, "COMMIT; SELECT 'ADMITTED';"); marker(admitting, 'ADMITTED')
        assert revoking.stdout.readline().strip() == 't'
        sql(enforce())
        assert counts() == {'agents': 1, 'keys': 1, 'authority': 1}
        assert value("SELECT bool_and(status='revoked') FROM public.agents WHERE name LIKE 'atomic-admission-fixture%';") == 't'
        assert value("SELECT bool_and(NOT is_active) FROM public.api_keys WHERE agent_id IN (SELECT id FROM public.agents WHERE name LIKE 'atomic-admission-fixture%');") == 't'
        results['admission_wins_sentinel_then_revoke_enforces_committed_key'] = True
    finally: close(admitting, revoking)

    # Reverse ordering, again beginning without any authority row.
    reset_admission()
    revoking, admitting = process(), process()
    try:
        send(revoking, 'BEGIN; ' + record() + " SELECT 'REVOKE_OPEN';"); marker(revoking, 'REVOKE_OPEN')
        send(admitting, "SET application_name='pr2668_authority_admit'; " + admit(other_org))
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_authority_admit' AND wait_event_type='Lock');")
        send(revoking, "COMMIT; SELECT 'REVOKED';"); marker(revoking, 'REVOKED')
        assert json.loads(admitting.stdout.readline()) == {'error': 'passport_revoked'}
        assert counts() == {'agents': 0, 'keys': 0, 'authority': 1}
        results['revocation_wins_absent_row_gap_then_cross_org_admission_rejected'] = True
    finally: close(revoking, admitting)

    reset_admission()
    first_session, second_session = process(), process()
    try:
        send(first_session, 'BEGIN; ' + admit() + " SELECT 'FIRST_OPEN';"); marker(first_session, 'FIRST_OPEN')
        send(second_session, "SET application_name='pr2668_duplicate_admit'; " + admit(key_char='b'))
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_duplicate_admit' AND wait_event_type='Lock');")
        send(first_session, "COMMIT; SELECT 'FIRST_COMMITTED';"); marker(first_session, 'FIRST_COMMITTED')
        assert json.loads(second_session.stdout.readline())['error'] == 'passport_already_bound'
        assert counts() == {'agents': 1, 'keys': 1, 'authority': 1}
        results['parallel_same_org_admission_serializes_without_duplicate_keys'] = True
    finally: close(first_session, second_session)

    for role in ['anon', 'authenticated']:
        for query in [admit(), record(), f"INSERT INTO public.computeid_passport_authority(passport_id) VALUES ('{passport}');", 'SELECT * FROM public.computeid_passport_authority;']:
            denied = sql(f'SET ROLE {role}; ' + query, check=False)
            assert denied.returncode and 'permission denied' in denied.stderr
    reset_admission()
    assert 'agent' in json.loads(value('SET ROLE service_role; ' + admit()))
    assert value('SET ROLE service_role; ' + record()) == 't'
    results['anon_authenticated_denied_authority_table_and_rpcs_service_succeeds'] = True
    for invalid in [admit().replace("ARRAY['verify']", "ARRAY['keys:manage']"), admit().replace("interval '30 minutes'", "interval '100 years'")]:
        rejected = sql(invalid, check=False)
        assert rejected.returncode and 'invalid ComputeID admission' in rejected.stderr
    results['sql_enforces_scope_and_receipt_validity_bounds'] = True

    # Reapplying migration cannot erase terminal authority. Rollback must leave
    # this private table intact; it is a durable security record, not scratch.
    before = value(f"SELECT revoked_at FROM public.computeid_passport_authority WHERE passport_id='{passport}';")
    sql((SOURCE / 'supabase/migrations/0448_computeid_agent_key_transition_atomic.sql').read_text())
    assert value(f"SELECT revoked_at FROM public.computeid_passport_authority WHERE passport_id='{passport}';") == before
    assert json.loads(value(admit()))['error'] == 'passport_revoked'
    results['migration_reapply_preserves_durable_terminal_tombstone'] = True

    failure_hash = 'c' * 64
    sql(f"DELETE FROM public.webhook_dlq WHERE provider='computeid' AND payload_hash='{failure_hash}';")
    enqueue = f"SELECT public.enqueue_computeid_failure('fixture repeated failure','{failure_hash}','{passport}');"
    first_session, retry_session = process(), process()
    try:
        send(first_session, 'BEGIN; ' + enqueue + " SELECT 'FAILURE_OPEN';"); marker(first_session, 'FAILURE_OPEN')
        send(retry_session, "SET application_name='pr2668_dlq_retry'; " + enqueue)
        wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='pr2668_dlq_retry' AND wait_event_type='Lock');")
        send(first_session, "COMMIT; SELECT 'FAILURE_COMMITTED';"); marker(first_session, 'FAILURE_COMMITTED')
        assert retry_session.stdout.readline().strip() == 't'
        assert value(f"SELECT count(*) FROM public.webhook_dlq WHERE provider='computeid' AND payload_hash='{failure_hash}';") == '1'
    finally: close(first_session, retry_session)
    assert value(enqueue.replace('fixture repeated failure', 'fixture distinct failure')) == 't'
    assert value(f"SELECT count(*) FROM public.webhook_dlq WHERE provider='computeid' AND payload_hash='{failure_hash}';") == '2'
    for role in ['anon', 'authenticated']:
        denied = sql(f'SET ROLE {role}; ' + enqueue, check=False)
        assert denied.returncode and 'permission denied' in denied.stderr
    results['concurrent_dlq_retries_deduplicate_without_erasing_distinct_failure_reasons'] = True
    return results


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    # A failed barrier must terminate the test, never leave the command hanging.
    def timed_out(_signum, _frame):
        raise TimeoutError('isolated concurrency suite exceeded 90 seconds')
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(90)
    started = False
    try:
        subprocess.run(['docker', 'run', '--pull', 'never', '-d', '--name', CONTAINER,
                        '--network', 'none', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
                        '--tmpfs', '/var/lib/postgresql/data:rw', 'postgres:17'],
                       check=True, capture_output=True, text=True, timeout=20)
        started = True
        for _ in range(50):
            ready = subprocess.run(['docker', 'exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                                   capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            time.sleep(.1)
        else:
            raise TimeoutError('owned PostgreSQL fixture did not become ready')
        before = reproduce_old_handler()
        sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;')
        sql((SOURCE / 'supabase/migrations/0448_computeid_agent_key_transition_atomic.sql').read_text())
        after = verify_atomic_rpc()
        receipt = {'negative_controls': before, 'atomic_rpc': after, 'agent_authority': verify_agent_authority(), 'passport_admission': verify_passport_admission()}
        encoded = json.dumps(receipt, indent=2) + '\n'
        if args.output:
            args.output.write_text(encoded)
        print(encoded)
    finally:
        signal.alarm(0)
        if started:
            subprocess.run(['docker', 'rm', '-f', CONTAINER], capture_output=True, timeout=20, check=True)


if __name__ == '__main__':
    run()
