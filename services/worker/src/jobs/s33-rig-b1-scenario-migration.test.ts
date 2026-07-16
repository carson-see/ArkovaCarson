import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../supabase/migrations/0359_s33_rig_b1_scenario_lease.sql',
  import.meta.url,
);
const baselineUrl = new URL(
  '../../../../supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
  import.meta.url,
);

function migration(): string {
  return readFileSync(migrationUrl, 'utf8');
}

function claimBody(sql: string): string {
  const start = sql.search(/CREATE OR REPLACE FUNCTION\s+"?public"?\."?claim_pending_anchors"?/i);
  if (start < 0) throw new Error('claim_pending_anchors definition missing');
  const bodyStart = sql.indexOf('AS $$', start);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('claim_pending_anchors body missing');
  return sql.slice(bodyStart + 5, bodyEnd);
}

function normalizeClaimBody(body: string): string {
  return body
    .replace(/AND NOT \(COALESCE\(a2\.metadata, '\{\}'::jsonb\) \? 's33_rig_b1'\)/i, '')
    .replace(/"/g, '')
    .replace(/\bpublic\./gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('RIG-B1 durable scenario migration contract', () => {
  it('uses one CAS owner and a strict PREPARING -> ARMED -> RUNNING lifecycle', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE TABLE public\.s33_rig_b1_scenario_control/i);
    expect(sql).toMatch(/generation bigint NOT NULL DEFAULT 0/i);
    expect(sql).toMatch(/WHERE singleton FOR UPDATE/i);
    expect(sql).toMatch(/phase text NOT NULL[\s\S]*'PREPARING'[\s\S]*'ARMED'[\s\S]*'RUNNING'/i);
    expect(sql).toMatch(/v_lease\.phase <> 'PREPARING'[\s\S]*RAISE serialization_failure/i);
    expect(sql).toMatch(/v_lease\.phase = 'PREPARING'[\s\S]*v_mode := 'PREPARING_SKIP'/i);
    expect(sql).toMatch(/v_lease\.phase = 'ARMED'[\s\S]*v_mode := 'TARGET_EXECUTE'[\s\S]*SET phase = 'RUNNING'/i);
    expect(sql).toMatch(/v_mode := 'TARGET_REPLAY'/i);
  });

  it('caps every active lease below the five-minute cadence and binds release authority', () => {
    const sql = migration();
    expect(sql).toMatch(/p_ttl_seconds[^;]*< 1 OR p_ttl_seconds > 240/i);
    expect(sql).toMatch(/expires_at <= updated_at \+ interval '4 minutes'/i);
    expect(sql).toMatch(/expires_at <= authority_expires_at/i);
    expect(sql).toMatch(/authority_expires_at <= v_now \+ make_interval\(secs => p_ttl_seconds\)/i);
  });

  it('authenticates exact service, revision, audience, secret and OIDC before audit mutation', () => {
    const sql = migration();
    expect(sql).toMatch(/p_auth_accepted IS DISTINCT FROM true/i);
    expect(sql).toMatch(/p_auth_method IS NULL[\s\S]*p_auth_method NOT IN/i);
    const auth = sql.indexOf("p_auth_method NOT IN ('google-oidc', 'combined')");
    const eventInsert = sql.indexOf('INSERT INTO public.s33_rig_b1_scenario_events', auth);
    expect(auth).toBeGreaterThan(-1);
    expect(eventInsert).toBeGreaterThan(auth);
    expect(sql).toMatch(/p_cron_secret_valid IS DISTINCT FROM true/i);
    expect(sql).toMatch(/p_oidc_principal IS DISTINCT FROM 's33-rig-b1-cron@arkova1\.iam\.gserviceaccount\.com'/i);
    expect(sql).toMatch(/p_oidc_email_verified IS DISTINCT FROM true/i);
    expect(sql).toMatch(/p_service_name IS DISTINCT FROM 'arkova-worker-s33-rig-b1-staging'/i);
    expect(sql).toMatch(/p_worker_id IS DISTINCT FROM v_lease\.worker_revision/i);
    expect(sql).toMatch(/p_service_audience IS DISTINCT FROM v_lease\.service_audience/i);
    expect(sql).toMatch(/p_oidc_audience IS DISTINCT FROM v_lease\.service_audience/i);
  });

  it('derives identity only from exact Scheduler job resource and canonical schedule time', () => {
    const sql = migration();
    const gateStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.gate_s33_rig_b1_scenario_execution');
    const gateReturns = sql.indexOf('RETURNS jsonb', gateStart);
    const gateSignature = sql.slice(gateStart, gateReturns);
    expect(sql).toMatch(/convert_to\('arkova\.s33\.rig-b1\.scheduler-execution\/v1', 'UTF8'\)[\s\S]*decode\('00', 'hex'\)[\s\S]*convert_to\(p_job_resource, 'UTF8'\)[\s\S]*decode\('00', 'hex'\)[\s\S]*to_char\(p_schedule_time/i);
    expect(sql).not.toContain('chr(0)');
    expect(sql).toMatch(/extensions\.digest\([\s\S]*'sha256'/i);
    expect(gateSignature).not.toContain('p_scheduler_execution_id');
    expect(sql).toMatch(/CASE p_job_resource[\s\S]*batch-anchors-forced-flush[\s\S]*\/jobs\/batch-anchors\?force=true/i);
  });

  it('uses an exact scenario-only claim RPC and permanently excludes tagged rows from normal claims', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_s33_rig_b1_scenario_anchors/i);
    expect(sql).toMatch(/v_lease\.current_execution_id IS DISTINCT FROM p_scheduler_execution_id/i);
    expect(sql).toMatch(/v_lease\.namespace_id IS DISTINCT FROM p_namespace_id/i);
    expect(sql).toMatch(/metadata->'s33_rig_b1'->>'scenarioLeaseId' = v_lease\.id::text/i);
    expect(sql).toMatch(/metadata->'s33_rig_b1'->>'namespaceId' = p_namespace_id/i);
    expect(sql).toMatch(/NOT \(COALESCE\(a2\.metadata, '\{\}'::jsonb\) \? 's33_rig_b1'\)/i);
  });

  it('allocates globally unique claim order across chunks and org calls without orphaning claims', () => {
    const sql = migration();
    expect(sql).toMatch(/SELECT COALESCE\(max\(c\.claim_order\), 0\)::integer INTO v_claim_offset/i);
    expect(sql).toMatch(/v_claim_offset\s*\+ row_number\(\) OVER[\s\S]*AS claim_order/i);
    const scenarioClaimStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_s33_rig_b1_scenario_anchors');
    const scenarioClaimEnd = sql.indexOf('CREATE OR REPLACE FUNCTION public.list_s33_rig_b1_scenario_orgs');
    const scenarioClaim = sql.slice(scenarioClaimStart, scenarioClaimEnd);
    expect(scenarioClaim).not.toMatch(/ON CONFLICT[\s\S]*DO NOTHING/i);
    expect(scenarioClaim).toMatch(/WHERE id = p_scenario_lease_id FOR UPDATE/i);
  });

  it('requires live control, authority, expiry, and exact worker revision on every scenario data RPC', () => {
    const sql = migration();
    for (const functionName of [
      'claim_s33_rig_b1_scenario_anchors',
      'observe_s33_rig_b1_scenario_pending',
      'recover_s33_rig_b1_scenario_broadcasts',
      'list_s33_rig_b1_scenario_orgs',
      'record_s33_rig_b1_scenario_batch',
      'record_s33_rig_b1_scenario_denial_pass',
    ]) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
      const end = sql.indexOf('$$;', sql.indexOf('AS $$', start));
      const body = sql.slice(start, end);
      expect(body).toMatch(/active_lease_id IS DISTINCT FROM v_lease\.id/i);
      expect(body).toMatch(/v_control\.generation <> p_generation/i);
      expect(body).toMatch(/worker_revision IS DISTINCT FROM p_worker_id/i);
      expect(body).toMatch(/expires_at <= clock_timestamp\(\)/i);
      expect(body).toMatch(/authority_expires_at <= clock_timestamp\(\)/i);
    }
  });

  it('uses explicit NULL guards and an exact six-value target allowlist', () => {
    const sql = migration();
    expect(sql).toMatch(/p_seed_manifest_sha256 IS NULL[\s\S]*p_seed_manifest_sha256 !~/i);
    expect(sql).toMatch(/p_result_digest IS NULL OR p_result_digest !~/i);
    const targetConstraint = sql.match(/target_job_resource text NOT NULL CHECK \(target_job_resource IN \(([\s\S]*?)\n[ ]{2}\)\)/i)?.[1] ?? '';
    expect(targetConstraint.match(/projects\/arkova1\/locations\/us-central1\/jobs\//g)).toHaveLength(6);
    expect(targetConstraint).not.toContain('~');
  });

  it('changes ordinary claim semantics by only the permanent namespace exclusion predicate', () => {
    const currentBody = normalizeClaimBody(claimBody(migration()));
    const baselineBody = normalizeClaimBody(claimBody(readFileSync(baselineUrl, 'utf8')));
    expect(currentBody).toBe(baselineBody);
  });

  it('atomically returns the same lease to PREPARING between ordered scenarios', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.complete_s33_rig_b1_scenario_execution/i);
    expect(sql).toMatch(/IF p_next_scenario IS NULL THEN[\s\S]*active_lease_id = NULL/i);
    expect(sql).toMatch(/SET generation = v_generation, phase = 'PREPARING'[\s\S]*scenario_id = p_next_scenario->>'scenarioId'/i);
    expect(sql).toMatch(/UPDATE public\.s33_rig_b1_scenario_control[\s\S]*SET generation = v_generation, updated_at = v_now WHERE singleton/i);
    expect(sql).toMatch(/capture_id = p_next_scenario->>'captureId'/i);
    expect(sql).toMatch(/RETURN jsonb_build_object\('captureId', p_capture_id/i);
  });

  it('persists exact capture identity and seeds the five immutable scenarios in one protected transaction', () => {
    const sql = migration();
    expect(sql).toMatch(/capture_id text NOT NULL CHECK \(capture_id ~ '\^sha256:/i);
    expect(sql).toMatch(/CREATE TABLE public\.s33_rig_b1_scenario_captures/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.prepare_s33_rig_b1_scenario_seed/i);
    expect(sql).toMatch(/LOCK TABLE public\.anchors IN SHARE ROW EXCLUSIVE MODE/i);
    expect(sql).toMatch(/INSERT_ZIPF_30'[\s\S]*ADD_ZIPF_30'[\s\S]*CARRY_AND_AGE'[\s\S]*RESET_FORCED_CONTROL'[\s\S]*RESET_ORG_POISON_ZIPF_30'/i);
    expect(sql).toMatch(/'isolation', 'repeatable-read'/i);
    expect(sql).toMatch(/seed_artifact_raw = v_seed_raw, seed_manifest_sha256 = v_seed_digest/i);
  });

  it('persists all truthful per-batch and no-broadcast outcomes without aggregate identities', () => {
    const sql = migration();
    expect(sql).not.toMatch(/UNIQUE \(scenario_lease_id, generation, scheduler_execution_id\)/i);
    expect(sql).toMatch(/CREATE TABLE public\.s33_rig_b1_scenario_denials/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.record_s33_rig_b1_scenario_denial_pass/i);
    expect(sql).toMatch(/arkova\.s33\.rig-b1\.denial-outcome\/v1/i);
    expect(sql).toMatch(/WHEN v_capture\.operation = 'INSERT_ZIPF_30' THEN 'trigger-a-size:1'/i);
    expect(sql).toMatch(/WHEN v_capture\.operation = 'ADD_ZIPF_30' THEN 'trigger-a-size:2'/i);
    expect(sql).toMatch(/WHEN v_capture\.operation = 'CARRY_AND_AGE' THEN 'trigger-b-age:1'/i);
    expect(sql).toMatch(/WHEN v_capture\.operation = 'RESET_FORCED_CONTROL' THEN 'trigger-d-force:1'/i);
    expect(sql).toMatch(/WHEN v_capture\.operation = 'RESET_ORG_POISON_ZIPF_30' THEN 'org-scheduler:1'/i);
    expect(sql).toMatch(/'outcome', 'broadcast'[\s\S]*'outcome', 'no-broadcast'/i);
    expect(sql).toMatch(/'deniedOutcomes'[\s\S]*'batchId', NULL, 'txId', NULL, 'merkleRoot', NULL/i);
    expect(sql).toMatch(/jsonb_agg\(p\.pass ORDER BY p\.first_order, p\.outcome_order, p\.identity\)/i);
  });

  it('persists exact outcome bytes before return and binds abort plus cleanup to terminal authority', () => {
    const sql = migration();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.observe_s33_rig_b1_scenario_outcome/i);
    expect(sql).toMatch(/outcome_artifact_raw = v_artifact_raw[\s\S]*outcome_artifact_sha256 = v_artifact_digest/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.abort_s33_rig_b1_scenario_lease/i);
    expect(sql).toMatch(/phase NOT IN \('PREPARING', 'ARMED', 'RUNNING'\)/i);
    expect(sql).toMatch(/SET generation = v_generation, active_lease_id = NULL/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.cleanup_s33_rig_b1_scenario_run/i);
    expect(sql).toMatch(/v_lease\.plan_id IS DISTINCT FROM p_plan_id/i);
    expect(sql).toMatch(/v_lease\.run_id IS DISTINCT FROM p_run_id/i);
    expect(sql).toMatch(/outcome_artifact_raw IS NOT NULL[\s\S]*v_preserved <> v_outcomes/i);
    expect(sql).toMatch(/status = 'PENDING'[\s\S]*NOT EXISTS \([\s\S]*s33_rig_b1_scenario_claims/i);
  });

  it('keeps every scenario table service-role-owned and client-denied', () => {
    const sql = migration();
    for (const table of ['leases', 'control', 'events', 'claims', 'batches', 'denials', 'captures']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.s33_rig_b1_scenario_${table} FORCE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.s33_rig_b1_scenario_${table} FROM PUBLIC, anon, authenticated`, 'i'));
    }
    expect(sql).not.toMatch(/GRANT[^;]*\b(?:INSERT|UPDATE|DELETE)\b[^;]*s33_rig_b1_scenario_[^;]*TO service_role/i);
  });
});
