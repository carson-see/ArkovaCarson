"""Actual SQL on a fresh isolated PostgreSQL fixture; never a Supabase rig.

Usage: python3 scripts/verify-suborg-offboard.py /absolute/new-evidence-directory
Requires PostgreSQL server/client binaries on PATH. Uses a fresh loopback-only
cluster, OS-assigned port, bounded connections, and stops the server in finally.
Keeps old-SQL negative controls and corrected real concurrent interleavings.
This scoped fixture does not replace full migration replay or live qualification.
"""
import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

checkout = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]).resolve()
out.mkdir(exist_ok=False)
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
postgres = shutil.which('postgres')
if postgres is None:
    raise SystemExit('PostgreSQL server binaries must be installed and postgres must be on PATH')
bin_path = Path(postgres).resolve().parent
data = out / 'pgdata'
checks = []
children = []

def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], text=True, capture_output=True, timeout=40, **kwargs)

def cli():
    return [str(bin_path/'psql'), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', str(port), '-d', 'postgres']

def sql(command, fail=False):
    result = run(cli(), input=command)
    with (out/'queries.log').open('a') as log:
        log.write(command + '\n' + result.stdout + result.stderr + '\n')
    if fail:
        assert result.returncode != 0, 'expected SQL failure'
    else:
        result.check_returncode()
    return result.stdout.strip()

def concurrent(command, name):
    p = subprocess.Popen(cli(), text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p.stdin.write("SET application_name = '" + name + "'; SET statement_timeout = '8s'; " + command)
    p.stdin.close()
    p.stdin = None
    children.append(p)
    return p

def sleeping(name):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name = '" + name + "' AND wait_event = 'PgSleep';") == '1':
            return
        time.sleep(.03)
    raise AssertionError('concurrent session did not reach controlled interleaving')

def finish(p):
    stdout, stderr = p.communicate(timeout=10)
    assert p.returncode == 0, stderr
    with (out/'concurrent.log').open('a') as log:
        log.write(stdout + stderr)
    return [json.loads(v) for v in stdout.splitlines() if v.startswith('{')]

def definitions(source, name):
    return re.findall(r'CREATE OR REPLACE FUNCTION public\.' + name + r'\([\s\S]*?\$function\$;', source)

P = '22222222-2222-4222-8222-222222222222'
C = '44444444-4444-4444-8444-444444444444'
U = 'aaaaaaaa-0000-4000-8000-000000000001'
K = 'bbbbbbbb-0000-4000-8000-000000000001'
F = '66666666-6666-4666-8666-666666666666'

def alloc(mode, amount):
    fn = 'allocate_credits_to_sub_org' + ('_as_api_key' if mode == 'key' else '')
    return f"SELECT {fn}('{P}','{C}',{amount},'test','{K if mode == 'key' else U}');"

def suspend(mode):
    fn = 'suspend_suborg' + ('_as_api_key' if mode == 'key' else '')
    return f"SELECT {fn}('{P}','{C}','offboard','{K if mode == 'key' else U}');"

def offboard(mode, parent=P, actor=None):
    fn = 'offboard_suborg' + ('_as_api_key' if mode == 'key' else '')
    return f"SELECT {fn}('{parent}','{C}','offboard','{actor or (K if mode == 'key' else U)}');"

def reset(balance=40, suspended=False, status='APPROVED'):
    sql(f"TRUNCATE audit_events, org_credit_allocations; UPDATE organizations SET parent_org_id='{P}', suspended={str(suspended).lower()},parent_approval_status='{status}' WHERE id='{C}'; UPDATE org_credits SET balance=CASE WHEN org_id='{P}' THEN 100 ELSE {balance} END; UPDATE api_keys SET org_id='{P}',is_active=true,revoked_at=NULL,expires_at=NULL,scopes=ARRAY['orgs:manage'];")

def state():
    return json.loads(sql(f"SELECT json_build_object('parent',(SELECT balance FROM org_credits WHERE org_id='{P}'),'child',(SELECT balance FROM org_credits WHERE org_id='{C}'),'suspended',(SELECT suspended FROM organizations WHERE id='{C}'));"))

init = run([bin_path/'initdb', '-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'])
(out/'init.log').write_text(init.stdout + init.stderr)
init.check_returncode()
start = run([bin_path/'pg_ctl', '-D', data, '-l', out/'postgres.log', '-o', f'-h 127.0.0.1 -p {port} -k /tmp', '-w', 'start'])
start.check_returncode()
try:
    sql(f"""
      CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE organizations(id uuid PRIMARY KEY,parent_org_id uuid,parent_approval_status text,suspended boolean DEFAULT false,suspended_at timestamptz,suspended_by uuid REFERENCES auth.users(id),suspended_reason text);
      CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),org_id uuid,role text,is_platform_admin boolean DEFAULT false);
      CREATE TABLE org_members(user_id uuid,org_id uuid,role text);
      CREATE TABLE api_keys(id uuid PRIMARY KEY,org_id uuid,created_by uuid NOT NULL REFERENCES auth.users(id),key_prefix text,is_active boolean,revoked_at timestamptz,expires_at timestamptz,scopes text[]);
      CREATE TABLE org_credits(org_id uuid PRIMARY KEY,balance integer NOT NULL DEFAULT 0 CHECK(balance>=0),updated_at timestamptz);
      CREATE TABLE org_credit_allocations(parent_org_id uuid,child_org_id uuid,amount integer,granted_by uuid NOT NULL REFERENCES auth.users(id),note text);
      CREATE TABLE audit_events(event_type text,event_category text,actor_id uuid REFERENCES profiles(id),target_type text,target_id text,org_id uuid,details text);
      INSERT INTO auth.users VALUES('{U}'); INSERT INTO profiles VALUES('{U}','{P}','ORG_ADMIN',false);
      INSERT INTO org_members VALUES('{U}','{P}','owner');
      INSERT INTO organizations(id,parent_org_id,parent_approval_status) VALUES('{P}',NULL,NULL),('{C}','{P}','APPROVED'),('{F}',NULL,NULL);
      INSERT INTO api_keys VALUES('{K}','{P}','{U}','test',true,NULL,NULL,ARRAY['orgs:manage']);
      INSERT INTO org_credits(org_id,balance) VALUES('{P}',100),('{C}',40);
    """)
    old_user = (checkout/'supabase/migrations/0444_scrum4470_suborg_parent_authority_lock.sql').read_text()
    old_key = (checkout/'supabase/migrations/0453_scrum3971_orgs_manage_scope_api_key_suborg_authority.sql').read_text()
    selected = [definitions(old_user,'allocate_credits_to_sub_org')[0], definitions(old_user,'suspend_suborg')[1]]
    selected += [definitions(old_key,n)[0] for n in ['_suborg_api_key_authorized','allocate_credits_to_sub_org_as_api_key','suspend_suborg_as_api_key']]
    sql('\n'.join(selected))
    for mode, other in [('key','user'),('user','key')]:
        reset()
        # Matches the old worker's two independent RPC transactions exactly.
        a = concurrent(alloc(mode,-40) + ' SELECT pg_sleep(0.8); ' + suspend(mode), 'old_offboard')
        sleeping('old_offboard')
        result = json.loads(sql(alloc(other,10)))
        assert result['success'] is True
        assert all(r['success'] is True for r in finish(a))
        assert state() == {'parent':130,'child':10,'suspended':True}
        checks.append(f'NEGATIVE CONTROL: {mode} offboard / {other} allocation both succeed and strand 10 credits')
    migration = checkout/'supabase/migrations/0460_scrum3971_atomic_suborg_offboard.sql'
    source = migration.read_text()
    sql(source)
    for mode, other in [('key','user'),('user','key'),('key','key'),('user','user')]:
        reset()
        a = concurrent('BEGIN; ' + offboard(mode) + ' SELECT pg_sleep(0.8); COMMIT;', 'offboard_first')
        sleeping('offboard_first')
        b = concurrent(alloc(other,10), 'allocation_waiter')
        time.sleep(.08)
        assert b.poll() is None, 'allocation did not wait for the offboard child lock'
        assert finish(a)[0]['reclaimed'] == 40
        assert finish(b)[0]['error'] == 'sub_org_not_active'
        assert state() == {'parent':140,'child':0,'suspended':True}
        checks.append(f'{mode} offboard commits first: waiting {other} allocation rechecks suspension and is refused')
        reset()
        a = concurrent('BEGIN; ' + alloc(other,10) + ' SELECT pg_sleep(0.8); COMMIT;', 'allocation_first')
        sleeping('allocation_first')
        b = concurrent(offboard(mode), 'offboard_waiter')
        time.sleep(.08)
        assert b.poll() is None, 'offboard did not wait for the allocation child lock'
        assert finish(a)[0]['success'] is True
        assert finish(b)[0]['reclaimed'] == 50
        assert state() == {'parent':140,'child':0,'suspended':True}
        checks.append(f'{other} allocation commits first: waiting {mode} offboard reclaims the current 50-credit balance')
    for mode in ['key','user']:
        reset()
        result = json.loads(sql(offboard(mode)))
        assert result == {'success':True,'reclaimed':40,'already_suspended':False}
        assert json.loads(sql(offboard(mode))) == {'success':True,'reclaimed':0,'already_suspended':True}
        assert sql('SELECT count(*) FROM org_credit_allocations;') == '1'
        assert sql('SELECT count(*) FROM audit_events;') == '2'
        actor_predicate = f"actor_id IS NULL AND details::jsonb #>> '{{actor,actor_api_key_id}}' = '{K}'" if mode == 'key' else f"actor_id = '{U}'"
        assert sql('SELECT count(*) FROM audit_events WHERE ' + actor_predicate + ';') == '2'
        checks.append(f'{mode}: retry is idempotent; one transfer and two correctly attributed audit rows')
        reset(suspended=True)
        assert json.loads(sql(offboard(mode))) == {'success':True,'reclaimed':40,'already_suspended':True}
        assert state() == {'parent':140,'child':0,'suspended':True}
        checks.append(f'{mode}: recovery drains an already-suspended child without requiring APPROVED')
        for status in ['PENDING','REVOKED']:
            reset(status=status)
            assert json.loads(sql(alloc(mode,5)))['error'] == 'sub_org_not_active'
            assert json.loads(sql(offboard(mode)))['reclaimed'] == 40
            checks.append(f'{mode}: {status} cannot receive positive funding and can still be offboarded')
        reset()
        assert json.loads(sql(offboard(mode,parent=F))).get('success') is not True
        assert state() == {'parent':100,'child':40,'suspended':False}
        checks.append(f'{mode}: foreign-parent request cannot mutate balances or suspension')
        reset()
        sql("ALTER TABLE audit_events ADD CONSTRAINT fixture_suspend_failure CHECK(event_type <> 'org.suborg.suspended');")
        sql(offboard(mode), fail=True)
        assert state() == {'parent':100,'child':40,'suspended':False}
        assert sql('SELECT count(*) FROM audit_events;') == '0'
        assert sql('SELECT count(*) FROM org_credit_allocations;') == '0'
        sql('ALTER TABLE audit_events DROP CONSTRAINT fixture_suspend_failure;')
        checks.append(f'{mode}: suspension audit failure rolls back reclaim, credit audit, allocation record and suspension')
    for mode in ['key','user']:
        reset()
        assert json.loads(sql(offboard(mode).replace("'"+(K if mode == 'key' else U)+"'", 'NULL')))['error'] == 'authentication_required'
        assert state() == {'parent':100,'child':40,'suspended':False}
        checks.append(mode+': missing caller identity fails closed')
        sql(f"UPDATE organizations SET parent_org_id='{F}' WHERE id='{C}';")
        assert json.loads(sql(offboard(mode)))['error'] == 'not_a_child_of_parent'
        assert state() == {'parent':100,'child':40,'suspended':False}
        checks.append(mode+': authorized parent cannot offboard another parent child')
    reset(suspended=True)
    legacy = f"SELECT allocate_credits_to_sub_org('{P}','{C}',5,'legacy');"
    assert json.loads(sql(f"SET request.jwt.claim.sub='{U}'; " + legacy))['error'] == 'sub_org_not_active'
    assert json.loads(sql(legacy))['error'] == 'authentication_required'
    checks.append('legacy JWT overload delegates to locked lifecycle guard and preserves missing-auth denial')
    for fault in ["is_active=false", "revoked_at=now()", "expires_at=now()-interval '1 hour'", "scopes=ARRAY['read:orgs']", f"org_id='{F}'"]:
        reset()
        sql('UPDATE api_keys SET '+fault+';')
        assert json.loads(sql(offboard('key')))['error'] == 'parent_admin_required'
        assert state() == {'parent':100,'child':40,'suspended':False}
        checks.append('key authority denial: '+fault)
    reset()
    sql('DELETE FROM org_members; UPDATE profiles SET role=\'MEMBER\';')
    assert json.loads(sql(offboard('user')))['error'] == 'parent_admin_required'
    checks.append('user without membership/profile administration denied')
    for function in ['offboard_suborg(uuid,uuid,text,uuid)','offboard_suborg_as_api_key(uuid,uuid,text,uuid)']:
        for role in ['anon','authenticated']:
            assert sql(f"SELECT has_function_privilege('{role}','public.{function}','EXECUTE');") == 'f'
        assert sql(f"SELECT has_function_privilege('service_role','public.{function}','EXECUTE');") == 't'
        checks.append(function+': service-only execute ACL')
    sql(source)
    checks.append('compensating migration reapplies without changing function ACLs')
    receipt = {'checked_at':datetime.now(timezone.utc).isoformat(),'migration_sha256':hashlib.sha256(source.encode()).hexdigest(),'immutable_0453_sha256':hashlib.sha256(old_key.encode()).hexdigest(),'scope':'Actual 0444/0453 functions and entire 0460 migration on fresh isolated native PostgreSQL fixture tables. Not a full Arkova migration replay, live RLS, staging qualification or soak.', 'checks':checks}
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt,indent=2))
finally:
    for p in children:
        if p.poll() is None:
            p.kill()
            p.wait(timeout=5)
    stop = run([bin_path/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    (out/'stop.log').write_text(stop.stdout+stop.stderr)
    stop.check_returncode()
