# AGENTS.md

This repo's authoritative operating rules live in `CLAUDE.md`.

Before acting in any Arkova session:

1. Read the current `CLAUDE.md`.
2. Read the nearest relevant `agents.md` files for every directory you plan to touch.
3. After reading `CLAUDE.md`, run `scripts/agent/ack-claude-bootstrap.sh` from the repo root before any staging/prod-sensitive Bash command.
4. Do not mutate production, Jira, Confluence, PR evidence docs, or audit evidence unless Carson explicitly approves that exact operation.

The Claude Code PreToolUse hook in `.claude/hooks/check-claude-bootstrap.sh` enforces the acknowledgement for staging/prod-sensitive Bash commands. Other agents must treat this file as the bootstrap pointer and follow the same rule manually if their runtime does not execute Claude hooks.

---

## Local commands that do NOT match CI

Each of these cost a real agent a red CI run on 2026-08-01. They are cheap to
avoid once you know.

### `npm run typecheck` is NOT the check CI runs

`npm run typecheck` uses the **root** `tsconfig.json`. CI's `TypeCheck & Lint`
job (and the Vercel build) runs:

```
npx tsc -p tsconfig.build.json --noEmit
```

`tsconfig.build.json` targets an **older lib**, so modern built-ins that the
root config accepts fail the build check. Confirmed misses, both of which
passed locally and failed CI in the same session:

| Used | Error |
|---|---|
| `Array.prototype.at` (`calls.at(-1)`) | `TS2550: Property 'at' does not exist on type 'any[][]'` |
| `Object.hasOwn` | `TS2550: Property 'hasOwn' does not exist on type 'ObjectConstructor'` |

Use index access (`arr[arr.length - 1]`) and a `Map` (or
`Object.prototype.hasOwnProperty.call`) instead. **Before pushing any
TypeScript change, run the build config explicitly** — `npm run typecheck`
alone is not sufficient evidence.

### The shared preview server serves the PARENT checkout, not your worktree

`preview_start` / `npm run dev` from a `.claude/worktrees/*` worktree resolves
Vite's root to the **parent repo**, so the browser serves the parent checkout's
code and your edits appear to have no effect. You can waste a long time
"debugging" a change that was never loaded.

Symptom: the page behaves as though your fix is absent, and
`await import('/src/lib/<file>.ts')` in the browser console shows your new
exports missing. `preview_logs` will also show HMR reloads for **sibling**
worktree paths.

Fix — bind Vite to your own worktree on a private port:

```
npx vite --port 5199 --strictPort --host 127.0.0.1     # from your worktree
curl -s http://127.0.0.1:5199/src/lib/<file>.ts | grep <yourNewExport>
```

Then point the browser at `http://127.0.0.1:5199`. Verify the served file
actually contains your change before concluding anything about behaviour.

### Full-suite runs on the dev Mac are flaky under contention

`npx vitest run src/` can report 14–17 failures in **different, unrelated**
files on consecutive runs when something else (a dev server, another agent's
suite) is competing for workers. A failure set that changes between runs is
contention, not a regression. Re-run with `--maxWorkers=2` before believing it,
and stop any background dev server first.
