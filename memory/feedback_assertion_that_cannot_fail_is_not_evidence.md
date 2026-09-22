# A probe that cannot fail is not evidence — and neither is a detail blob written up as though it were

Three instances in one day, 2026-09-22, in three different places. The shape is
always the same: something is *observed* and then *reported as though it were
enforced*, and the gap is invisible in the writeup.

## Why

Soak evidence is the only thing standing between a change and production. Its
value is entirely in what it would have caught. An assertion that passes no
matter what the candidate does costs four hours of rig time and buys nothing,
while reading — in the PR body, to a reviewer, to an auditor — exactly like an
assertion that would have caught a regression.

The three instances:

1. **Drive probes R5/R6** asserted only HTTP 200. `DRIVE_PROBE_INTEGRATION_ID`
   was echoed into a detail blob that never touched `ok`. Over a 4 h window they
   evidenced "the webhook returns 200" and nothing about the lease or cursor
   correctness they existed to demonstrate.
2. **The PR body built on them.** #3054 described R5 as showing "the runner
   reaches the lease and fails on `no_encrypted_tokens` inside it". That was a
   human reading a detail blob, written as though the window had enforced it for
   four hours. True as an observation; not evidence.
3. **`check-prod-migration-apply.sh`** silences its git plumbing with
   `2>/dev/null` and falls through to DENY, so an unresolvable `origin/main`
   produces a verdict byte-identical to a real policy denial. The inverse of the
   same defect: a check that fails for a reason it does not report.

## How to apply

- **Red-proof every assertion before you trust it.** Feed it synthetic input
  that SHOULD fail and watch it fail. A guard nobody has seen go red is a guard
  nobody has tested.
- **Red-proof with a *different* wrong answer, not just a missing one.** An
  assertion that only fails on absence is half an assertion. The realistic
  near-miss is the neighbouring value: a different error code from the same
  class, a lease row in a different state, the right shape with the wrong id.
- **Pin the stable discriminator, not a human-readable string.** Assert the
  `.code` the production code itself branches on. A message-string assertion
  reds a window when someone rewords an error — a false failure is as expensive
  as a false pass.
- **Write evidence in three separate categories and never blur them:**
  *enforced every cycle* / *observed once* / *not exercised, by design*. If a
  fact belongs in the second or third, say so in those words. The weaker true
  sentence beats the stronger unsupported one, every time.
- **When a check fails, make it report WHY.** Distinguish "the thing is absent"
  from "I could not look". Swallowing the second into the first teaches
  operators that the verdict means "retry", which is how a real denial gets
  waved through.

## The same shape in CONFIG and in VIEWS, not just in assertions

Three more mechanisms hit on 2026-09-22 after this rule was written. All six
instances that day share one property: **a green signal that was compatible
with the thing underneath being dead.**

4. **A duplicate YAML key silently dropped a flag.** An edit added a second
   `env:` key to a workflow step that already had one after its `run:`. YAML
   keeps the last; the new variable vanished. The diff looked correct, a plain
   `yaml.safe_load` parsed fine, and the flag simply never reached the process.
   It also produced a workflow **startup failure — a run with `conclusion:
   failure` and ZERO jobs** — so the entire required matrix never appeared.
   *Detect it:* load the file with a loader that **raises on duplicate keys**,
   then read the value back out of the parsed structure. A normal parse is
   blind to this by design.

5. **A required check that has not been created yet is not a passing check.**
   `TypeCheck & Lint` → `Tests` → `E2E Tests` is a dependency chain, so the
   later jobs do not exist as check rows until the earlier ones finish.
   Reading "no `E2E Tests` row" as "E2E does not apply to this PR" was wrong
   twice in one day. *Detect it:* judge a matrix by **row count** against a
   known-good PR (35-45 here), and name the specific checks you require as
   present-and-passing.

6. **A filtered "outstanding items" view converts absence into success.** A
   monitor that excludes expected failures and then reports "nothing left"
   says the same thing whether every check passed or none ran. Two different
   sessions shipped this bug within an hour of each other, and one of them was
   the session that had just written this rule.

The generalisation worth carrying: **before trusting green, ask what this
signal would look like if the mechanism were entirely absent.** If the answer
is "the same", it is not evidence — whether it is a probe, a gate, a config
value, a check row, or your own dashboard.

## Related

- [[feedback_gates_before_pin]] — the other half: run every required check, in
  full, on the exact head, before a window pins it.
- [[project_hollow_200_statement_timeout_swallow]] — the same shape in
  production code rather than in evidence: `if (error || empty)` hid a query
  kill for 1,108 runs.
