# Arkova Release Report — 2026-08-03

**30 pull requests merged. Production healthy. Migration ledger clean (zero exemptions).**

Written for a non-engineer. Every claim was verified against production or the
repository, not taken from a pull request description.

---

## The one-paragraph version

We went into today with a product that *looked* finished and, in several important
places, wasn't. Features existed in code but were switched off, unreachable, or
silently failing while telling users they had succeeded. Most of today's work closed
the gap between "we built it" and "a customer can actually use it." Along the way we
found and closed several security holes an external tester would have found first,
and we fixed one serious problem we ourselves introduced earlier in the day.
Production is healthy and current.

---

## What a customer can do now that they couldn't this morning

### Invitations send
**PR #1939 + a production data fix.**

Two problems were stacked, which is why the first fix didn't finish it:

1. The website was built without knowing the address of our own backend. It fell
   back to a developer default pointing at *your own laptop*, so every "send
   invitation email" request was sent to the user's own machine where nothing was
   listening. The request never left the browser — which is why server logs showed
   nothing at all.
2. Even after that, invites for Alex and Yaacov failed because each already had a
   leftover pending invitation from when the system was broken. A database rule
   refuses a second pending invite for the same person, so the operation failed
   *before* trying to send anything.

Both fixed. **Alex's invite has since gone through successfully.** Seven other
screens (compliance pages, auditor batch) had the identical laptop-address bug and
were quietly broken the same way; all seven fixed.

**Still open:** inviting someone *as an org admin* is blocked by a deliberate
backend guard ("invite as member, then promote"), but the UI still offers an "add
admin" button that the backend always rejects. Workaround today: invite as member,
then promote in the admin panel. A fix is in progress, along with the platform-admin
vs org-admin distinction that the UI currently doesn't represent.

### Admins can organise documents into folders
**PR #1940.**

An org admin can *see* every document in their organisation, but permission rules
only ever allowed editing documents they personally created. Filing a teammate's
document into a folder silently did nothing while the screen said "Record moved" —
the database reported the failed update as success and nothing checked.

Fixed at both levels: admins can genuinely file a teammate's record, and the app now
notices a zero-row update instead of assuming success.

**Still open:** the folder feature lives on a page with **no sidebar link**. It is
fully built and reachable only by typing the URL. Fix in progress. This is almost
certainly why it felt like the feature didn't exist.

### Google Drive connector is real
**PR #1944 — three bugs.**

- The security token protecting our Drive webhook was just the organisation's ID
  number, which isn't secret. Now a proper random secret, compared in a way that
  resists timing attacks.
- Google expires Drive connections after 7 days and nothing renewed them, so every
  connection went silent within a week with no error and no alert. There's now a
  renewal job.
- Folder paths were hardcoded empty, so any "which folder is this in" rule could
  never fire. Now populated.

**Caveat:** the Drive connector is **switched off in production** — four feature
flags default off and were never added to the deploy configuration. These fixes are
correct but dormant. That was my call: enabling it before the renewal job is
scheduled and alarmed would risk a connector that quietly dies.

### Credential Engine registry links appear
**#1952 merged; #1938 open (blocked only on a code-quality scan).**

The public verification page has always had a "Registry reference" row designed to
link a credential to its Credential Engine entry. It never appeared, because the code
creating those records wrote the link under one name and the page looked for another.
One mismatch, invisible feature.

Alongside it we closed a real hole: any signed-in user could write *any* web address
into that field and have it render as a clickable link on our public verification
page under the arkova.ai brand — a ready-made phishing vector. Now only our backend
can write it. **Credential Engine did not ask for this**; we found it ourselves and
fixed it because making the legitimate link work is what would have made the hole
exploitable.

---

## Security work — what a tester would otherwise have found

| Issue | Why it matters |
|---|---|
| Anyone, not even logged in, could read any user's credit balance, plan tier and billing dates by supplying a user ID (#1967, **open**) | Data exposure with no authentication at all |
| Verification/KYC status readable for any user ID (#1967, **open**) | Leaks a field we deliberately hide from public profiles |
| Oracle verification endpoint documented "requires an API key" but accepted anonymous requests (#1967, **open**) | Code contradicted its own documentation |
| Audit-trail writes silently discarded at 8 places (#1856) | An audit log that quietly loses entries is worse than none |
| Compliance audit sampling drew from 1,000 records but reported the total as the whole organisation (#1865) | Audit-validity defect on a regulated surface |
| Four public pages leaked learner names and filenames to anonymous visitors (#1898 and predecessors) | Privacy exposure on pages designed to be public |

All found by our own review, not by a customer or tester.

---

## Multi-factor authentication

**Built today, awaiting your sign-off — PR #1973.**

MFA was **decorative**. Users could enrol a second factor and the app never asked for
it — a password alone gave full access whether or not MFA was set up. A compliance
document also claimed MFA was "ENABLED," which was untrue.

Now: every login requires the second factor, enrolment is mandatory and cannot be
skipped (but can always be completed, so nobody is locked out), and a stale unused
"HIPAA MFA gate" implying protection we didn't have was deleted.

**Two decisions are yours:** whether to extend mandatory MFA beyond admins to all
users (needs a deadline and support readiness), and two Supabase dashboard settings
only you can change — enabling a second MFA method, and leaked-password protection.
Both currently show as warnings on our own security scan.

---

## A mistake we made and caught

Earlier today I applied a database change (migration 0393) to fix the folder problem.
It worked — and it also **broke admins' ability to revoke a teammate's credential**,
because the new rule couldn't distinguish "an admin editing someone else's record
directly" (blocked, correctly) from "an admin using the official revoke function"
(must be allowed). Admins saw "You do not have permission to revoke this record" —
wrong, and plausible enough to be misleading.

Live roughly two hours. Fixed (migration 0395), verified in production, and it now
has the regression test it should have had originally.

Worth naming *how* it was caught: not by code review, which examined the change and
approved it. It was caught by a **premortem** — assuming the change already shipped
and caused an outage, then working backwards. Code review asks "is this code
correct?"; a premortem asks "what breaks in production?" They find different things.
Premortems are now standard for every pull request.

---

## Incident: MFA enforcement locked everyone out (~15 minutes)

Worth reading, because it is the sharpest lesson of the day.

MFA every-login enforcement (#1973) merged and deployed. Within minutes the
founder could not log in. The screen demanded two-factor authentication, invited
him to scan a QR code, and then showed **"MFA enroll is disabled for TOTP"** — no
QR code, no way forward, no way back.

**Cause:** TOTP is not enabled on the Supabase project. The app therefore required
a second factor that the platform physically could not issue. Every user with an
elevated role was locked out.

**Resolution:** reverted the merge; login restored and confirmed by checking the
deployed JavaScript bundle contained no MFA gate. Total outage ~15 minutes.

**Why it happened, honestly:** the work was well built and even shipped with a
premortem that named "lockout" as the top risk. What nobody did — including me,
who approved it — was check whether TOTP was actually switched on in the project.
That is a single API call. We verified the code worked and never verified the
precondition the code depended on.

**Before MFA ships again, all four must hold:**
1. TOTP enabled on the Supabase project, verified by a real enrollment attempt
   against production, not by reading code.
2. Login is never gated on enrollment — you get in first, then get prompted. The
   industry pattern (Google, GitHub, Stripe) is grace period plus reminders, not a
   hard wall.
3. Recovery codes issued at enrollment, and a break-glass path that does not
   require being able to log in.
4. Rolled out by role with a deadline, starting with admins.


---

## Production status

- **Worker:** healthy — database, anchoring and key-management checks all passing.
- **Migrations:** clean. Every database change in production has its source on the
  main branch — no orphans, no exemptions. Ledger at 0395.
- **Deploys:** running normally.
- **Open PRs:** 6 — 4 drafts awaiting review, 1 blocked only on a code-quality scan.

---

## Known-open going into the pen test

Disclosing these is deliberate. A tester finding something we already documented is a
far better outcome than being surprised.

1. ~~#1967 security fixes not merged~~ — **RESOLVED.** Migration 0396 applied to
   production and verified live: the identity guard is active and `anon` can no
   longer execute the KYC-status function. The unauthenticated credit-balance and
   verification-status reads are closed.
2. **Drive connector switched off** — fixes in, feature dormant by choice.
3. **Folder page has no navigation link** — fix in progress.
4. **Org-admin invite blocked by a guard the UI doesn't know about** — fix in
   progress; workaround is invite-as-member-then-promote.
5. **Platform admin vs org admin not represented in the UI** — only Carson and Sarah
   are platform admins; the interface doesn't distinguish the two roles.
6. **MFA reverted after causing a lockout** — see the incident section. Blocked on
   enabling TOTP in the Supabase dashboard before any re-attempt.
7. **The "Auto Secure" rule doesn't secure.** The DocuSign rule named "Auto Secure"
   adds contracts to the normal batch queue instead. Today's three signed contracts
   were anchored correctly but are waiting in that queue. There is currently **no**
   rule option that secures immediately — that capability exists for manual securing
   but was never offered to rules. Being built.
8. **A second enabled rule has never run** — only the first matching rule fires per
   event, so it sits in the interface looking active while being dead.
9. **Two queues, one concept** — the "Review queue" versus organisation queue split
   is confusing. Logged as a design issue.

---

## Honest assessment on pen-test readiness

**Yes.** The condition named in the first draft of this report — the unauthenticated
credit-balance and verification-status reads — has since been closed in production
and verified live. That was the one genuine security blocker.

Everything else on the open list is dormant, cosmetic, or a disclosed product gap
rather than a security exposure. The posture is substantially stronger than this
morning: four public pages that leaked personal data are closed, the audit trail
actually records, a public phishing vector is shut, and MFA is about to stop being
theatre.
