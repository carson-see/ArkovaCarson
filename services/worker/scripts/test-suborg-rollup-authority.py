#!/usr/bin/env python3
"""SCRUM-4878: real PostgreSQL authorization checks on both rollup overloads.

Creates and always stops its own private cluster. This focused fixture is not
full-schema, hosted, HTTP or soak evidence. --baseline reproduces the old bug.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import sys
import uuid

from lib.local_postgres import LocalPostgres, quote


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-bin', required=True)
    parser.add_argument('--output', required=True,
                        help='New directory name in cwd: ASCII letters, digits, underscores or hyphens')
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    output_root = Path.cwd().resolve()
    output_name = args.output
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', output_name):
        raise SystemExit('--output must be a directory name: 1-64 ASCII letters, digits, underscores or hyphens')
    output = output_root / output_name
    if output.exists() or output.is_symlink():
        raise SystemExit('--output must name a new directory, not an existing path or symlink')
    repo = Path(__file__).resolve().parents[3]
    baseline = repo/'supabase/migrations/0432_suborg_rpc_role_enum_coercion_fix.sql'
    repair = repo/'supabase/migrations/0450_scrum4878_suborg_rollup_canonical_admin.sql'
    parent, child, other = [str(uuid.uuid4()) for _ in range(3)]
    actors = {name: str(uuid.uuid4()) for name in ['owner', 'admin', 'profile', 'profile_member', 'platform', 'foreign', 'member', 'missing']}
    checks = []
    with LocalPostgres(output, args.pg_bin) as pg:
        pg.query("""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE organizations(id uuid PRIMARY KEY,parent_org_id uuid);
CREATE TABLE profiles(id uuid PRIMARY KEY,org_id uuid,role text,is_platform_admin boolean DEFAULT false);
CREATE TABLE org_members(user_id uuid,org_id uuid,role text,PRIMARY KEY(user_id,org_id));
CREATE TABLE org_credits(org_id uuid PRIMARY KEY,balance integer,monthly_allocation integer);
""")
        pg.query(baseline.read_text())
        if not args.baseline:
            pg.query(repair.read_text())
        pg.query(f"""
INSERT INTO organizations VALUES ({quote(parent)},NULL),({quote(child)},{quote(parent)}),({quote(other)},NULL);
INSERT INTO org_credits VALUES ({quote(parent)},100,100),({quote(child)},10,10),({quote(other)},777,777);
INSERT INTO profiles VALUES
 ({quote(actors['owner'])},{quote(other)},'MEMBER',false),
 ({quote(actors['admin'])},{quote(other)},'MEMBER',false),
 ({quote(actors['profile'])},{quote(parent)},'ORG_ADMIN',false),
 ({quote(actors['profile_member'])},{quote(parent)},'ORG_ADMIN',false),
 ({quote(actors['platform'])},NULL,'MEMBER',true),
 ({quote(actors['foreign'])},{quote(other)},'ORG_ADMIN',false),
 ({quote(actors['member'])},{quote(parent)},'MEMBER',false);
INSERT INTO org_members VALUES
 ({quote(actors['owner'])},{quote(parent)},'owner'),
 ({quote(actors['admin'])},{quote(parent)},'admin'),
 ({quote(actors['member'])},{quote(parent)},'member'),
 ({quote(actors['profile_member'])},{quote(parent)},'member'),
 ({quote(actors['foreign'])},{quote(other)},'owner');
""")
        expected = {'parent_org_id': parent, 'parent_balance': 100, 'children': [{'child_org_id': child, 'balance': 10, 'monthly_allocation': 10}]}
        before = pg.value("SELECT jsonb_build_object('credits',(SELECT jsonb_agg(c ORDER BY org_id) FROM org_credits c),'members',(SELECT jsonb_agg(m ORDER BY user_id) FROM org_members m),'profiles',(SELECT jsonb_agg(p ORDER BY id) FROM profiles p));")
        for arity in [1, 2]:
            for name in [*actors, 'null']:
                caller = actors.get(name)
                claims = json.dumps({'role': 'service_role', **({'sub': caller} if caller else {})})
                parameters = quote(parent) + (',' + (quote(caller) if caller else 'NULL') if arity == 2 else '')
                result = pg.value(f"SET ROLE service_role; SET request.jwt.claims={quote(claims)}; SELECT public.get_parent_credit_rollup({parameters});")
                wanted = expected if name in ['owner','admin','profile','profile_member','platform'] else {'error':'authentication_required' if name=='null' else 'parent_admin_required'}
                checks.append({'case': f'{arity}-argument {name}', 'passed': result == wanted, 'actual': result, 'expected': wanted})
        for arity in [1, 2]:
            parameters = quote(parent) + (',' + quote(actors['owner']) if arity == 2 else '')
            for role in ['anon','authenticated']:
                result = pg.query(f"SET ROLE {role}; SELECT public.get_parent_credit_rollup({parameters});", success=False)
                checks.append({'case':f'{arity}-argument {role} ACL', 'passed':result.returncode!=0 and 'permission denied for function get_parent_credit_rollup' in result.stderr})
        after = pg.value("SELECT jsonb_build_object('credits',(SELECT jsonb_agg(c ORDER BY org_id) FROM org_credits c),'members',(SELECT jsonb_agg(m ORDER BY user_id) FROM org_members m),'profiles',(SELECT jsonb_agg(p ORDER BY id) FROM profiles p));")
        checks.append({'case':'read-only calls preserve balances and authority rows','passed':before==after})
        if not args.baseline:
            # Restore only the two prior rollup definitions, never all of 0432:
            # the full file would also undo separate 0444 mutation fixes.
            definitions = re.findall(r'CREATE OR REPLACE FUNCTION public\.get_parent_credit_rollup\([\s\S]*?\$function\$;', baseline.read_text())
            grants = [line for line in baseline.read_text().splitlines() if line.startswith(('REVOKE ALL ON FUNCTION public.get_parent_credit_rollup(', 'GRANT EXECUTE ON FUNCTION public.get_parent_credit_rollup('))]
            assert len(definitions) == 2 and len(grants) == 4
            rollback = "BEGIN; SET LOCAL lock_timeout='5s';\n" + '\n'.join(definitions + grants) + "\nNOTIFY pgrst, 'reload schema'; COMMIT;"
            (output/'rollback.sql').write_text(rollback+'\n')
            pg.query(rollback)
            result = pg.value(f"SET ROLE service_role; SELECT public.get_parent_credit_rollup({quote(parent)},{quote(actors['profile'])});")
            checks.append({'case':'literal rollback restores the reproduced denial','passed':result=={'error':'parent_admin_required'}})
            pg.query(repair.read_text())
            for arity in [1, 2]:
                parameters = quote(parent) + (','+quote(actors['profile']) if arity==2 else '')
                result = pg.value(f"SET ROLE service_role; SET request.jwt.claims={quote(json.dumps({'role':'service_role','sub':actors['profile']}))}; SELECT public.get_parent_credit_rollup({parameters});")
                checks.append({'case':f'{arity}-argument repaired after literal rollback','passed':result==expected})
        # Revoke canonical profile authority and prove a later call observes it.
        pg.query(f"UPDATE profiles SET role='MEMBER' WHERE id={quote(actors['profile'])};")
        result=pg.value(f"SET ROLE service_role; SELECT public.get_parent_credit_rollup({quote(parent)},{quote(actors['profile'])});")
        checks.append({'case':'profile authority revocation observed','passed':result=={'error':'parent_admin_required'}})
    receipt={'mode':'isolated PostgreSQL focused schema','baseline':args.baseline,'checks':checks,'passed':all(x['passed'] for x in checks),'cluster_stopped':True,'baseline_sha256':hashlib.sha256(baseline.read_bytes()).hexdigest()}
    if not args.baseline:
        receipt['repair_sha256']=hashlib.sha256(repair.read_bytes()).hexdigest()
    (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'passed':receipt['passed'],'checks':len(checks),'failed':[x['case'] for x in checks if not x['passed']]}))
    return 0 if receipt['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
