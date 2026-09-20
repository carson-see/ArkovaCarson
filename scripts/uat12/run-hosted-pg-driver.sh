#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${UAT_DATABASE_URL:-}" ]]; then
  echo 'UAT_DATABASE_URL is required.' >&2
  exit 2
fi
python3 - <<'PY'
import os
import subprocess
import sys
from urllib.parse import unquote, urlparse

expected_user = 'postgres.vaarxclqdxnwoxziolmp'
expected_host = 'aws-0-us-east-2.pooler.supabase.com'
try:
    parsed = urlparse(os.environ['UAT_DATABASE_URL'])
    if parsed.scheme not in {'postgres', 'postgresql'}:
        raise ValueError('scheme')
    if unquote(parsed.username or '') != expected_user or parsed.hostname != expected_host:
        raise ValueError('owned target')
    if (parsed.port or 5432) != 5432 or parsed.path != '/postgres':
        raise ValueError('database')
    if parsed.query != 'sslmode=require' or not parsed.password:
        raise ValueError('connection policy')
    child_env = os.environ.copy()
    child_env.pop('UAT_DATABASE_URL', None)
    child_env.update({
        'PGHOST': expected_host,
        'PGPORT': '5432',
        'PGUSER': expected_user,
        'PGPASSWORD': unquote(parsed.password),
        'PGDATABASE': 'postgres',
        'PGSSLMODE': 'require',
    })
    result = subprocess.run(
        ['/opt/homebrew/opt/postgresql@17/bin/psql', '-v', 'ON_ERROR_STOP=1',
         '-f', 'scripts/uat12/hosted-pg-driver.sql'],
        env=child_env, capture_output=True, text=True, check=False,
    )
    if result.returncode:
        sys.stderr.write('UAT-12 owned-hosted PostgreSQL driver failed.\n')
        raise SystemExit(result.returncode)
    sys.stdout.write(result.stdout)
except (KeyError, TypeError, ValueError):
    sys.stderr.write('UAT_DATABASE_URL is not the approved owned UAT-17 target.\n')
    raise SystemExit(2)
PY
