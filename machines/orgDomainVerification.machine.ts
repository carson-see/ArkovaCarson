/**
 * SCRUM-5285 — self-serve organization domain verification.
 *
 * Models `services/worker/src/api/v1/orgVerification.ts`'s two domain routes as
 * the pair of read-then-write protocols they actually are:
 *
 *   POST /org/verify-domain  — SELECT (domain) → UPDATE (issue the token)
 *   POST /org/confirm-domain — SELECT (domain, token) → UPDATE (grant)
 *
 * and interleaves the adversarial action between them: the org admin PATCHing
 * `organizations.domain` directly. That is not hypothetical — RLS policy
 * `organizations_update_admin` grants an org admin UPDATE on every column of
 * their own row, and the SAME person drives both verification requests.
 *
 * Why the property is worth a model. `domain_verified` is not a badge:
 * migration `0470`'s `auto_associate_profile_to_org_by_email_domain` auto-joins
 * every confirmed signup whose email domain matches an org with
 * `domain_verified IS TRUE`, and `verification_status = 'VERIFIED'` gates
 * credential issuance and every connector OAuth. A grant for a domain nobody
 * proved captures accounts.
 *
 * ── WHAT THE MODEL FOUND ────────────────────────────────────────────────────
 * The compare-and-swap that closes the SELECT→UPDATE window inside each handler
 * is NOT sufficient, and TLC says so in four steps:
 *
 *   issueToken(domain=A)         → pendingTokenDomain = A, code mailed to admin@A
 *   adminChangesDomain(A → B)    → row now says B; token untouched
 *   captureToken                 → reads domain B, token T (both current)
 *   assertVerification           → CAS predicate matches that very row → B verified
 *
 * Every predicate the CAS can express is satisfied: the row's domain at write
 * time equals the domain read microseconds earlier, and the token matches. The
 * window that is open is between the two REQUESTS, and no amount of same-row
 * freshness checking closes it, because nothing on the row records which domain
 * the pending token was issued FOR.
 *
 * `pendingTokenDomain` is the variable that makes it expressible — the model's
 * whole reason for existing, and the direct analogue of the lesson in this
 * folder's 2026-09-01 entry: when the code does capture → await → act, the
 * model must carry the captured value or the proof answers an easier question.
 *
 * The fix that makes the invariant GREEN carries the issuance domain inside the
 * token itself (`code:token:binding`, binding = truncated sha256 of the domain),
 * so `confirm-domain` can recompute it from the domain it is about to grant.
 * No migration, no new column.
 *
 * ── WHAT IS DELIBERATELY *NOT* MODELED ──────────────────────────────────────
 * • **A trigger that demotes `domain_verified` when `domain` changes DOES NOT
 *   EXIST** in `supabase/migrations/` — checked file by file. `adminChangesDomain`
 *   therefore moves `domain` and touches NOTHING ELSE, which is what a bare
 *   PostgREST PATCH does today. Modeling a demote-and-clear would be modeling a
 *   trigger this repo does not ship, and it would also CONCEAL the finding
 *   above: clearing the token on every domain change would make the
 *   issue→confirm window unreachable and the binding look like dead code. If
 *   such a trigger ever lands, it is defence in depth on top of this, not a
 *   replacement for it.
 * • **A post-grant domain change is not treated as a violation.** After a
 *   legitimate grant the admin can still PATCH `domain`, leaving
 *   `domain_verified = true` beside a domain nobody proved. That is a real
 *   standing gap and the one thing the demoting trigger above would fix — but
 *   it is a DIFFERENT defect from this TOCTOU, unreachable by application code,
 *   and out of scope for SCRUM-5285. The invariant is therefore written over
 *   two SNAPSHOTS taken at grant time (`verifiedForDomain`, `provenDomain`)
 *   rather than over the live `domain`, so it states exactly the property the
 *   handler is responsible for and nothing it cannot deliver.
 * • The null-domain refusal (400) is a single-statement precondition on one
 *   handler — no interleaving makes it true or false, so a model checker can
 *   only hand the guard back. `orgVerification.test.ts` pins it instead. Domain
 *   ranges over {A, B} here for the same reason.
 * • Code expiry, the 6-digit code's own value, EIN state, the
 *   `verification_status = 'VERIFIED'` upgrade, ORG_ADMIN authorization and
 *   email delivery are all out of scope: none of them is cross-request state.
 *
 * One domain element = one organization. There is no cross-org interaction in
 * this protocol; the `nightly` tier runs two anyway as a negative control on
 * that claim.
 *
 * ── CERTIFICATE ─────────────────────────────────────────────────────────────
 * `machineSha256 a8f14486ef8fdf8eec44964f94a4372a2415ddda8111237479e1de6f06ea7bfd`
 *
 * | tier | proofPassed | equivalent | generated / distinct | depth | deadlock |
 * |---|---|---|---|---|---|
 * | pr (1 org)      | true | true (234/234 states) | 687 / 234    | 14 | checked |
 * | nightly (2 orgs)| true | n/a                   | — / 54,756   | 25 | checked |
 *
 * Deadlock is CHECKED, not waived: `adminChangesDomainToA` / `…ToB` are always
 * enabled, so there is no terminal state to argue about.
 *
 * **Mutation-tested, not merely asserted.** Two independent negative controls,
 * each producing a DIFFERENT counterexample, which is the point — they are not
 * two spellings of one guard:
 *
 *   1. Delete `eq(capturedDomain, domain)` from `grantPredicate` (the domain
 *      CAS): `verifiedImpliesVerifiedForTheDomainProven` violated at depth 6 —
 *      captureToken(A) → adminChangesDomainToB → assertVerification, giving
 *      `verifiedForDomain = B` against `provenDomain = A`. That is SCRUM-5285's
 *      reported TOCTOU, reproduced verbatim.
 *   2. Delete `eq(capturedBinding, capturedDomain)` (the token→domain binding):
 *      violated at depth 7 — issueToken while the domain is B, admin moves it
 *      back to A, confirm reads a fully self-consistent row (domain A, token
 *      K2, CAS satisfied on both halves) and grants A on a code mailed to
 *      admin@B. Only the binding can see it.
 *
 * Restoring either conjunct returns `proofPassed: true`. Picked up by
 * `npm run verify:machines` / the `tla-verify` CI job automatically — the
 * script globs `machines/*.machine.ts`, so no workflow edit was needed.
 *
 * Documentation-only, like `subOrgListingConsent`: no `runtimeAdapter`. These
 * columns live on `organizations`, a table this machine does not own.
 */
import {
  defineMachine,
  enumType,
  boolType,
  eq,
  and,
  or,
  not,
  lit,
  param,
  index,
  forall,
  mapVar,
  setMap,
  ids,
  variable,
} from "tla-precheck";

/** The organization's CURRENT `organizations.domain`. */
const domain = variable("domain");
/** `organizations.domain_verified`. */
const verified = variable("verified");
/** Snapshot: the domain the row carried when the grant landed on it. */
const verifiedForDomain = variable("verifiedForDomain");
/** Snapshot: the domain the consumed code was actually mailed to. */
const provenDomain = variable("provenDomain");
/** Identity of the pending `domain_verification_token`; NONE when absent. */
const tokenId = variable("tokenId");
/** The domain the pending token was issued FOR. Nothing in the schema holds
 *  this today — carrying it is what makes the cross-request bug expressible. */
const pendingTokenDomain = variable("pendingTokenDomain");
/** verify-domain's in-flight SELECT: the domain it read. */
const startCapturedDomain = variable("startCapturedDomain");
/** confirm-domain's in-flight SELECT: the domain it read. */
const capturedDomain = variable("capturedDomain");
/** confirm-domain's in-flight SELECT: the token it read. */
const capturedTokenId = variable("capturedTokenId");
/** confirm-domain's in-flight SELECT: the issuance domain carried by that
 *  token — i.e. the `binding` segment, which travels WITH the token. */
const capturedBinding = variable("capturedBinding");

const DOMAINS = enumType("A", "B");
const OPT_DOMAIN = enumType("NONE", "A", "B");
const TOKENS = enumType("NONE", "K1", "K2");

/** confirm-domain has read the row and not yet resolved. */
const confirmInFlight = (o: ReturnType<typeof param>) =>
  not(eq(index(capturedTokenId, o), lit("NONE")));

/**
 * Everything `confirm-domain`'s write is conditioned on:
 *   - the token CAS   (`.eq('domain_verification_token', …)`)
 *   - the domain CAS  (`.eq('domain', …)`)
 *   - the binding check (the token was issued for the domain being granted)
 */
const grantPredicate = (o: ReturnType<typeof param>) =>
  and(
    eq(index(capturedTokenId, o), index(tokenId, o)),
    eq(index(capturedDomain, o), index(domain, o)),
    eq(index(capturedBinding, o), index(capturedDomain, o)),
  );

const clearConfirmCapture = (o: ReturnType<typeof param>) => [
  setMap("capturedTokenId", o, lit("NONE")),
  setMap("capturedDomain", o, lit("NONE")),
  setMap("capturedBinding", o, lit("NONE")),
];

export const orgDomainVerificationMachine = defineMachine({
  version: 2,
  moduleName: "OrgDomainVerification",
  variables: {
    domain: mapVar("Orgs", DOMAINS, lit("A")),
    verified: mapVar("Orgs", boolType(), lit(false)),
    verifiedForDomain: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
    provenDomain: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
    tokenId: mapVar("Orgs", TOKENS, lit("NONE")),
    pendingTokenDomain: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
    startCapturedDomain: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
    capturedDomain: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
    capturedTokenId: mapVar("Orgs", TOKENS, lit("NONE")),
    capturedBinding: mapVar("Orgs", OPT_DOMAIN, lit("NONE")),
  },
  actions: {
    // ─── The adversary: an ordinary PATCH on organizations.domain ───────────
    // Always enabled, schedulable between any two statements, and touches
    // domain ONLY — see the header on why it does not demote or clear.
    adminChangesDomainToA: {
      params: { o: "Orgs" },
      guard: not(eq(index(domain, param("o")), lit("A"))),
      updates: [setMap("domain", param("o"), lit("A"))],
    },
    adminChangesDomainToB: {
      params: { o: "Orgs" },
      guard: not(eq(index(domain, param("o")), lit("B"))),
      updates: [setMap("domain", param("o"), lit("B"))],
    },

    // ─── POST /org/verify-domain ────────────────────────────────────────────
    /** The SELECT: reads `domain, domain_verified`. */
    captureDomainForIssue: {
      params: { o: "Orgs" },
      guard: and(
        not(index(verified, param("o"))),
        eq(index(startCapturedDomain, param("o")), lit("NONE")),
      ),
      updates: [
        setMap("startCapturedDomain", param("o"), index(domain, param("o"))),
      ],
    },
    /**
     * The token UPDATE, CAS-guarded on the domain read above AND on the grant
     * not having landed underneath this request (`.not('domain_verified',
     * 'is', true)`). TLC insisted on that second conjunct: without it,
     * `captureDomainForIssue` → grant → `issueToken` plants a fresh token on an
     * already-verified row in eight steps.
     *
     * K1/K2 are two
     * spellings of the same action; two ids exist so a ROTATION is
     * distinguishable from no rotation at all — without that, the token CAS in
     * `assertVerification` would be trivially satisfiable and the model would
     * be proving something weaker than the code does.
     */
    issueTokenK1: {
      params: { o: "Orgs" },
      guard: and(
        not(eq(index(startCapturedDomain, param("o")), lit("NONE"))),
        eq(index(startCapturedDomain, param("o")), index(domain, param("o"))),
        not(eq(index(tokenId, param("o")), lit("K1"))),
        not(index(verified, param("o"))),
      ),
      updates: [
        setMap("tokenId", param("o"), lit("K1")),
        // The binding: this token is a proof obligation about THIS domain.
        setMap("pendingTokenDomain", param("o"), index(domain, param("o"))),
        setMap("startCapturedDomain", param("o"), lit("NONE")),
      ],
    },
    issueTokenK2: {
      params: { o: "Orgs" },
      guard: and(
        not(eq(index(startCapturedDomain, param("o")), lit("NONE"))),
        eq(index(startCapturedDomain, param("o")), index(domain, param("o"))),
        not(eq(index(tokenId, param("o")), lit("K2"))),
        not(index(verified, param("o"))),
      ),
      updates: [
        setMap("tokenId", param("o"), lit("K2")),
        setMap("pendingTokenDomain", param("o"), index(domain, param("o"))),
        setMap("startCapturedDomain", param("o"), lit("NONE")),
      ],
    },
    /**
     * Zero affected rows → 409 `verification_superseded`. No code is issued.
     * Covers BOTH ways the predicate can miss — a moved domain and a grant that
     * landed first — so an in-flight start always resolves.
     */
    abortSupersededIssue: {
      params: { o: "Orgs" },
      guard: and(
        not(eq(index(startCapturedDomain, param("o")), lit("NONE"))),
        or(
          not(eq(index(startCapturedDomain, param("o")), index(domain, param("o")))),
          index(verified, param("o")),
        ),
      ),
      updates: [setMap("startCapturedDomain", param("o"), lit("NONE"))],
    },

    // ─── POST /org/confirm-domain ───────────────────────────────────────────
    /**
     * The SELECT: reads `domain` and the token IN THE SAME STATEMENT, which is
     * why `capturedDomain` and `capturedBinding` are both set here. The binding
     * is not a separate read — it travels inside the token string.
     */
    captureToken: {
      params: { o: "Orgs" },
      guard: and(
        not(index(verified, param("o"))),
        not(eq(index(tokenId, param("o")), lit("NONE"))),
        eq(index(capturedTokenId, param("o")), lit("NONE")),
      ),
      updates: [
        setMap("capturedDomain", param("o"), index(domain, param("o"))),
        setMap("capturedTokenId", param("o"), index(tokenId, param("o"))),
        setMap("capturedBinding", param("o"), index(pendingTokenDomain, param("o"))),
      ],
    },
    /**
     * The grant. Modeled as a GUARD rather than a check-then-act pair because
     * in the real code every conjunct is evaluated by Postgres in the SAME
     * statement that performs the write (the CAS halves as WHERE predicates,
     * the binding as a pure function of the row the statement is granting).
     * A two-action model here would be a FALSE positive.
     *
     * `verifiedForDomain` takes the LIVE domain, not the captured one: the flag
     * lands on whatever that row says now. `provenDomain` takes the binding:
     * the domain the code was actually mailed to. The invariant is that those
     * two are the same thing.
     */
    assertVerification: {
      params: { o: "Orgs" },
      guard: and(confirmInFlight(param("o")), grantPredicate(param("o"))),
      updates: [
        setMap("verified", param("o"), lit(true)),
        setMap("verifiedForDomain", param("o"), index(domain, param("o"))),
        setMap("provenDomain", param("o"), index(capturedBinding, param("o"))),
        setMap("tokenId", param("o"), lit("NONE")),
        setMap("pendingTokenDomain", param("o"), lit("NONE")),
        ...clearConfirmCapture(param("o")),
      ],
    },
    /** 409 `verification_superseded`: nothing granted, no audit row, restart. */
    abortSupersededAssert: {
      params: { o: "Orgs" },
      guard: and(
        confirmInFlight(param("o")),
        not(grantPredicate(param("o"))),
      ),
      updates: clearConfirmCapture(param("o")),
    },
  },
  invariants: {
    verifiedImpliesVerifiedForTheDomainProven: {
      description:
        "Whenever domain_verified is true, the domain the grant landed on is the SAME domain the consumed code was mailed to — never a domain that replaced it between issuance and confirmation",
      formula: forall(
        "Orgs",
        "o",
        or(
          not(index(verified, param("o"))),
          eq(index(verifiedForDomain, param("o")), index(provenDomain, param("o"))),
        ),
      ),
    },
    grantIsNeverAnonymous: {
      description:
        "A verified org always names both halves of the claim. Without this, a future refactor that stopped recording either snapshot would make the invariant above vacuously true (NONE = NONE)",
      formula: forall(
        "Orgs",
        "o",
        or(
          not(index(verified, param("o"))),
          and(
            not(eq(index(verifiedForDomain, param("o")), lit("NONE"))),
            not(eq(index(provenDomain, param("o")), lit("NONE"))),
          ),
        ),
      ),
    },
    noPendingTokenSurvivesAGrant: {
      description:
        "The grant consumes the token it used. A token left pending after verification could be replayed against a domain the org moved to afterwards",
      formula: forall(
        "Orgs",
        "o",
        or(
          not(index(verified, param("o"))),
          eq(index(tokenId, param("o")), lit("NONE")),
        ),
      ),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      equivalence: {
        domains: { Orgs: ids({ prefix: "o", size: 1 }) },
        graphEquivalence: true,
        budgets: { maxEstimatedStates: 100_000 },
      },
      pr: {
        domains: { Orgs: ids({ prefix: "o", size: 1 }) },
        graphEquivalence: true,
        budgets: { maxEstimatedStates: 100_000 },
      },
      nightly: {
        domains: { Orgs: ids({ prefix: "o", size: 2 }) },
        graphEquivalence: false,
        budgets: { maxEstimatedStates: 800_000_000_000 },
      },
    },
  },
});
export default orgDomainVerificationMachine;
