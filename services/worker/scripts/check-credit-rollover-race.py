#!/usr/bin/env python3
"""Exercise actual migration bodies on disposable PostgreSQL with two sessions.
Requires Docker and postgres:17. No host ports, external network, credentials,
or application database are used. The owned container is removed on exit.
Run from any directory: python3 services/worker/scripts/check-credit-rollover-race.py
"""
import subprocess,pathlib,re,time,json,uuid,atexit
repo=pathlib.Path(__file__).resolve().parents[3]
container='arkova-credit-race-'+uuid.uuid4().hex[:12]
subprocess.run(['docker','run','-d','--name',container,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17'],check=True,stdout=subprocess.DEVNULL)
atexit.register(lambda:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
for attempt in range(100):
 if subprocess.run(['docker','exec',container,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.1)
else:raise RuntimeError('isolated postgres did not become ready')
base=['docker','exec','-i',container,'psql','-U','postgres','-X','-qAt','-v','ON_ERROR_STOP=1']
def sql(s):return subprocess.check_output(base,input=s,text=True).strip()
source=(repo/'supabase/migrations/0420_scrum2538_check_unified_credits_fail_closed.sql').read_text()
body=re.search(r'CREATE OR REPLACE FUNCTION public.check_unified_credits\(.*?\n\$\$;',source,re.S).group()
sql('CREATE TABLE IF NOT EXISTS public.unified_credits(id uuid PRIMARY KEY,org_id uuid,user_id uuid,monthly_allocation integer,used_this_month integer,carry_over integer,billing_cycle_start timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());')
fixed_source=(repo/'supabase/migrations/0434_unified_credits_rollover_row_lock.sql').read_text()
fixed_body=re.search(r'CREATE OR REPLACE FUNCTION public.check_unified_credits\(.*?\n\$\$;',fixed_source,re.S).group()
results=[]
for label,function in [('original',body),('locked',fixed_body)]:
 sql(function)
 sql("TRUNCATE unified_credits; INSERT INTO unified_credits(id,org_id,monthly_allocation,used_this_month,carry_over,billing_cycle_start) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',50,30,0,date_trunc('month',now())-interval '1 month');")
 b=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 b.stdin.write("BEGIN; SELECT id FROM unified_credits FOR UPDATE;\n");b.stdin.flush();assert b.stdout.readline().strip().endswith('000000000001')
 a=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 a.stdin.write("SET application_name='race2442_reader'; SELECT * FROM check_unified_credits('00000000-0000-4000-8000-000000000002');\n");a.stdin.close();a.stdin=None
 for i in range(100):
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='race2442_reader' AND wait_event_type='Lock';")=='1':break
  time.sleep(.05)
 else:raise RuntimeError('reader never blocked')
 # Concurrent owner rolls the month and commits one successful debit.
 b.stdin.write("UPDATE unified_credits SET billing_cycle_start=date_trunc('month',now()),used_this_month=1,carry_over=20; COMMIT;\n");b.stdin.close();b.stdin=None
 bo,be=b.communicate(timeout=10);assert b.returncode==0,be
 ao,ae=a.communicate(timeout=10);assert a.returncode==0,ae
 used=int(sql('SELECT used_this_month FROM unified_credits;'))
 results.append({'variant':label,'used_after_committed_debit_and_overlapping_check':used,'check_result':ao.strip()})
assert results[0]['used_after_committed_debit_and_overlapping_check']==0
assert results[1]['used_after_committed_debit_and_overlapping_check']==1
print(json.dumps(results,indent=2))
