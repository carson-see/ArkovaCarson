#!/usr/bin/env python3
"""Real PostgreSQL replay/rolling-upgrade regression in an owned isolated container.
Use --baseline to prove the pre-fix migration admits a replay. No external DB.
"""
import pathlib,subprocess,time,uuid,atexit,sys,json,re
repo=pathlib.Path(__file__).resolve().parents[3];container='arkova-nonce-race-'+uuid.uuid4().hex[:10]
subprocess.run(['docker','run','-d','--name',container,'--network','none','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17'],check=True,stdout=subprocess.DEVNULL)
atexit.register(lambda:subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
for i in range(200):
 logs=subprocess.run(['docker','logs',container],capture_output=True,text=True)
 if 'PostgreSQL init process complete' in logs.stdout and subprocess.run(['docker','exec',container,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.1)
else:raise RuntimeError('Postgres did not start')
cmd=['docker','exec','-i',container,'psql','-U','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(s,ok=True):
 r=subprocess.run(cmd,input=s,text=True,capture_output=True)
 if ok:assert r.returncode==0,r.stderr
 return r
sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.docusign_webhook_nonces(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),envelope_id text NOT NULL,event_id text NOT NULL,generated_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT docusign_webhook_nonces_envelope_id_event_id_generated_at_key UNIQUE(envelope_id,event_id,generated_at)); INSERT INTO docusign_webhook_nonces(envelope_id,event_id,generated_at) VALUES('envelope','event','2026-09-05T00:00:00Z');")
sql((repo/'supabase/migrations/0424_docusign_webhook_nonces_tenant_scope.sql').read_text())
if '--baseline' not in sys.argv:sql((repo/'supabase/migrations/0435_docusign_nonce_legacy_rollout_guard.sql').read_text())
def insert(account):
 value='NULL' if account is None else "'"+account+"'"
 return "INSERT INTO public.docusign_webhook_nonces(account_id,envelope_id,event_id,generated_at) VALUES("+value+",'envelope','event','2026-09-05T00:00:00Z');"
r=sql(insert('account-a'),False);assert r.returncode!=0 and '23505' in r.stderr,'Recent legacy nonce replay was accepted'
results=[{'case':'legacy row blocks tenant replay','passed':True}]
for first,second,rejected in [('account-a',None,True),(None,'account-a',True),('account-a','account-b',False),('account-a','account-a',True)]:
 sql('TRUNCATE public.docusign_webhook_nonces;')
 a=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1);a.stdin.write('BEGIN; '+insert(first)+" SELECT 'LOCKED';\n");a.stdin.flush();assert a.stdout.readline().strip()=='LOCKED'
 b=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);b.stdin.write("SET TIME ZONE 'Pacific/Honolulu'; SET application_name='nonce_second'; "+insert(second)+'\n');b.stdin.close();b.stdin=None
 for i in range(100):
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='nonce_second' AND wait_event_type='Lock';").stdout.strip()=='1':break
  time.sleep(.02)
 else:raise RuntimeError('Concurrent insertion did not reach lock wait')
 a.stdin.write('COMMIT;\n');a.stdin.close();a.stdin=None;ao,ae=a.communicate(timeout=10);assert a.returncode==0,ae
 bo,be=b.communicate(timeout=10);assert (b.returncode!=0)==rejected,(first,second,be)
 if rejected:assert '23505' in be,be
 count=int(sql('SELECT count(*) FROM public.docusign_webhook_nonces;').stdout.strip());assert count==(1 if rejected else 2)
 results.append({'first':first,'second':second,'second_rejected':rejected,'rows':count,'passed':True})
migration=(repo/'supabase/migrations/0424_docusign_webhook_nonces_tenant_scope.sql').read_text()
rollback='\n'.join(line[5:] for line in re.search(r'--   BEGIN;.*?--   COMMIT;',migration,re.S).group().splitlines())
r=sql(rollback,False);assert r.returncode!=0 and 'Nonce table is not empty' in r.stderr
assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name='docusign_webhook_nonces' AND column_name='account_id';").stdout.strip()=='1'
assert sql('SELECT count(*) FROM public.docusign_webhook_nonces;').stdout.strip()=='1'
results.append({'case':'schema rollback refuses live replay records without losing data','passed':True})
sql('TRUNCATE public.docusign_webhook_nonces;');sql(rollback)
assert sql("SELECT count(*) FROM information_schema.columns WHERE table_name='docusign_webhook_nonces' AND column_name='account_id';").stdout.strip()=='0'
sql(migration);sql((repo/'supabase/migrations/0435_docusign_nonce_legacy_rollout_guard.sql').read_text())
sql(insert(None));r=sql(insert('account-a'),False);assert r.returncode!=0 and '23505' in r.stderr
results.append({'case':'empty schema rollback and reapply restore guarded behavior','passed':True})
print(json.dumps(results,indent=2))
