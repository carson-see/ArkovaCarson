#!/usr/bin/env python3
"""Read-only production check for the emergency secured-anchor drain RPC.

This protects PR #659's highest-risk assumption: production must have the same
SECURITY DEFINER drain helper shape the worker calls, and the helper must not be
executable by broad PostgREST roles.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


PROJECT_REF = os.environ.get("SUPABASE_PROJECT_REF", "vzwyaatejekddvltxyye")
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN")
MIGRATION = Path("supabase/migrations/0283_drain_submitted_to_secured_helper.sql")
AUTH_HINT = (
  "SUPABASE_ACCESS_TOKEN must be a Supabase Management API token for an "
  f"account that can read project {PROJECT_REF}; fine-grained tokens need "
  "database_read for this check and database_migrations_read for the paired "
  "migration drift check. Do not use anon/service_role JWTs, database "
  "passwords, or project API keys."
)

QUERY = r"""
WITH fn AS (
  SELECT
    p.oid,
    pg_get_functiondef(p.oid) AS definition,
    p.prosecdef,
    p.proconfig,
    EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
      WHERE acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
    ) AS public_can_execute,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'drain_submitted_to_secured_for_tx'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_chain_tx_id text, p_block_height integer, p_block_timestamp timestamp with time zone, p_batch_size integer, p_max_iterations integer, p_confirmations integer'
)
SELECT * FROM fn;
"""

SIGNATURE_QUERY = r"""
SELECT
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef,
  p.proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'drain_submitted_to_secured_for_tx'
ORDER BY args;
"""


def fail(message: str) -> None:
  print(f"::error title=Prod drain function check failed::{message}", file=sys.stderr)
  sys.exit(1)


def rows_from_response(payload: object) -> list[dict[str, object]]:
  if isinstance(payload, list):
    return [row for row in payload if isinstance(row, dict)]
  if not isinstance(payload, dict):
    return []

  for key in ("data", "rows", "result"):
    value = payload.get(key)
    if isinstance(value, list):
      return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict) and isinstance(value.get("rows"), list):
      return [row for row in value["rows"] if isinstance(row, dict)]
  return []


def execute_read_only_query(query: str) -> list[dict[str, object]]:
  if not TOKEN:
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request":
      print(
        "::notice title=Prod drain function check skipped::"
        "SUPABASE_ACCESS_TOKEN is not available to this pull_request run."
      )
      sys.exit(0)
    fail(f"SUPABASE_ACCESS_TOKEN is required for the read-only function body check. {AUTH_HINT}")

  if TOKEN.startswith("eyJ") and TOKEN.count(".") == 2:
    fail(f"SUPABASE_ACCESS_TOKEN looks like a JWT/project API key, not a Supabase Management API token. {AUTH_HINT}")

  request = urllib.request.Request(
    f"https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query/read-only",
    data=json.dumps({"query": query}).encode("utf-8"),
    headers={
      "Authorization": f"Bearer {TOKEN}",
      "Content-Type": "application/json",
      # Supabase sits behind Cloudflare; Python's default urllib user-agent can
      # be rejected with 403/1010 even when the token and query are valid.
      "User-Agent": "arkova-ci-prod-drain-check/1.0",
    },
    method="POST",
  )

  try:
    with urllib.request.urlopen(request, timeout=30) as response:
      body = response.read().decode("utf-8")
  except urllib.error.HTTPError as error:
    body = error.read().decode("utf-8", errors="replace")
    if error.code in (401, 403):
      fail(
        "Supabase Management API rejected the read-only prod function check "
        f"for project {PROJECT_REF} (HTTP {error.code}). {AUTH_HINT} Verify "
        "the GitHub Actions secret value and the token owner's project/org "
        "access before replacing it, then re-run Migration Drift Check before "
        "merging."
      )
    preview = body[:300].replace("\n", " ")
    fail(f"Supabase read-only SQL endpoint returned HTTP {error.code}: {preview}")
  except urllib.error.URLError as error:
    fail(f"Could not reach Supabase read-only SQL endpoint: {error.reason}")

  try:
    payload = json.loads(body)
  except json.JSONDecodeError as error:
    fail(f"Supabase SQL response was not JSON: {error}")

  return rows_from_response(payload)


def normalized_sql(sql: str) -> str:
  return " ".join(sql.lower().split())


def as_bool(value: object) -> bool | None:
  if isinstance(value, bool):
    return value
  if isinstance(value, str):
    lowered = value.lower()
    if lowered in ("true", "t", "1"):
      return True
    if lowered in ("false", "f", "0"):
      return False
  return None


def main() -> None:
  if not MIGRATION.exists():
    fail(f"Missing local migration file: {MIGRATION}")

  migration_sql = MIGRATION.read_text(encoding="utf-8")
  required_local = [
    "REVOKE ALL ON FUNCTION public.drain_submitted_to_secured_for_tx(text, int, timestamptz, int, int, int) FROM PUBLIC;",
    "GRANT EXECUTE ON FUNCTION public.drain_submitted_to_secured_for_tx(text, int, timestamptz, int, int, int) TO service_role;",
  ]
  for needle in required_local:
    if needle not in migration_sql:
      fail(f"Local migration is missing required grant posture: {needle}")

  rows = execute_read_only_query(QUERY)
  if len(rows) != 1:
    present_rows = execute_read_only_query(SIGNATURE_QUERY)
    signatures = "; ".join(str(row.get("args") or "<unknown>") for row in present_rows)
    if not signatures:
      signatures = "none"
    fail(
      "Expected exactly one prod drain function with the 6-argument "
      "p_confirmations signature from migration 0283; got "
      f"{len(rows)}. Present drain function signatures: {signatures}. "
      "Apply/reconcile 0283_drain_submitted_to_secured_helper before "
      "merging worker code that calls the new signature."
    )

  row = rows[0]
  definition = str(row.get("definition") or "")
  if not definition:
    fail("pg_get_functiondef returned an empty function body")

  normalized = normalized_sql(definition)
  required_body_tokens = [
    "security definer",
    "set search_path to 'public'",
    "set statement_timeout to '50s'",
    "for update skip locked",
    "set_config('request.jwt.claim.role'::text, 'service_role'::text, true)",
    "chain_confirmations = greatest(p_confirmations, 1)",
    "insert into public.anchor_chain_index",
    "confirmations = greatest(coalesce(anchor_chain_index.confirmations, 0), excluded.confirmations)",
    "'capped'",
  ]
  missing = [token for token in required_body_tokens if token not in normalized]
  if missing:
    fail("Prod drain function body is missing required behavior tokens: " + ", ".join(missing))

  proconfig = row.get("proconfig") or []
  if isinstance(proconfig, str):
    proconfig_values = [proconfig]
  elif isinstance(proconfig, list):
    proconfig_values = [str(item) for item in proconfig]
  else:
    proconfig_values = []

  checks = {
    "SECURITY DEFINER": as_bool(row.get("prosecdef")) is True,
    "search_path=public": "search_path=public" in proconfig_values,
    "statement_timeout=50s": "statement_timeout=50s" in proconfig_values,
    "PUBLIC cannot execute": as_bool(row.get("public_can_execute")) is False,
    "anon cannot execute": as_bool(row.get("anon_can_execute")) is False,
    "authenticated cannot execute": as_bool(row.get("authenticated_can_execute")) is False,
    "service_role can execute": as_bool(row.get("service_role_can_execute")) is True,
  }
  failed = [name for name, ok in checks.items() if not ok]
  if failed:
    fail("Prod drain function grant/config checks failed: " + ", ".join(failed))

  digest = hashlib.sha256(definition.encode("utf-8")).hexdigest()
  print("Prod drain function check passed")
  print(f"- pg_get_functiondef sha256: {digest}")
  for name in checks:
    print(f"- {name}: ok")

  summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
  if summary_path:
    with open(summary_path, "a", encoding="utf-8") as summary:
      summary.write("\n## Prod drain function check\n")
      summary.write(f"- `pg_get_functiondef` sha256: `{digest}`\n")
      for name in checks:
        summary.write(f"- {name}: ok\n")


if __name__ == "__main__":
  main()
