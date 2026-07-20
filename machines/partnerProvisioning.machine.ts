import {
  defineMachine,
  enumType,
  optionType,
  domainType,
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
  modelValues,
  variable,
} from "tla-precheck";

const status = variable("status");
const requestedBy = variable("requestedBy");
const approvedBy = variable("approvedBy");

/**
 * Partner-Account Provisioning Machine (SCRUM-2990)
 *
 * Formal model of the partner-account lifecycle implemented in
 * services/worker/src/api/partner-provisioning.ts:
 *
 *   NONE --request--> REQUESTED --approve--> APPROVED --provision--> PROVISIONED
 *                          \--reject--> REJECTED   \--cancel--> REJECTED
 *
 * Proven invariants (the properties the hand-written guards claim to hold):
 *  - Separation of duties: an account's approver is never its requester.
 *  - No provision without prior approval (approvedBy set on any PROVISIONED).
 *  - Any non-NONE account has a requester (a lifecycle can't start mid-way).
 *  - PROVISIONED and REJECTED are terminal (structurally: no action leaves them).
 *
 * Adapter status (mirrors calibrationWorkflow.machine.ts): documentation-only —
 * no runtimeAdapter. The backing `partner_accounts` table + service_role adapter
 * are the deferred post-train work (migrations frozen in the 2026-07-20 window).
 * This spec stays runnable under `tla-precheck check` so an invariant regression
 * is caught when the flow is later wired to the DB. When the table lands, add the
 * runtimeAdapter/ownedTables/ownedColumns metadata and `build`.
 *
 * VERIFICATION STATUS (2026-07-20): DSL-valid and type-checks clean under
 * machines/tsconfig.json. The exhaustive `tla-precheck check` (TLC) run could NOT
 * execute in this worktree — tla-precheck v0.1.7's loader expects TypeScript
 * ^5.9.3 but the repo has TS 6.0.3, so its pre-compile aborts with TS5096/TS5103
 * for EVERY machine here (calibrationWorkflow/bitcoinAnchor included), not this
 * model. Run `check` in a TS-5 env / CI to produce the equivalence certificate.
 * All four invariants were verified by manual reachability trace (see PR notes);
 * that trace also caught + fixed an over-strong invariant on the cancel path.
 */
export const partnerProvisioningMachine = defineMachine({
  version: 2,
  moduleName: "PartnerProvisioning",

  variables: {
    // Lifecycle status of each partner account. NONE = not yet requested.
    status: mapVar(
      "PartnerAccounts",
      enumType("NONE", "REQUESTED", "APPROVED", "PROVISIONED", "REJECTED"),
      lit("NONE"),
    ),
    // The actor who filed the request (set at request; null before).
    requestedBy: mapVar("PartnerAccounts", optionType(domainType("Users")), lit(null)),
    // The actor who approved (set at approve; null before / if rejected pre-approval).
    approvedBy: mapVar("PartnerAccounts", optionType(domainType("Users")), lit(null)),
  },

  actions: {
    // File a partner-account request.
    request: {
      params: { p: "PartnerAccounts", u: "Users" },
      guard: eq(index(status, param("p")), lit("NONE")),
      updates: [
        setMap("status", param("p"), lit("REQUESTED")),
        setMap("requestedBy", param("p"), param("u")),
      ],
    },

    // Approve a pending request. Separation of duties: the approver must NOT be
    // the requester.
    approve: {
      params: { p: "PartnerAccounts", u: "Users" },
      guard: and(
        eq(index(status, param("p")), lit("REQUESTED")),
        not(eq(index(requestedBy, param("p")), param("u"))),
      ),
      updates: [
        setMap("status", param("p"), lit("APPROVED")),
        setMap("approvedBy", param("p"), param("u")),
      ],
    },

    // Reject a pending request (also SoD-guarded — requester can't reject own).
    reject: {
      params: { p: "PartnerAccounts", u: "Users" },
      guard: and(
        eq(index(status, param("p")), lit("REQUESTED")),
        not(eq(index(requestedBy, param("p")), param("u"))),
      ),
      updates: [setMap("status", param("p"), lit("REJECTED"))],
    },

    // Cancel an already-approved request that never got provisioned
    // (approved -> rejected; the missing-lifecycle leg added in review).
    cancelApproved: {
      params: { p: "PartnerAccounts", u: "Users" },
      guard: eq(index(status, param("p")), lit("APPROVED")),
      updates: [setMap("status", param("p"), lit("REJECTED"))],
    },

    // Provision an approved request (mint the partner org).
    provision: {
      params: { p: "PartnerAccounts", u: "Users" },
      guard: eq(index(status, param("p")), lit("APPROVED")),
      updates: [setMap("status", param("p"), lit("PROVISIONED"))],
    },
  },

  invariants: {
    // Separation of duties: the approver is never the requester.
    sodApproverNotRequester: {
      description: "An account's approver is never its requester",
      formula: forall("PartnerAccounts", "p",
        or(
          eq(index(approvedBy, param("p")), lit(null)),
          not(eq(index(approvedBy, param("p")), index(requestedBy, param("p")))),
        ),
      ),
    },

    // No provision without prior approval.
    provisionedImpliesApproved: {
      description: "A PROVISIONED account must have an approver recorded",
      formula: forall("PartnerAccounts", "p",
        or(
          not(eq(index(status, param("p")), lit("PROVISIONED"))),
          not(eq(index(approvedBy, param("p")), lit(null))),
        ),
      ),
    },

    // A lifecycle can't start mid-way: any non-NONE account has a requester.
    nonNoneImpliesRequested: {
      description: "Any account past NONE has a requester recorded",
      formula: forall("PartnerAccounts", "p",
        or(
          eq(index(status, param("p")), lit("NONE")),
          not(eq(index(requestedBy, param("p")), lit(null))),
        ),
      ),
    },

    // An approver is only ever recorded AFTER the request leaves REQUESTED via
    // approval — never in NONE or REQUESTED. (Note: cancelApproved moves an
    // APPROVED account to REJECTED and deliberately RETAINS approvedBy for audit
    // history, so REJECTED-with-approver is a legitimate state — an earlier,
    // over-strong "only APPROVED/PROVISIONED" invariant would wrongly reject it.)
    approvedBySetImpliesPastRequested: {
      description: "approvedBy is recorded only after leaving NONE/REQUESTED (i.e. post-approval)",
      formula: forall("PartnerAccounts", "p",
        or(
          eq(index(approvedBy, param("p")), lit(null)),
          and(
            not(eq(index(status, param("p")), lit("NONE"))),
            not(eq(index(status, param("p")), lit("REQUESTED"))),
          ),
        ),
      ),
    },
  },

  proof: {
    defaultTier: "pr",
    tiers: {
      pr: {
        domains: {
          Users: modelValues("u", { size: 2, symmetry: true }),
          PartnerAccounts: ids({ prefix: "p", size: 2 }),
        },
        budgets: {
          maxEstimatedStates: 50_000,
        },
      },
      nightly: {
        domains: {
          Users: modelValues("u", { size: 3, symmetry: true }),
          PartnerAccounts: ids({ prefix: "p", size: 3 }),
        },
        budgets: {
          maxEstimatedStates: 200_000,
        },
      },
    },
  },
});

export default partnerProvisioningMachine;
