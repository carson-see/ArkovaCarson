"""Execute staging bootstrap SQL in a new native PostgreSQL fixture only.

Usage: python3 scripts/staging/migrations/verify-bootstrap-acl.py /new/evidence/dir
No remote URLs, credentials, existing databases or migration ledgers are used.
"""
import hashlib
import json
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = Path(sys.argv[1]).resolve()
out.mkdir(exist_ok=False)
binary = shutil.which('postgres')
if binary is None:
    raise SystemExit('PostgreSQL server binaries are required on PATH')
pg = Path(binary).resolve().parent
data = out / 'pgdata'
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
checks = []

def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True, timeout=30, **kwargs)

def sql(statement, denied=False):
    result = run([pg/'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                  '-h', '127.0.0.1', '-p', port, '-d', 'postgres'], input=statement)
    with (out/'sql.log').open('a') as log:
        log.write(statement+'\n'+result.stdout+result.stderr+'\n')
    if denied:
        assert result.returncode != 0, 'Expected operation to be denied'
    else:
        result.check_returncode()
    return result.stdout.strip()

lease_path = 'docs/staging/staging_lease.sql'
audit_path = 'scripts/staging/migrations/staging_only_deploy_log_and_lease_pk.sql'
current = {p: (root/p).read_text() for p in [lease_path, audit_path]}
baseline_ref = '663254b9f6e7c3143603ed3295d0a08fbb993aec'
baseline = {p: run(['git', '-C', root, 'show', baseline_ref+':'+p]).stdout for p in current}
assert all(baseline.values())
init = run([pg/'initdb', '-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'])
(out/'init.log').write_text(init.stdout+init.stderr)
init.check_returncode()
run([pg/'pg_ctl', '-D', data, '-l', out/'postgres.log', '-o',
     f'-h 127.0.0.1 -p {port} -k /tmp', '-w', 'start']).check_returncode()
try:
    sql('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;'
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;'
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;')
    for statement in baseline.values():
        sql(statement)
    sql("SET ROLE service_role; INSERT INTO staging_lease(pr_number,reason,acquired_by) VALUES(1,'fixture','native-proof');"
        "SELECT record_staging_deploy(1,'fixture:image','fixture-sha','fixture-revision','fixture-tag',false,'native-proof',false,NULL,true);")
    sql('SET ROLE service_role; TRUNCATE staging_deploy_log;')
    assert sql('SELECT count(*) FROM staging_deploy_log;') == '0'
    checks.append('NEGATIVE: inherited service_role TRUNCATE bypasses original append-only row trigger')
    sql("SET ROLE service_role; SELECT setval('staging_deploy_log_id_seq', 99, true);")
    checks.append('NEGATIVE: inherited sequence UPDATE allows service_role to reset audit IDs')
    sql("SET ROLE service_role; SELECT record_staging_deploy(1,'fixture:image','fixture-sha','fixture-revision','fixture-tag',false,'native-proof',false,NULL,true);")
    original = sql('SELECT row_to_json(l)::text FROM staging_deploy_log l ORDER BY id;')
    for statement in current.values():
        sql(statement)
    assert sql('SELECT row_to_json(l)::text FROM staging_deploy_log l ORDER BY id;') == original
    checks.append('Corrected bootstrap preserves existing complete audit row and ID')
    for role in ['anon', 'authenticated']:
        for table in ['staging_lease', 'staging_deploy_log']:
            assert sql(f"SELECT has_table_privilege('{role}','{table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');") == 'f'
            checks.append(f'{role} has no table privilege on {table}')
        assert sql(f"SELECT has_sequence_privilege('{role}','staging_deploy_log_id_seq','USAGE,SELECT,UPDATE');") == 'f'
        checks.append(f'{role} has no audit-sequence privilege')
    for table, allowed in [('staging_lease', {'SELECT','INSERT','DELETE'}), ('staging_deploy_log', {'SELECT','INSERT'})]:
        for operation in ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']:
            assert sql(f"SELECT has_table_privilege('service_role','{table}','{operation}');") == ('t' if operation in allowed else 'f')
        checks.append(f'{table} service privilege set equals '+','.join(sorted(allowed)))
    for statement in ['TRUNCATE staging_deploy_log;', 'UPDATE staging_deploy_log SET tag=\'changed\';',
                      'DELETE FROM staging_deploy_log;', "SELECT setval('staging_deploy_log_id_seq',1,true);", 'TRUNCATE staging_lease;']:
        sql('SET ROLE service_role; '+statement, denied=True)
        checks.append('Service operation denied: '+statement)
    sql('SET ROLE service_role; DELETE FROM staging_lease WHERE pr_number=1;'
        "INSERT INTO staging_lease(pr_number,reason,acquired_by) VALUES(2,'fixture','native-proof');"
        "SELECT record_staging_deploy(2,'fixture:image','fixture-sha','fixture-revision','fixture-tag',false,'native-proof',false,NULL,true);")
    assert sql('SELECT count(*) FROM staging_deploy_log;') == '2'
    assert sql('SET ROLE service_role; SELECT pr_number FROM staging_lease;') == '2'
    checks.append('Lease acquire/release/read and audit RPC append still work after hardening')
    sql('UPDATE staging_deploy_log SET tag=\'changed\';', denied=True)
    sql('DELETE FROM staging_deploy_log;', denied=True)
    checks.append('Append-only trigger still rejects owner UPDATE and DELETE')
    before = sql('SELECT row_to_json(l)::text FROM staging_deploy_log l ORDER BY id;')
    for statement in current.values():
        sql(statement)
    assert sql('SELECT row_to_json(l)::text FROM staging_deploy_log l ORDER BY id;') == before
    checks.append('Unchanged reapply preserves both audit rows and working ACLs')
    receipt = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'scope': 'Actual staging bootstrap SQL in fresh native PostgreSQL with Supabase-like inherited ALL privileges; no hosted deployment or full schema replay claimed.',
               'baselineRef': baseline_ref, 'sourceSha256': {p:hashlib.sha256(v.encode()).hexdigest() for p,v in current.items()}, 'checks':checks}
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'checksPassed':len(checks),'receipt':str(out/'receipt.json')}))
finally:
    stopped=run([pg/'pg_ctl','-D',data,'-m','fast','-w','stop'])
    (out/'stop.log').write_text(stopped.stdout+stopped.stderr)
    stopped.check_returncode()
