import {
  defineMachine, variable, scalarVar, mapVar, enumType, boolType, optionType, domainType,
  lit, param, index, eq, and, or, not, forall, setVar, setMap, ids,
} from "tla-precheck";

const authorityRevoked = variable("authorityRevoked");
const sentinelCommitted = variable("sentinelCommitted");
const owner = variable("owner");
const providerPhase = variable("providerPhase");
const phase = variable("phase");
const snapshotRevoked = variable("snapshotRevoked");
const rows = variable("rows");
const admittedAfterRevoke = variable("admittedAfterRevoke");
const o = param("o");
const at = (v: ReturnType<typeof variable>) => index(v, o);

/**
 * SCRUM-4570 and admission audit integrity: two organizations admit the same
 * passport while an authenticated provider records terminal revocation. The
 * service-owned sentinel creates a shared lock even before any row exists.
 * No tenant-controlled metadata or newer receipt can clear the tombstone.
 *
 * COMMITTED abstracts agent + hashed key + both audits in one transaction.
 * UNAUDITED exists only to expose the old split-write negative control. Failure
 * rolls back every admission write. An uncertain response can retry but cannot
 * create another key or delete a committed one. Provider enforcement is a
 * separate retryable per-agent step: recording a repeated tombstone never skips
 * unfinished organizations. This is a bounded design proof, not a generated
 * database adapter. Real SQL sessions verify these transaction boundaries,
 * table/RPC ACLs and the initially absent sentinel on the complete schema.
 */
export const passportAdmissionMachine = defineMachine({
  version: 2,
  moduleName: "PassportAdmission",
  variables: {
    authorityRevoked: scalarVar(boolType(), lit(false)),
    sentinelCommitted: scalarVar(boolType(), lit(false)),
    owner: scalarVar(optionType(domainType("Orgs")), lit(null)),
    providerPhase: scalarVar(enumType("READY", "LOCKED", "RECORDED"), lit("READY")),
    phase: mapVar("Orgs", enumType("READY", "LOCKED", "DONE"), lit("READY")),
    snapshotRevoked: mapVar("Orgs", boolType(), lit(false)),
    rows: mapVar("Orgs", enumType("NONE", "COMMITTED", "REVOKED", "UNAUDITED"), lit("NONE")),
    admittedAfterRevoke: scalarVar(boolType(), lit(false)),
  },
  actions: {
    lockAdmission: {
      params: { o: "Orgs" },
      guard: and(eq(at(phase), lit("READY")), eq(owner, lit(null)), not(eq(providerPhase, lit("LOCKED")))),
      updates: [setVar("owner", o), setMap("phase", o, lit("LOCKED")), setMap("snapshotRevoked", o, authorityRevoked)],
    },
    commitAdmission: {
      params: { o: "Orgs" },
      guard: and(eq(owner, o), eq(at(phase), lit("LOCKED")), not(at(snapshotRevoked)), eq(at(rows), lit("NONE"))),
      updates: [setMap("rows", o, lit("COMMITTED")), setMap("phase", o, lit("DONE")),
        setVar("sentinelCommitted", lit(true)), setVar("owner", lit(null)), setVar("admittedAfterRevoke", authorityRevoked)],
    },
    rejectAdmission: {
      params: { o: "Orgs" },
      guard: and(eq(owner, o), eq(at(phase), lit("LOCKED")), or(at(snapshotRevoked), not(eq(at(rows), lit("NONE"))))),
      updates: [setMap("phase", o, lit("DONE")), setVar("owner", lit(null))],
    },
    failAdmission: {
      params: { o: "Orgs" }, guard: and(eq(owner, o), eq(at(phase), lit("LOCKED"))),
      // Includes key/audit errors: no partially committed agent, key or audit.
      updates: [setMap("phase", o, lit("READY")), setVar("owner", lit(null))],
    },
    uncertainReplyRetry: {
      params: { o: "Orgs" }, guard: eq(at(phase), lit("DONE")),
      updates: [setMap("phase", o, lit("READY"))],
    },
    lockRevocation: {
      params: {}, guard: and(eq(providerPhase, lit("READY")), eq(owner, lit(null))),
      updates: [setVar("providerPhase", lit("LOCKED"))],
    },
    recordRevocation: {
      params: {}, guard: eq(providerPhase, lit("LOCKED")),
      updates: [setVar("authorityRevoked", lit(true)), setVar("sentinelCommitted", lit(true)), setVar("providerPhase", lit("RECORDED"))],
    },
    failRevocation: {
      params: {}, guard: eq(providerPhase, lit("LOCKED")),
      updates: [setVar("providerPhase", lit("READY"))],
    },
    enforceAgent: {
      params: { o: "Orgs" }, guard: and(eq(providerPhase, lit("RECORDED")), eq(at(rows), lit("COMMITTED"))),
      updates: [setMap("rows", o, lit("REVOKED"))],
    },
    retryRevocation: {
      params: {}, guard: eq(providerPhase, lit("RECORDED")),
      // Durable tombstone remains; a retry still visits all affected agents.
      updates: [setVar("providerPhase", lit("READY"))],
    },
  },
  invariants: {
    terminalProviderAuthority: {
      description: "No organization can commit an admission after provider revocation wins the shared lock",
      formula: not(admittedAfterRevoke),
    },
    committedAdmissionIncludesAudits: {
      description: "A live agent/key cannot commit without its security audit records",
      formula: forall("Orgs", "o", not(eq(at(rows), lit("UNAUDITED")))),
    },
    providerAndAdmissionLocksExcludeEachOther: {
      description: "The initially absent authority row must not leave a gap in serialization",
      formula: or(not(eq(providerPhase, lit("LOCKED"))), eq(owner, lit(null))),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: { pr: { domains: { Orgs: ids({ prefix: "org", size: 2 }) },
      budgets: { maxEstimatedStates: 100_000 }, checks: { deadlock: false, graphEquivalence: true } } },
  },
});

export default passportAdmissionMachine;
