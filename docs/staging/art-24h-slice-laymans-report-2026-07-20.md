# The Last 24 Hours at Arkova — Plain-English Report (2026-07-20)

*What each team worked on, and why it matters for launch. No jargon.*

Arkova's engineering is organized into three "lanes," each a small team with a focus, plus a release team that keeps everything shipping safely. Over this 24-hour block, every team stayed in "safe mode" — we intentionally did **not** push anything into the live product, because a batch of earlier work is still in its final safety-testing period and we didn't want to disturb it. Instead, each team packaged its work up, got it reviewed, and parked it — ready to go the moment the coast is clear.

Here's what each did and why it matters.

---

## Lane 1 — Trust & Chain ("is the proof real?")
**What they built:** an independent "proof-checker" tool. Arkova's whole promise is that a document is permanently provable on the Bitcoin network. This tool re-checks that promise from scratch, using nothing but standard math — it takes a document's fingerprint, follows it to the public Bitcoin record, and confirms it's really there. They used it to independently confirm four of our partner's live proofs, end to end.

**Why it moves us forward:** it's the evidence we can hand an auditor or a partner and say "don't trust us, check it yourself." It's the backbone of proving to our first paying partner (HakiChain) that their documents are genuinely secured.

**What they caught:** while checking the partner's account, they found a gap (see the HakiChain note below) — the kind of thing you want found weeks early, not on invoice day.

## Lane 2 — Product & Growth ("does the business plumbing work?")
**What they built:**
- Fixed the **treasury dashboard** so its charts (network fees, prices) actually load — a small setting was blocking them.
- Built a **"dead-man's switch"** for our scheduled background jobs. A few weeks ago some critical jobs quietly turned themselves off and nobody noticed for a long time. This makes that impossible — if a job silently stops, we get alerted, and we can see who or what turned it off.
- Improved our **error-monitoring** so alerts are correctly labeled by which part of the system they came from.
- Started the **scaffolding for onboarding partner accounts** (parked and inert for now — no live effect yet).

**Why it moves us forward:** these are the "the lights work, the alarms work, the money dashboard works" items. Unglamorous, but they're exactly what has to be solid before real customers and real invoices.

## Lane 3 — Credential Network ("can we read and honestly describe documents?")
**What they built:**
- **Removed the last traces of an old "fraud score" feature** from every screen — including public pages — because we're not confident enough in it to show it. Leaving it up would have been an honesty problem at launch.
- Taught our importer to **read the Credential Engine's official document format** (their own records currently come in as gibberish) — this was a blocker for an important partner demo.
- Made the product **gracefully handle phone-photo and scanned image formats** instead of rejecting them, which matters a lot for real-world documents in the Kenya pilot.
- Continued **cleaning up wording** across the app for consistency and to avoid over-claiming.

**Why it moves us forward:** it makes Arkova both more honest (no shaky claims) and more useful with the messy real-world documents partners will actually upload.

## Release / Train team ("ship it safely, prove nothing was faked")
**What they built:**
- An automated **guardrail that prevents "fake" safety tests.** Last week a 48-hour safety test turned out to have tested nothing (the system under test wasn't actually running). This guard makes that class of mistake un-repeatable — a test can't "count" unless it proves it really exercised the new code.
- A full **evidence trail** of the window's decisions, and brought in five specialist reviewers (database, Bitcoin, AI, architecture, performance) to double-check the riskiest work.

**Why it moves us forward:** it protects the integrity of everything we ship. The reviewers also caught two real mistakes before they went live — including one on a sensitive Bitcoin-durability change that would otherwise have shipped without a proper re-test.

---

## The one thing that needs a business decision: HakiChain's anchors
Our first pilot partner is supposed to have **15 "anchors" (document-securing credits) available to use**. We checked the live system:
- Their account **is** set up with an allowance of 15 — that part is correct.
- **But** their usable balance is currently **zero**, their billing cycle expired on July 1 and never renewed, and the account is still flagged as a **test** account. Only 4 anchors have actually been created.

In plain terms: **the promise of 15 is on the books, but there's no funded balance behind the other 11**, so right now they can't actually use them once we turn on billing enforcement. Two verification sessions confirmed this independently. This needs a quick founder/finance decision before **August 9** (the first-invoice date): top up their balance and renew the cycle so the 15 are really usable, and make sure we fund them **before** switching on the billing rules — otherwise they'd be stuck at 4.

---

## Bottom line
Nothing shipped to the live product in these 24 hours **on purpose** — but every team moved its piece to the goal line, got it reviewed, and left it safely parked. The window also surfaced one genuine launch-blocker (the partner's usable anchor balance) early enough to fix calmly. We're in good shape: the safety-testing batch finishes over the next day, and this parked work goes out right behind it.
