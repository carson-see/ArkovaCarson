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
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_MD = ROOT / "docs" / "audits" / "feature-flag-register-2026-05-01.md"
OUT_JSON = ROOT / "docs" / "audits" / "feature-flag-register-2026-05-01.json"

FLAG_RE = re.compile(r"\b(?:VITE_)?(?:ENABLE_[A-Z0-9_]+)\b|\b(?:MAINTENANCE_MODE|USE_MOCKS)\b")

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
    "!docs/audits/feature-flag-register-2026-05-01.*",
    "!scripts/audit_feature_flags.py",
]

SEARCH_PATHS = [
    ".env.example",
    ".env.test.example",
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
    if path == "services/worker/src/config.ts":
        return "worker-config"
    if path == "services/worker/src/middleware/flagRegistry.ts":
        return "worker-registry"
    if path == "services/worker/src/middleware/integrationKillSwitch.ts":
        return "integration-kill-switch"
    if path == "src/lib/switchboard.ts":
        return "frontend-switchboard"
    if path == "src/pages/PlatformControlsPage.tsx":
        return "frontend-admin-ui"
    if path.startswith("supabase/seed") or path.startswith("supabase/migrations"):
        return "db-seed-or-migration"
    if path in {".env.example", ".env.test.example"} or path.endswith(".env.example"):
        return "env-example"
    if path == "docs/reference/ENV.md":
        return "env-doc"
    if path.startswith(".github/") or path.startswith("scripts/deploy"):
        return "deploy-config"
    if path.startswith("services/edge/"):
        return "edge-code"
    if path.startswith("services/worker/"):
        return "worker-code"
    if path.startswith("src/"):
        return "frontend-code"
    if path.startswith("docs/"):
        return "docs"
    return "other"


def load_text(path: str) -> str:
    try:
        return (ROOT / path).read_text(errors="ignore")
    except FileNotFoundError:
        return ""


def parse_simple_defaults(flags: dict[str, Flag]) -> None:
    # .env examples and docs/reference/ENV.md lines like ENABLE_X=false.
    for path, label in [
        (".env.example", ".env.example"),
        (".env.test.example", ".env.test.example"),
        ("docs/reference/ENV.md", "docs/reference/ENV.md"),
    ]:
        text = load_text(path)
        for line in text.splitlines():
            line = line.strip()
            m = re.match(r"^((?:VITE_)?ENABLE_[A-Z0-9_]+|MAINTENANCE_MODE|USE_MOCKS)\s*=\s*([^#\s]+)", line)
            if not m:
                continue
            name, value = m.group(1), m.group(2)
            if name in flags:
                flags[name].defaults[label] = value

    # Frontend switchboard defaults.
    text = load_text("src/lib/switchboard.ts")
    obj = re.search(r"export const FLAGS = \{(?P<body>.*?)\} as const;", text, re.S)
    if obj:
        for name, value in re.findall(r"\b([A-Z0-9_]+):\s*(true|false)", obj.group("body")):
            if name in flags:
                flags[name].defaults["frontend-switchboard"] = value

    # Supabase seed defaults: (id, value, default_value, ...).
    text = load_text("supabase/seed.sql")
    for name, value, default in re.findall(
        r"\('((?:ENABLE_[A-Z0-9_]+|MAINTENANCE_MODE|USE_MOCKS))',\s*(true|false),\s*(true|false)",
        text,
    ):
        if name in flags:
            flags[name].defaults["supabase-seed-value"] = value
            flags[name].defaults["supabase-seed-default"] = default

    # Worker config defaults are documented in comments immediately above each schema field.
    text = load_text("services/worker/src/config.ts")
    pending_comment_flag: str | None = None
    comment_lines: list[str] = []
    in_comment = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("/**"):
            in_comment = True
            comment_lines = [stripped]
            if "*/" in stripped:
                in_comment = False
                matches = FLAG_RE.findall(" ".join(comment_lines))
                pending_comment_flag = matches[-1] if matches else None
            continue
        if in_comment:
            comment_lines.append(stripped)
            if "*/" in stripped:
                in_comment = False
                matches = FLAG_RE.findall(" ".join(comment_lines))
                pending_comment_flag = matches[-1] if matches else None
            continue

        if pending_comment_flag and "z.preprocess" in stripped and ".default(" in stripped:
            default_match = re.search(r"\.default\((true|false)\)", stripped)
            if default_match and pending_comment_flag in flags:
                flags[pending_comment_flag].defaults["worker-config"] = default_match.group(1)
            pending_comment_flag = None


def collect_registry_sets() -> dict[str, set[str]]:
    result: dict[str, set[str]] = {
        "worker_registry": set(),
        "frontend_switchboard": set(),
        "integration_killswitch": set(),
        "worker_config_comments": set(),
        "db_seed": set(),
        "platform_controls": set(),
    }

    for name in FLAG_RE.findall(load_text("services/worker/src/middleware/flagRegistry.ts")):
        result["worker_registry"].add(name if isinstance(name, str) else name[0])
    for name in FLAG_RE.findall(load_text("src/lib/switchboard.ts")):
        result["frontend_switchboard"].add(name if isinstance(name, str) else name[0])
    for name in FLAG_RE.findall(load_text("services/worker/src/middleware/integrationKillSwitch.ts")):
        result["integration_killswitch"].add(name if isinstance(name, str) else name[0])
    for name in FLAG_RE.findall(load_text("services/worker/src/config.ts")):
        if name in IGNORE_MATCHES:
            continue
        result["worker_config_comments"].add(name if isinstance(name, str) else name[0])
    for name in FLAG_RE.findall(load_text("supabase/seed.sql")):
        result["db_seed"].add(name if isinstance(name, str) else name[0])
    for name in FLAG_RE.findall(load_text("src/pages/PlatformControlsPage.tsx")):
        result["platform_controls"].add(name if isinstance(name, str) else name[0])
    return result


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
    if name in registries["frontend_switchboard"] or name in registries["db_seed"]:
        return "P2", "platform-switchboard", "Platform flag; verify owner before changing default."
    return "P3", "unclassified", "Needs owner and registry entry if still active."


def default_summary(flag: Flag) -> str:
    if not flag.defaults:
        return "No parsed default"
    return "; ".join(f"{k}={v}" for k, v in sorted(flag.defaults.items()))


def drift_findings(flags: dict[str, Flag], registries: dict[str, set[str]]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []

    if "ENABLE_GRC_INTEGRATION" in flags and "ENABLE_GRC_INTEGRATIONS" in flags:
        findings.append({
            "priority": "P0",
            "title": "GRC integration flag name drift",
            "evidence": "Router/integration kill switch references ENABLE_GRC_INTEGRATION while config, DB seed, and grcFeatureGate use ENABLE_GRC_INTEGRATIONS.",
            "action": "Pick one canonical flag, migrate code/docs/env, and add an unknown-flag check.",
        })

    for name in sorted(registries["integration_killswitch"]):
        if name not in registries["worker_config_comments"] and name != "ENABLE_GRC_INTEGRATION":
            findings.append({
                "priority": "P0" if name in LAUNCH_CRITICAL else "P1",
                "title": f"{name} is an integration kill switch with no worker config schema entry",
                "evidence": "The route can be disabled by env var, but config.ts does not absorb/log/validate this flag.",
                "action": "Add to canonical registry/config or explicitly document as env-only kill switch with launch value.",
            })

    worker_registry = registries["worker_registry"]
    for name in sorted(LAUNCH_CRITICAL):
        if name in flags and name.startswith("ENABLE_") and name not in worker_registry:
            findings.append({
                "priority": "P0" if LAUNCH_CRITICAL[name][0] == "P0" else "P1",
                "title": f"{name} absent from worker flagRegistry",
                "evidence": "flagRegistry.ts claims to centralize worker feature flags, but this launch-critical flag is not loaded/logged there.",
                "action": "Add to canonical registry or update architecture so operators know this flag is controlled elsewhere.",
            })

    for name, flag in sorted(flags.items()):
        defaults = flag.defaults
        if len(set(defaults.values())) > 1:
            relevant = name in LAUNCH_CRITICAL or name in {
                "ENABLE_AI_EXTRACTION",
                "ENABLE_SEMANTIC_SEARCH",
                "ENABLE_AI_FRAUD",
                "ENABLE_AI_REPORTS",
            }
            priority = LAUNCH_CRITICAL[name][0] if name in LAUNCH_CRITICAL else ("P1" if relevant else "P2")
            findings.append({
                "priority": priority,
                "title": f"{name} has conflicting parsed defaults",
                "evidence": default_summary(flag),
                "action": "Define environment-specific defaults in the canonical register and stop relying on scattered fallback values.",
            })

    for name in [
        "ENABLE_ORG_CREDIT_ENFORCEMENT",
        "ENABLE_DOCUSIGN_WEBHOOK",
        "ENABLE_DRIVE_WEBHOOK",
        "ENABLE_DRIVE_OAUTH",
        "ENABLE_WORKSPACE_RENEWAL",
        "ENABLE_X402_FACILITATOR",
        "ENABLE_MCP_SERVER",
    ]:
        if name in flags and "docs/reference/ENV.md" not in flags[name].files:
            findings.append({
                "priority": "P0" if name in LAUNCH_CRITICAL and LAUNCH_CRITICAL[name][0] == "P0" else "P1",
                "title": f"{name} missing from docs/reference/ENV.md",
                "evidence": f"Referenced in {', '.join(sorted(flags[name].files)[:5])}.",
                "action": "Add to canonical environment docs with default, owner, launch value, and fail mode.",
            })

    return findings


def write_outputs(flags: dict[str, Flag], registries: dict[str, set[str]]) -> None:
    findings = drift_findings(flags, registries)

    data = {
        "generated_at": "2026-05-01",
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
    lines.append("Date: 2026-05-01")
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
