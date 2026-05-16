# agents.md — services/worker/src/ai/eval/__tests__/

_Last updated: 2026-05-16_

## What This Folder Contains

Tests for eval subsystems that live in their own files rather than co-located.

| File | Purpose |
|------|---------|
| `intelligence-eval-dataset.test.ts` | Validates intelligence eval dataset entries are well-formed |
| `nce-phase1.test.ts` | NCE Phase 1 infrastructure and data quality validation tests |

## Do / Don't Rules

- **DO NOT** call real AI APIs — these tests validate data structures and pipeline logic
