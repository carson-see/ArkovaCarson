#!/usr/bin/env python3
"""Admit PyPI publication only for a pushed tag matching this checkout's version."""

import os
import sys
import tomllib
from pathlib import Path


def main() -> int:
    manifest = Path(__file__).resolve().parents[2] / "packages/arkova-py/pyproject.toml"
    try:
        with manifest.open("rb") as source:
            version = tomllib.load(source)["project"]["version"]
        output = os.environ["GITHUB_OUTPUT"]
        if not isinstance(version, str) or not version.strip() or not output:
            raise ValueError("incomplete publication identity")
        event = os.environ.get("GITHUB_EVENT_NAME")
        ref = os.environ.get("GITHUB_REF")
        if event == "workflow_dispatch":
            decision = "false"
        elif event == "push" and ref == f"refs/tags/arkova-py-v{version}":
            decision = "true"
        else:
            raise ValueError("event, tag, or manifest version mismatch")
        with open(output, "a", encoding="utf-8") as target:
            target.write(f"publish={decision}\n")
        return 0
    except (OSError, KeyError, TypeError, ValueError):
        print("Python SDK publication admission denied.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
