/**
 * PR2570 atomic publication model (migration 0445). A pending anchors row is
 * visible to an independent broadcaster even before connector_artifact links
 * it. The regression model reproduced that race with a separate insert.
 * Here mintAnchorFromCapture publishes and links in the same transaction;
 * claimPublishedAnchor remains independently schedulable. Reintroducing a
 * separate published insert violates broadcastRequiresFreshLinkedAnchor.
 * One domain element represents one org-scoped envelope. Role/tenant SQL
 * authorization and equal-fingerprint metadata-version changes are covered
 * by transaction tests; this model checks publication, linking and healing.
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
const artifactCreated = variable("artifactCreated");
const artifactOwner = variable("artifactOwner");
const fingerprintClass = variable("fingerprintClass");
const conflictDetected = variable("conflictDetected");
const outboundHasActed = variable("outboundHasActed");
const anchorMaterialized = variable("anchorMaterialized");
const capturedFingerprintClass = variable("capturedFingerprintClass");
const anchorFingerprintClass = variable("anchorFingerprintClass");
const anchorPublished = variable("anchorPublished");
const broadcastClaimed = variable("broadcastClaimed");
export const docusignInboundDedupMachine = defineMachine({
  version: 2,
  moduleName: "DocusignInboundDedup",
  variables: {
    anchorPublished: mapVar("Envelopes", boolType(), lit(false)),
    broadcastClaimed: mapVar("Envelopes", boolType(), lit(false)),
    artifactCreated: mapVar("Envelopes", boolType(), lit(false)),
    artifactOwner: mapVar(
      "Envelopes",
      enumType("NONE", "OUTBOUND", "INBOUND"),
      lit("NONE"),
    ),
    fingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
    conflictDetected: mapVar("Envelopes", boolType(), lit(false)),
    outboundHasActed: mapVar("Envelopes", boolType(), lit(false)),
    anchorMaterialized: mapVar("Envelopes", boolType(), lit(false)),
    capturedFingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
    anchorFingerprintClass: mapVar(
      "Envelopes",
      enumType("NONE", "REAL", "FORGED"),
      lit("NONE"),
    ),
  },
  actions: {
    materializeOutbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("OUTBOUND")),
        setMap("fingerprintClass", param("e"), lit("REAL")),
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },
    materializeInbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("INBOUND")),
        setMap("fingerprintClass", param("e"), lit("REAL")),
      ],
    },
    forgeInbound: {
      params: { e: "Envelopes" },
      guard: not(index(artifactCreated, param("e"))),
      updates: [
        setMap("artifactCreated", param("e"), lit(true)),
        setMap("artifactOwner", param("e"), lit("INBOUND")),
        setMap("fingerprintClass", param("e"), lit("FORGED")),
      ],
    },
    captureArtifactFingerprint: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        eq(index(capturedFingerprintClass, param("e")), lit("NONE")),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap(
          "capturedFingerprintClass",
          param("e"),
          index(fingerprintClass, param("e")),
        ),
      ],
    },
    claimPublishedAnchor: {
      params: { e: "Envelopes" },
      guard: and(index(anchorPublished, param("e")), not(index(broadcastClaimed, param("e")))),
      updates: [setMap("broadcastClaimed", param("e"), lit(true))],
    },
    mintAnchorFromCapture: {
      params: { e: "Envelopes" },
      guard: and(
        not(eq(index(capturedFingerprintClass, param("e")), lit("NONE"))),
        not(index(anchorMaterialized, param("e"))),
        eq(
          index(capturedFingerprintClass, param("e")),
          index(fingerprintClass, param("e")),
        ),
      ),
      updates: [
        setMap("anchorPublished", param("e"), lit(true)),
        setMap("anchorMaterialized", param("e"), lit(true)),
        setMap(
          "anchorFingerprintClass",
          param("e"),
          index(capturedFingerprintClass, param("e")),
        ),
      ],
    },
    abortSupersededMint: {
      params: { e: "Envelopes" },
      guard: and(
        not(eq(index(capturedFingerprintClass, param("e")), lit("NONE"))),
        not(index(anchorMaterialized, param("e"))),
        not(eq(
          index(capturedFingerprintClass, param("e")),
          index(fingerprintClass, param("e")),
        )),
      ),
      updates: [
        setMap("capturedFingerprintClass", param("e"), lit("NONE")),
      ],
    },
    outboundHealsForgery: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(eq(index(artifactOwner, param("e")), lit("OUTBOUND"))),
        not(index(anchorMaterialized, param("e"))),
      ),
      updates: [
        setMap("conflictDetected", param("e"), lit(true)),
        setMap("outboundHasActed", param("e"), lit(true)),
        setMap("fingerprintClass", param("e"), lit("REAL")),
        setMap("artifactOwner", param("e"), lit("OUTBOUND")),
      ],
    },
    outboundLosesRaceUnhealed: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        not(eq(index(artifactOwner, param("e")), lit("OUTBOUND"))),
        index(anchorMaterialized, param("e")),
      ),
      updates: [
        setMap("conflictDetected", param("e"), lit(true)),
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },
    outboundRedeliversOwnSuccess: {
      params: { e: "Envelopes" },
      guard: and(
        index(artifactCreated, param("e")),
        eq(index(artifactOwner, param("e")), lit("OUTBOUND")),
      ),
      updates: [
        setMap("outboundHasActed", param("e"), lit(true)),
      ],
    },
  },
  invariants: {
    broadcastRequiresFreshLinkedAnchor: {
      description: "Every broadcaster-visible claim must already have an artifact link and current fingerprint; inserted-but-unlinked anchors count",
      formula: forall("Envelopes", "e", or(
        not(index(broadcastClaimed, param("e"))),
        and(index(anchorMaterialized, param("e")), eq(index(anchorFingerprintClass, param("e")), index(fingerprintClass, param("e")))),
      )),
    },
    atMostOneArtifactOwner: {
      description:
        "An envelope's artifactOwner is NONE iff no artifact has been created for it — never ambiguous, never double-created",
      formula: forall("Envelopes", "e",
        and(
          not(and(
            index(artifactCreated, param("e")),
            eq(index(artifactOwner, param("e")), lit("NONE")),
          )),
          not(and(
            not(index(artifactCreated, param("e"))),
            not(eq(index(artifactOwner, param("e")), lit("NONE"))),
          )),
        ),
      ),
    },
    outboundNeverSilentlyAcceptsForgery: {
      description:
        "Once the outbound side has acted for an envelope, its own real fingerprint persisted (won outright or healed) OR the row is the documented already-materialized exception (conflict detected AND anchor already live) — never any other unhealed-forgery state",
      formula: forall("Envelopes", "e",
        or(
          not(index(outboundHasActed, param("e"))),
          eq(index(fingerprintClass, param("e")), lit("REAL")),
          and(
            index(conflictDetected, param("e")),
            index(anchorMaterialized, param("e")),
          ),
        ),
      ),
    },
    anchorNeverMintedFromSupersededFingerprint: {
      description:
        "Once an anchor is materialized for an envelope, its baked-in fingerprint class must equal the artifact's CURRENT fingerprint class — a heal that lands between capture and mint must never leave the anchor holding a value the artifact itself has since moved past",
      formula: forall("Envelopes", "e",
        or(
          not(index(anchorMaterialized, param("e"))),
          eq(
            index(anchorFingerprintClass, param("e")),
            index(fingerprintClass, param("e")),
          ),
        ),
      ),
    },
  },
  proof: {
    defaultTier: "pr",
    tiers: {
      equivalence: {
        domains: { Envelopes: ids({ prefix: "e", size: 1 }) },
        graphEquivalence: true,
        budgets: { maxEstimatedStates: 100_000 },
      },
      pr: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 2 }),
        },
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 30_000_000,
        },
      },
      nightly: {
        domains: {
          Envelopes: ids({ prefix: "e", size: 4 }),
        },
        graphEquivalence: false,
        budgets: {
          maxEstimatedStates: 800_000_000_000_000,
        },
      },
    },
  },
});
export default docusignInboundDedupMachine;
