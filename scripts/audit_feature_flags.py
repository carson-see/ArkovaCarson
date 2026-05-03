#!/usr/bin/env python3
"""Generate a feature-flag inventory for launch hygiene.

The goal is not to decide product policy in code. The goal is to make drift
visible: every ENABLE_* reference, where it appears, and which launch-critical
flags need human review before first-client beta access.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STAMP = date.today().isoformat()
OUT_MD = ROOT / "docs" / "audits" / f"feature-flag-register-{STAMP}.md"
OUT_JSON = ROOT / "docs" / "audits" / f"feature-flag-register-{STAMP}.json"

ENV_EXAMPLE = ".env.example"
ENV_TEST_EXAMPLE = ".env.test.example"
ENV_DOC = "docs/reference/ENV.md"
FRONTEND_SWITCHBOARD = "src/lib/switchboard.ts"
PLATFORM_CONTROLS = "src/pages/PlatformControlsPage.tsx"
SUPABASE_SEED = "supabase/seed.sql"
WORKER_CONFIG = "services/worker/src/config.ts"
WORKER_FLAG_REGISTRY = "services/worker/src/middleware/flagRegistry.ts"
INTEGRATION_KILL_SWITCH = "services/worker/src/middleware/integrationKillSwitch.ts"

REG_WORKER = "worker_registry"
REG_FRONTEND = "frontend_switchboard"
REG_INTEGRATION_KILL_SWITCH = "integration_killswitch"
REG_WORKER_CONFIG = "worker_config_comments"
REG_DB_SEED = "db_seed"
REG_PLATFORM_CONTROLS = "platform_controls"

FLAG_RE = re.compile(r"\b(?:VITE_)?ENABLE_[A-Z0-9_]+\b|\bMAINTENANCE_MODE\b|\bUSE_MOCKS\b")
DEFAULT_LINE_RE = re.compile(r"^((?:VITE_)?ENABLE_[A-Z0-9_]+|MAINTENANCE_MODE|USE_MOCKS)\s*=\s*([^#\s]+)")
FRONTEND_FLAGS_BODY_RE = re.compile(r"export const FLAGS = \{(?P<body>.*?)\} as const;", re.S)
FRONTEND_DEFAULT_RE = re.compile(r"\b([A-Z0-9_]+):\s*(true|false)")
SUPABASE_DEFAULT_RE = re.compile(
    r"\('((?:ENABLE_[A-Z0-9_]+|MAINTENANCE_MODE|USE_MOCKS))',\s*(true|false),\s*(true|false)"
)
ZOD_DEFAULT_RE = re.compile(r"\.default\((true|false)\)")

EXCLUDE_GLOBS = [
    "!node_modules",
    "!.git",
    "!dist",
    "!build",
    "!coverage",
    "!docs/prds/generated",
    "!*.docx",
    "!*.png",
    "!*.pdf",
    "!.env",
    "!.env.local",
    "!services/worker/.env",
    "!packages/arkova-py/.venv",
    "!docs/audits/feature-flag-register-*.json",
    "!docs/audits/feature-flag-register-*.md",
    "!scripts/audit_feature_flags.py",
]

SEARCH_PATHS = [
    ENV_EXAMPLE,
    ENV_TEST_EXAMPLE,
    ".github",
    "src",
    "services",
    "supabase",
    "scripts",
    "docs",
    "packages",
]

LAUNCH_CRITICAL = {
    "ENABLE_AI_EXTRACTION": ("P0", "AI metadata extraction and extraction review workflow"),
    "ENABLE_SEMANTIC_SEARCH": ("P0", "Semantic search and credential/document discovery"),
    "ENABLE_AI_FRAUD": ("P0", "Fraud signal scoring and review queue"),
    "ENABLE_AI_REPORTS": ("P0", "AI-backed reports and exports"),
    "ENABLE_VISUAL_FRAUD_DETECTION": ("P0", "Visual fraud route"),
    "ENABLE_COMPLIANCE_ENGINE": ("P0", "Compliance engine routes"),
    "ENABLE_REPORTS": ("P0", "Report surfaces"),
    "ENABLE_DOCUSIGN_WEBHOOK": ("P0", "DocuSign completed-contract automation"),
    "ENABLE_DOCUSIGN_OAUTH": ("P0", "DocuSign organization account connection"),
    "ENABLE_DRIVE_WEBHOOK": ("P0", "Google Drive watched-folder automation"),
    "ENABLE_DRIVE_OAUTH": ("P0", "Google Drive account connection"),
    "ENABLE_WORKSPACE_RENEWAL": ("P0", "Drive watch renewal"),
    "ENABLE_RULES_ENGINE": ("P0", "Rule evaluation for automation"),
    "ENABLE_RULE_ACTION_DISPATCHER": ("P0", "Rule action fan-out"),
    "ENABLE_QUEUE_REMINDERS": ("P0", "Queue reminder/digest behavior"),
    "ENABLE_ORG_CREDIT_ENFORCEMENT": ("P0", "Bitcoin cost-control credits"),
    "ENABLE_ALLOCATION_ROLLOVER": ("P1", "Monthly credit rollover policy"),
    "ENABLE_TREASURY_ALERTS": ("P1", "Spend/treasury alerting"),
    "ENABLE_PROD_NETWORK_ANCHORING": ("P0", "Real anchoring vs mock anchoring"),
    "ENABLE_VERIFICATION_API": ("P0", "External API beta access"),
    "ENABLE_X402_PAYMENTS": ("P1", "Agentic payment enforcement"),
    "ENABLE_X402_FACILITATOR": ("P1", "x402 facilitator endpoint"),
    "ENABLE_MCP_SERVER": ("P1", "MCP server exposure"),
    "ENABLE_GRC_INTEGRATIONS": ("P0", "GRC config/switchboard name currently used elsewhere"),
    "ENABLE_WEBHOOK_HMAC": ("P0", "Inbound webhook security"),
}

ROADMAP_OR_OPTIONAL = {
    "ENABLE_NESSIE_RAG_RECOMMENDATIONS",
    "ENABLE_MULTIMODAL_EMBEDDINGS",
    "ENABLE_ADES_SIGNATURES",
    "ENABLE_VEREMARK_WEBHOOK",
    "ENABLE_ATS_WEBHOOK",
    "ENABLE_DEMO_INJECTOR",
    "ENABLE_SYNTHETIC_DATA",
}

IGNORE_MATCHES = {
    # Regex/metasyntax examples, not deployable product flags.
    "ENABLE_FLAG",
    "ENABLE_RE",
    "ENABLE_X",
}

EXACT_CATEGORIES = {
    WORKER_CONFIG: "worker-config",
    WORKER_FLAG_REGISTRY: "worker-registry",
    INTEGRATION_KILL_SWITCH: "integration-kill-switch",
    FRONTEND_SWITCHBOARD: "frontend-switchboard",
    PLATFORM_CONTROLS: "frontend-admin-ui",
    ENV_DOC: "env-doc",
}

PREFIX_CATEGORIES = [
    ("supabase/seed", "db-seed-or-migration"),
    ("supabase/migrations", "db-seed-or-migration"),
    (".github/", "deploy-config"),
    ("scripts/deploy", "deploy-config"),
    ("services/edge/", "edge-code"),
    ("services/worker/", "worker-code"),
    ("src/", "frontend-code"),
    ("docs/", "docs"),
]

DOCUMENTED_ENV_FLAGS = [
    "ENABLE_ORG_CREDIT_ENFORCEMENT",
    "ENABLE_DOCUSIGN_WEBHOOK",
    "ENABLE_DRIVE_WEBHOOK",
    "ENABLE_DRIVE_OAUTH",
    "ENABLE_WORKSPACE_RENEWAL",
    "ENABLE_X402_FACILITATOR",
    "ENABLE_MCP_SERVER",
]

REGISTRY_SOURCES = {
    REG_WORKER: WORKER_FLAG_REGISTRY,
    REG_FRONTEND: FRONTEND_SWITCHBOARD,
    REG_INTEGRATION_KILL_SWITCH: INTEGRATION_KILL_SWITCH,
    REG_WORKER_CONFIG: WORKER_CONFIG,
    REG_DB_SEED: SUPABASE_SEED,
    REG_PLATFORM_CONTROLS: PLATFORM_CONTROLS,
}


@dataclass
class Flag:
    name: str
    files: set[str] = field(default_factory=set)
    categories: set[str] = field(default_factory=set)
    examples: list[str] = field(default_factory=list)
    defaults: dict[str, str] = field(default_factory=dict)


def run_rg() -> list[tuple[str, int, str]]:
    cmd = [
        "rg",
        "-n",
        "-o",
        "-I",
        "--with-filename",
        "--hidden",
        "--sort",
        "path",
    ]
    for glob in EXCLUDE_GLOBS:
        cmd.extend(["--glob", glob])
    cmd.append(FLAG_RE.pattern)
    cmd.extend(SEARCH_PATHS)

    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(proc.stderr)

    matches: list[tuple[str, int, str]] = []
    for line in proc.stdout.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        path, lineno, match = parts
        if match.strip() in IGNORE_MATCHES:
            continue
        matches.append((path, int(lineno), match.strip()))
    return matches


def category_for(path: str) -> str:
    exact = EXACT_CATEGORIES.get(path)
    if exact:
        return exact
    if path in {ENV_EXAMPLE, ENV_TEST_EXAMPLE} or path.endswith(ENV_EXAMPLE):
        return "env-example"
    for prefix, category in PREFIX_CATEGORIES:
        if path.startswith(prefix):
            return category
    return "other"


def load_text(path: str) -> str:
    try:
        return (ROOT / path).read_text(errors="ignore")
    except FileNotFoundError:
        return ""


def record_default(flags: dict[str, Flag], name: str, label: str, value: str) -> None:
    if name in flags:
        flags[name].defaults[label] = value


def parse_env_style_defaults(flags: dict[str, Flag]) -> None:
    for path in [ENV_EXAMPLE, ENV_TEST_EXAMPLE, ENV_DOC]:
        for line in load_text(path).splitlines():
            match = DEFAULT_LINE_RE.match(line.strip())
            if match:
                record_default(flags, match.group(1), path, match.group(2))


def parse_frontend_switchboard_defaults(flags: dict[str, Flag]) -> None:
    match = FRONTEND_FLAGS_BODY_RE.search(load_text(FRONTEND_SWITCHBOARD))
    if not match:
        return
    for name, value in FRONTEND_DEFAULT_RE.findall(match.group("body")):
        record_default(flags, name, "frontend-switchboard", value)


def parse_supabase_seed_defaults(flags: dict[str, Flag]) -> None:
    for name, value, default in SUPABASE_DEFAULT_RE.findall(load_text(SUPABASE_SEED)):
        record_default(flags, name, "supabase-seed-value", value)
        record_default(flags, name, "supabase-seed-default", default)


def last_flag_from_text(text: str) -> str | None:
    matches = [name for name in FLAG_RE.findall(text) if name not in IGNORE_MATCHES]
    return matches[-1] if matches else None


def field_name_to_env_flag(field_name: str) -> str | None:
    if field_name == "useMocks":
        return "USE_MOCKS"
    if not field_name.startswith("enable") or len(field_name) == len("enable"):
        return None
    suffix = field_name[len("enable") :]
    snake = re.sub(r"(?<!^)([A-Z])", r"_\1", suffix).upper()
    return f"ENABLE_{snake}"


def worker_config_field_from_line(line: str) -> str | None:
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]", line)
    if not match:
        return None
    return match.group(1)


def maybe_record_worker_config_default(flags: dict[str, Flag], pending_flag: str | None, line: str) -> str | None:
    if "z.preprocess" not in line or ".default(" not in line:
        return pending_flag
    field_flag = None
    field_name = worker_config_field_from_line(line)
    if field_name:
        field_flag = field_name_to_env_flag(field_name)
    flag_name = pending_flag or field_flag
    if not flag_name:
        return pending_flag
    default_match = ZOD_DEFAULT_RE.search(line)
    if default_match:
        record_default(flags, flag_name, "worker-config", default_match.group(1))
    return None


def parse_worker_config_defaults(flags: dict[str, Flag]) -> None:
    # Worker config defaults are documented in comments immediately above each schema field.
    pending_comment_flag: str | None = None
    comment_lines: list[str] = []
    for line in load_text(WORKER_CONFIG).splitlines():
        stripped = line.strip()
        if not comment_lines and not stripped.startswith("/**"):
            pending_comment_flag = maybe_record_worker_config_default(flags, pending_comment_flag, stripped)
            continue

        if stripped.startswith("/**"):
            comment_lines = [stripped]
            if "*/" in stripped:
                pending_comment_flag = last_flag_from_text(" ".join(comment_lines))
                comment_lines = []
            continue

        if comment_lines:
            comment_lines.append(stripped)
            if "*/" in stripped:
                pending_comment_flag = last_flag_from_text(" ".join(comment_lines))
                comment_lines = []


def parse_simple_defaults(flags: dict[str, Flag]) -> None:
    parse_env_style_defaults(flags)
    parse_frontend_switchboard_defaults(flags)
    parse_supabase_seed_defaults(flags)
    parse_worker_config_defaults(flags)


def collect_flags_from(path: str) -> set[str]:
    return {name for name in FLAG_RE.findall(load_text(path)) if name not in IGNORE_MATCHES}


def collect_registry_sets() -> dict[str, set[str]]:
    return {registry: collect_flags_from(path) for registry, path in REGISTRY_SOURCES.items()}


def build_inventory() -> tuple[dict[str, Flag], dict[str, set[str]]]:
    flags: dict[str, Flag] = {}
    for path, lineno, name in run_rg():
        flag = flags.setdefault(name, Flag(name=name))
        flag.files.add(path)
        flag.categories.add(category_for(path))
        if len(flag.examples) < 3:
            flag.examples.append(f"{path}:{lineno}")

    parse_simple_defaults(flags)
    registries = collect_registry_sets()
    return flags, registries


def classify(flag: Flag, registries: dict[str, set[str]]) -> tuple[str, str, str]:
    name = flag.name
    if name in LAUNCH_CRITICAL:
        priority, reason = LAUNCH_CRITICAL[name]
        return priority, "launch-critical", reason
    if name in ROADMAP_OR_OPTIONAL:
        return "P2", "roadmap-or-optional", "Keep outside beta launch unless explicitly scoped and tested."
    if name.startswith("VITE_ENABLE_"):
        return "P2", "frontend-build-flag", "Frontend build-time flag; verify server-side enforcement exists if sensitive."
    if name in {"MAINTENANCE_MODE", "USE_MOCKS"}:
        return "P0", "environment-safety", "Environment-wide runtime behavior; must be explicit in launch config."
    if name in registries[REG_FRONTEND] or name in registries[REG_DB_SEED]:
        return "P2", "platform-switchboard", "Platform flag; verify owner before changing default."
    return "P3", "unclassified", "Needs owner and registry entry if still active."


def default_summary(flag: Flag) -> str:
    if not flag.defaults:
        return "No parsed default"
    return "; ".join(f"{k}={v}" for k, v in sorted(flag.defaults.items()))


def add_finding(findings: list[dict[str, str]], priority: str, title: str, evidence: str, action: str) -> None:
    findings.append({
        "priority": priority,
        "title": title,
        "evidence": evidence,
        "action": action,
    })


def append_grc_name_drift(flags: dict[str, Flag], findings: list[dict[str, str]]) -> None:
    if "ENABLE_GRC_INTEGRATION" in flags and "ENABLE_GRC_INTEGRATIONS" in flags:
        add_finding(
            findings,
            "P0",
            "GRC integration flag name drift",
            "Router/integration kill switch references ENABLE_GRC_INTEGRATION while config, DB seed, and grcFeatureGate use ENABLE_GRC_INTEGRATIONS.",
            "Pick one canonical flag, migrate code/docs/env, and add an unknown-flag check.",
        )


def append_killswitch_schema_findings(registries: dict[str, set[str]], findings: list[dict[str, str]]) -> None:
    for name in sorted(registries[REG_INTEGRATION_KILL_SWITCH]):
        if name in registries[REG_WORKER_CONFIG] or name == "ENABLE_GRC_INTEGRATION":
            continue
        add_finding(
            findings,
            "P0" if name in LAUNCH_CRITICAL else "P1",
            f"{name} is an integration kill switch with no worker config schema entry",
            "The route can be disabled by env var, but config.ts does not absorb/log/validate this flag.",
            "Add to canonical registry/config or explicitly document as env-only kill switch with launch value.",
        )


def append_launch_registry_findings(flags: dict[str, Flag], registries: dict[str, set[str]], findings: list[dict[str, str]]) -> None:
    worker_registry = registries[REG_WORKER]
    for name in sorted(LAUNCH_CRITICAL):
        if name not in flags or not name.startswith("ENABLE_") or name in worker_registry:
            continue
        add_finding(
            findings,
            "P0" if LAUNCH_CRITICAL[name][0] == "P0" else "P1",
            f"{name} absent from worker flagRegistry",
            "flagRegistry.ts claims to centralize worker feature flags, but this launch-critical flag is not loaded/logged there.",
            "Add to canonical registry or update architecture so operators know this flag is controlled elsewhere.",
        )


def append_conflicting_default_findings(flags: dict[str, Flag], findings: list[dict[str, str]]) -> None:
    for name, flag in sorted(flags.items()):
        if len(set(flag.defaults.values())) <= 1:
            continue
        priority = LAUNCH_CRITICAL[name][0] if name in LAUNCH_CRITICAL else "P2"
        add_finding(
            findings,
            priority,
            f"{name} has conflicting parsed defaults",
            default_summary(flag),
            "Define environment-specific defaults in the canonical register and stop relying on scattered fallback values.",
        )


def append_env_doc_findings(flags: dict[str, Flag], findings: list[dict[str, str]]) -> None:
    for name in DOCUMENTED_ENV_FLAGS:
        if name not in flags or ENV_DOC in flags[name].files:
            continue
        priority = "P0" if name in LAUNCH_CRITICAL and LAUNCH_CRITICAL[name][0] == "P0" else "P1"
        evidence = f"Referenced in {', '.join(sorted(flags[name].files)[:5])}."
        add_finding(
            findings,
            priority,
            f"{name} missing from docs/reference/ENV.md",
            evidence,
            "Add to canonical environment docs with default, owner, launch value, and fail mode.",
        )


def drift_findings(flags: dict[str, Flag], registries: dict[str, set[str]]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    append_grc_name_drift(flags, findings)
    append_killswitch_schema_findings(registries, findings)
    append_launch_registry_findings(flags, registries, findings)
    append_conflicting_default_findings(flags, findings)
    append_env_doc_findings(flags, findings)

    return findings


def write_outputs(flags: dict[str, Flag], registries: dict[str, set[str]]) -> None:
    findings = drift_findings(flags, registries)

    data = {
        "generated_at": STAMP,
        "flag_count": len(flags),
        "flags": [],
        "findings": findings,
        "registry_sets": {k: sorted(v) for k, v in registries.items()},
    }

    rows = []
    for flag in sorted(flags.values(), key=lambda f: f.name):
        priority, category, launch_reason = classify(flag, registries)
        record = {
            "name": flag.name,
            "priority": priority,
            "classification": category,
            "launch_reason": launch_reason,
            "categories": sorted(flag.categories),
            "files": sorted(flag.files),
            "examples": flag.examples,
            "defaults": dict(sorted(flag.defaults.items())),
        }
        data["flags"].append(record)
        rows.append(record)

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    p0_flags = [r for r in rows if r["priority"] == "P0"]
    p1_flags = [r for r in rows if r["priority"] == "P1"]
    top_findings = [f for f in findings if f["priority"] in {"P0", "P1"}]

    lines: list[str] = []
    lines.append("# Arkova Feature Flag Register")
    lines.append("")
    lines.append(f"Date: {STAMP}")
    lines.append("Status: Active audit artifact")
    lines.append("Owner: Launch control / engineering")
    lines.append("")
    lines.append("## Executive Summary")
    lines.append("")
    lines.append(f"Found **{len(flags)}** distinct feature-flag or environment-safety references across code, migrations, docs, deploy config, and examples.")
    lines.append("")
    lines.append("The important hygiene finding is that Arkova does not currently have one flag system. Flags are split across worker env config, DB switchboard rows, frontend defaults, integration kill switches, edge env, deploy scripts, and docs. That is manageable only if a canonical register becomes the operating source of truth.")
    lines.append("")
    lines.append("## P0/P1 Drift Findings")
    lines.append("")
    lines.append("| Priority | Finding | Evidence | Required action |")
    lines.append("| --- | --- | --- | --- |")
    for f in top_findings:
        lines.append(f"| {f['priority']} | {f['title']} | {f['evidence']} | {f['action']} |")
    lines.append("")
    lines.append("## Launch-Critical Flags")
    lines.append("")
    lines.append("| Priority | Flag | Classification | Why it matters | Parsed defaults | Sources |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for r in p0_flags + p1_flags:
        sources = ", ".join(r["categories"])
        lines.append(
            f"| {r['priority']} | `{r['name']}` | {r['classification']} | {r['launch_reason']} | {default_summary(flags[r['name']])} | {sources} |"
        )
    lines.append("")
    lines.append("## Registry Coverage")
    lines.append("")
    lines.append("| Registry / surface | Flags currently known there |")
    lines.append("| --- | --- |")
    for name, values in sorted(registries.items()):
        lines.append(f"| {name} | {', '.join(f'`{v}`' for v in sorted(values)) or 'None'} |")
    lines.append("")
    lines.append("## Full Inventory")
    lines.append("")
    lines.append("| Flag | Priority | Classification | Parsed defaults | Example references |")
    lines.append("| --- | --- | --- | --- | --- |")
    for r in rows:
        examples = ", ".join(r["examples"])
        lines.append(
            f"| `{r['name']}` | {r['priority']} | {r['classification']} | {default_summary(flags[r['name']])} | {examples} |"
        )
    lines.append("")
    lines.append("## Immediate Hygiene Actions")
    lines.append("")
    lines.append("1. Pick a canonical registry format and make this script generate the human-readable register from it.")
    lines.append("2. Add every launch-critical flag to the canonical registry with owner, default, launch value, fail mode, and affected routes/jobs.")
    lines.append("3. Keep `ENABLE_GRC_INTEGRATIONS` as the only GRC integration flag name; do not reintroduce the singular alias.")
    lines.append("4. Decide which flags are env-only emergency kill switches versus DB switchboard rollout flags.")
    lines.append("5. Add CI that fails when a code-referenced `ENABLE_*` flag is missing from the canonical registry or environment docs.")
    lines.append("6. Add an admin/health readiness view that reports beta launch flag values.")
    lines.append("")
    lines.append("## Generation")
    lines.append("")
    lines.append("Generated by `scripts/audit_feature_flags.py`. Local `.env` files are intentionally excluded so secrets and machine-specific values do not leak into the audit artifact.")
    lines.append("")

    OUT_MD.write_text("\n".join(lines))


def main() -> None:
    flags, registries = build_inventory()
    write_outputs(flags, registries)
    print(OUT_MD)
    print(OUT_JSON)
    print(f"flags={len(flags)}")


if __name__ == "__main__":
    main()
