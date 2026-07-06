/**
 * The standalone Arkova reference verifier — zero Arkova network calls.
 *
 * Establishes ONE fact: a document fingerprint is committed in a Merkle root
 * that is itself committed on Bitcoin at a given time. It does so WITHOUT
 * trusting Arkova:
 *
 *   1. RECOMPUTE the Merkle root from fingerprint + branch using the SAME
 *      canonical routine the server uses (vendor/merkle-verify.ts, a verbatim
 *      copy of services/worker/src/utils/merkle-verify.ts, guarded byte-for-byte
 *      by sync-recompute.test.ts) — with leaf/internal domain separation and the
 *      CVE-2012-2459 duplicate-leaf guard (driven by merkle_index + leaf_count).
 *   2 & 3. CONFIRM the recomputed root is committed on-chain AND the receipt is
 *      in a real block — by delegating to `@arkova/verifier`'s `confirmInclusion`
 *      (PROOF-07 / #1349). That ONE shared routine owns the canonical OP_RETURN
 *      decode (`ARKV(4)‖root(32)`, no version byte — fixed byte offset, never a
 *      substring match), the txid-binding inclusion proof (a proof for a
 *      DIFFERENT tx in the same block is rejected), the height→hash reorg guard,
 *      and the independent 80-byte header recomputation. The CLI keeps NO second
 *      decoder of its own.
 *   4. OPTIONALLY verify the published-key signature — reported separately,
 *      NEVER substituting for steps 1–3.
 *
 * The verifier deliberately IGNORES the packet's own `verified` field
 * (verdict-from-status is the exact anti-pattern this sidesteps).
 */

import { confirmInclusion, type ConfirmInclusionResult } from '@arkova/verifier';
import { verifyMerkleInclusion } from './vendor/merkle-verify.js';
import { verifyBundleSignature, type SignatureResult } from './lib/signature.js';
import { chainReasonCode, recomputeReasonCode, type ReasonCode } from './lib/reason-codes.js';
import type { IndependentNode, ProofPacket, PublishedKeys, SignedProofBundle } from './types.js';

export type StepStatus = 'pass' | 'fail' | 'skipped';

/** The one proof schema version this verifier understands (PROOF-08 stamp). */
export const SUPPORTED_PROOF_SCHEMA_VERSION = 1;

export interface VerifyStep {
  id: string;
  /** Auditor-legible label (terminology-ban compliant). */
  label: string;
  status: StepStatus;
  detail: string;
  /** Frozen machine reason code — present ONLY on failing steps (S3-B). */
  code?: ReasonCode;
}

export interface VerifyReport {
  /** Overall verdict: true only when every REQUIRED step passed. */
  ok: boolean;
  fingerprint: string;
  merkleRoot: string;
  /** Network receipt id (tx_id), or null. */
  receiptId: string | null;
  blockHeight: number | null;
  /**
   * Network Observed Time as MEASURED from the 80-byte block header the
   * INDEPENDENT node served (§1.5) — the time read off the header bytes, NOT the
   * packet's self-claimed `block_timestamp`. Null until an on-chain confirmation
   * produces a header (recompute-only mode never promotes the packet's claim to
   * "observed"). The packet's claim is surfaced separately as `packetClaimedTime`.
   */
  networkObservedTime: string | null;
  /**
   * The time the proof PACKET claims for the receipt (`block_timestamp`),
   * surfaced verbatim for comparison. NEVER presented as the network-observed
   * time — a forged packet time must not masquerade as node-observed (§1.5).
   */
  packetClaimedTime: string | null;
  /**
   * True only when an independent header was measured AND it agrees with the
   * packet's claimed time. False when they diverge (the packet time is forged or
   * stale). Null when no independent header was measured (recompute-only).
   */
  observedTimeAgrees: boolean | null;
  /** Independent node label used for confirmation (null if no chain check ran). */
  independentNode: string | null;
  steps: VerifyStep[];
  signature: SignatureResult;
  /** The server's own claim, surfaced for comparison — NOT used for the verdict. */
  serverClaimedVerified: boolean | null;
  /**
   * Frozen machine reason for a NOT-VERIFIED verdict (S3-B enum,
   * `fixtures/manifest.json` reason_codes): the FIRST failing required step's
   * code, or the signature failure class when only the explicitly-requested
   * signature check failed. Null when VERIFIED.
   */
  reasonCode: ReasonCode | null;
}

export interface VerifyOptions {
  /**
   * Independent on-chain source. Omit to skip on-chain confirmation
   * (recompute-only). The `fetch` + `label` are produced by the CLI from a
   * vetted `--rpc` endpoint (see lib/independent-endpoint.ts) and wrap
   * `@arkova/verifier`'s `createEsploraFetch`.
   */
  chain?: IndependentNode;
  /** Signed bundle (optional) for signature verification. */
  signedBundle?: SignedProofBundle;
  /** Published Arkova public key PEM (optional) for signature verification. */
  publicKeyPem?: string;
  /**
   * Published key SET (keys.json shape, optional). When supplied, the bundle's
   * signing_key_id is resolved against it — an unresolvable id fails closed.
   */
  publishedKeys?: PublishedKeys;
}

const RECOMPUTE_LABEL = 'Recompute the secured fingerprint into the published root';
const OP_RETURN_LABEL = 'Confirm the root in the on-chain receipt (independent node)';
const BLOCK_LABEL = 'Confirm the receipt is in a real block (independent node)';
const TIMESTAMP_LABEL = 'Confirm the claimed time matches the independently measured Network Observed Time';

/**
 * Run the verification pipeline against a proof packet.
 *
 * Required steps for `ok === true`:
 *   - schema (always) — the packet's proof_schema_version must be understood
 *     (absent ⇒ legacy v1); an unknown version fails closed rather than
 *     guessing at the hashing rule.
 *   - recompute (always)
 *   - op_return + block-confirm ONLY when a `chain` source is provided AND the
 *     packet carries a tx_id + block_height. (Recompute-only mode is honest: it
 *     confirms the fingerprint is in the claimed root, but states the on-chain
 *     step was not run.)
 *   - signature, ONLY when explicitly requested (bundle + key material
 *     supplied): a PASSING signature never substitutes for the steps above,
 *     but a FAILING requested check fails the verdict closed (S3-B hardening).
 */
export async function verifyProof(
  packet: ProofPacket,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];

  // ── Step 0: schema gate — refuse to interpret an unknown format ──
  const schemaVersion = packet.proof_schema_version ?? null;
  const schemaSupported = schemaVersion === null || schemaVersion === SUPPORTED_PROOF_SCHEMA_VERSION;
  steps.push({
    id: 'schema',
    label: 'Confirm the proof package schema version is understood',
    status: schemaSupported ? 'pass' : 'fail',
    detail: schemaSupported
      ? schemaVersion === null
        ? `No schema version declared; interpreted as version ${SUPPORTED_PROOF_SCHEMA_VERSION} (legacy package).`
        : `Proof package declares schema version ${schemaVersion}, which this verifier understands.`
      : `Unsupported proof package schema version ${schemaVersion} — this verifier understands schema version ${SUPPORTED_PROOF_SCHEMA_VERSION} only and refuses to guess at an unknown format.`,
    ...(schemaSupported ? {} : { code: 'UNSUPPORTED_SCHEMA_VERSION' as const }),
  });

  let independentNode: string | null = null;
  let blockHeight: number | null = packet.block_height;
  // The reported Network Observed Time is ONLY ever the time MEASURED from the
  // independent header (§1.5). It stays null until an on-chain header is read —
  // the packet's self-claimed `block_timestamp` is NEVER promoted into it.
  let networkObservedTime: string | null = null;
  let observedTimeAgrees: boolean | null = null;

  if (!schemaSupported) {
    // An unknown schema means every cryptographic interpretation below would be
    // a guess — skip them explicitly rather than pretending to check.
    const skipDetail = 'Skipped because the proof package schema version is not understood.';
    steps.push({ id: 'recompute', label: RECOMPUTE_LABEL, status: 'skipped', detail: skipDetail });
    steps.push({ id: 'op_return', label: OP_RETURN_LABEL, status: 'skipped', detail: skipDetail });
    steps.push({ id: 'block_confirm', label: BLOCK_LABEL, status: 'skipped', detail: skipDetail });
    steps.push({ id: 'timestamp_honesty', label: TIMESTAMP_LABEL, status: 'skipped', detail: skipDetail });
  } else {
    // ── Step 1: recompute the Merkle root (the canonical, shared routine) ──
    const inclusion = verifyMerkleInclusion(
      packet.fingerprint,
      packet.merkle_proof,
      packet.merkle_root,
      buildInclusionOpts(packet),
    );
    steps.push({
      id: 'recompute',
      label: RECOMPUTE_LABEL,
      status: inclusion.valid ? 'pass' : 'fail',
      detail: inclusion.valid
        ? 'The fingerprint, combined with its inclusion path, reproduces the published root exactly.'
        : `Recompute mismatch: ${inclusion.reason ?? 'unknown'}`,
      ...(inclusion.valid ? {} : { code: recomputeReasonCode(inclusion.reason) }),
    });

    // ── Steps 2 & 3: independent on-chain confirmation (delegated to #1349) ──
    if (opts.chain && packet.tx_id != null && packet.block_height != null) {
      independentNode = opts.chain.label;
      const result = await confirmOnChain(packet, opts.chain);
      steps.push(result.opReturnStep);
      steps.push(result.blockStep);
      if (result.blockHeight != null) blockHeight = result.blockHeight;
      networkObservedTime = result.measuredObservedTime;

      // ── Step 3b: timestamp honesty (§1.5) ──
      // The header gave us an INDEPENDENTLY MEASURED time. Compare it against the
      // time the packet CLAIMS. A forged/stale packet time must not be silently
      // presented as node-observed — surface the divergence and fail the verdict.
      const tsStep = buildTimestampStep(
        packet.block_timestamp,
        result.measuredObservedTime,
        opts.chain.label,
        result.headerMeasured,
      );
      steps.push(tsStep.step);
      observedTimeAgrees = tsStep.agrees;
    } else {
      const reason = describeSkip(opts.chain != null, packet);
      steps.push({
        id: 'op_return',
        label: OP_RETURN_LABEL,
        status: 'skipped',
        detail: reason,
      });
      steps.push({
        id: 'block_confirm',
        label: BLOCK_LABEL,
        status: 'skipped',
        detail: 'Skipped because the on-chain receipt was not checked.',
      });
      steps.push({
        id: 'timestamp_honesty',
        label: TIMESTAMP_LABEL,
        status: 'skipped',
        detail:
          'Skipped because no independent header was measured; the packet-claimed time is shown as a claim only, never as a measured Network Observed Time.',
      });
    }
  }

  // ── Step 4: signature verification (explicitly requested only) ──
  // A PASSING signature never substitutes for the cryptographic steps above.
  // A FAILING one — when the caller explicitly asked for the check — fails the
  // verdict closed: the verifier will not bless a package carrying a forged
  // signature or an unresolvable signer identity (S3-B).
  const signature = verifyBundleSignature(opts.signedBundle, opts.publicKeyPem, opts.publishedKeys);

  // Required steps are everything not 'skipped'. ok = no failures among them
  // AND no failure of an explicitly-requested signature check.
  const ok = steps.every((s) => s.status !== 'fail') && signature.status !== 'failed';

  const firstFailingStep = steps.find((s) => s.status === 'fail');
  const reasonCode: ReasonCode | null = ok
    ? null
    : firstFailingStep?.code ??
      (signature.status === 'failed' ? signature.failureCode ?? 'SIG_INVALID' : null);

  return {
    ok,
    fingerprint: packet.fingerprint,
    merkleRoot: packet.merkle_root,
    receiptId: packet.tx_id,
    blockHeight,
    networkObservedTime,
    packetClaimedTime: packet.block_timestamp,
    observedTimeAgrees,
    independentNode,
    steps,
    signature,
    serverClaimedVerified: typeof packet.verified === 'boolean' ? packet.verified : null,
    reasonCode,
  };
}

/**
 * Build the §1.5 timestamp-honesty step. The verifier reports the
 * header-MEASURED `observedTime` as the Network Observed Time and compares it to
 * the packet's CLAIMED `block_timestamp`. Outcomes:
 *   - measured == claimed       → PASS (the claim is corroborated by the header).
 *   - measured != claimed       → FAIL (a forged/stale packet time; do not pass
 *                                 it off as node-observed).
 *   - header not measured but    → FAIL — the block step already failed; the
 *     on-chain step was attempted   claimed time cannot be independently backed.
 *   - no claimed time at all      → PASS — nothing claimed to contradict; the
 *                                 measured time stands alone.
 * Two ISO instants are compared by absolute epoch (tolerant of formatting), so a
 * `Z` vs `+00:00` rendering of the same instant agrees.
 */
function buildTimestampStep(
  claimed: string | null,
  measured: string | null,
  label: string,
  headerMeasured: boolean,
): { step: VerifyStep; agrees: boolean | null } {
  // No independent header → cannot back any claim. If the on-chain step reached
  // a header we always have `measured`; absence means an earlier on-chain failure.
  if (!headerMeasured || measured == null) {
    return {
      step: {
        id: 'timestamp_honesty',
        label: TIMESTAMP_LABEL,
        status: 'fail',
        detail: `No Network Observed Time could be measured from the independent header via ${label}; the packet-claimed time of ${claimed ?? '(none)'} cannot be independently corroborated.`,
        code: 'TIMESTAMP_MISMATCH',
      },
      agrees: null,
    };
  }

  if (claimed == null) {
    return {
      step: {
        id: 'timestamp_honesty',
        label: TIMESTAMP_LABEL,
        status: 'pass',
        detail: `Network Observed Time ${measured} was measured directly from the independent header (${label}); the packet claimed no time of its own.`,
      },
      agrees: true,
    };
  }

  if (sameInstant(claimed, measured)) {
    return {
      step: {
        id: 'timestamp_honesty',
        label: TIMESTAMP_LABEL,
        status: 'pass',
        detail: `The packet-claimed time matches the Network Observed Time ${measured} measured independently from the header (${label}).`,
      },
      agrees: true,
    };
  }

  return {
    step: {
      id: 'timestamp_honesty',
      label: TIMESTAMP_LABEL,
      status: 'fail',
      detail: `Time MISMATCH: the packet claims ${claimed}, but the Network Observed Time measured independently from the header (${label}) is ${measured}. The claimed time is NOT what the network recorded and must not be presented as observed.`,
      code: 'TIMESTAMP_MISMATCH',
    },
    agrees: false,
  };
}

/** True when two ISO-8601 instants denote the same moment (epoch-equal). */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

function describeSkip(haveChain: boolean, packet: ProofPacket): string {
  if (!haveChain) {
    return packet.tx_id
      ? 'No independent node supplied (recompute-only mode); the on-chain receipt was NOT checked.'
      : 'This record carries no network receipt id; the on-chain step is not applicable.';
  }
  if (packet.tx_id == null) {
    return 'This record carries no network receipt id; the on-chain step is not applicable.';
  }
  return 'This record carries no block height; the on-chain confirmation cannot be bound and was NOT checked.';
}

function buildInclusionOpts(packet: ProofPacket): { leafIndex?: number; leafCount?: number } {
  const out: { leafIndex?: number; leafCount?: number } = {};
  if (typeof packet.merkle_index === 'number') out.leafIndex = packet.merkle_index;
  if (typeof packet.leaf_count === 'number') out.leafCount = packet.leaf_count;
  return out;
}

interface OnChainResult {
  opReturnStep: VerifyStep;
  blockStep: VerifyStep;
  blockHeight: number | null;
  /**
   * The Network Observed Time MEASURED from the 80-byte header the independent
   * node served (`ConfirmInclusionResult.observedTime`), or null if no header was
   * reached. NEVER the packet's claimed time.
   */
  measuredObservedTime: string | null;
  /** True iff confirmInclusion actually read + validated an independent header. */
  headerMeasured: boolean;
}

/**
 * Delegate the on-chain confirmation to `@arkova/verifier`'s `confirmInclusion`
 * and map its single `ConfirmInclusionResult` into the CLI's two auditor-legible
 * steps (OP_RETURN payload + block inclusion). `confirmInclusion` is bound to
 * `packet.tx_id` — it recomputes the inclusion proof FROM that txid, so a node
 * that serves a tx/merkle-proof for a DIFFERENT transaction cannot verify
 * (Carson #1353 verify.ts:173 txid-binding; closed by delegation).
 */
async function confirmOnChain(packet: ProofPacket, chain: IndependentNode): Promise<OnChainResult> {
  let result: ConfirmInclusionResult;
  try {
    result = await confirmInclusion(
      {
        txId: packet.tx_id as string,
        expectedMerkleRoot: packet.merkle_root,
        blockHeight: packet.block_height as number,
      },
      { fetch: chain.fetch },
    );
  } catch (err) {
    const detail = `Could not confirm the receipt against the independent node (${chain.label}): ${errMsg(err)}`;
    // Defensive: confirmInclusion never throws by contract; a thrown transport
    // bug means the receipt could not be fetched — the honest bucket is
    // TX_NOT_FOUND (nothing on the independent node corroborates the packet).
    return {
      opReturnStep: { id: 'op_return', label: OP_RETURN_LABEL, status: 'fail', detail, code: 'TX_NOT_FOUND' },
      blockStep: {
        id: 'block_confirm',
        label: BLOCK_LABEL,
        status: 'fail',
        detail: 'Not checked because the independent confirmation could not run.',
        code: 'TX_NOT_FOUND',
      },
      blockHeight: null,
      measuredObservedTime: null,
      headerMeasured: false,
    };
  }

  const blockHeight = result.blockHeight ?? null;
  // `observedTime` is the time MEASURED off the independent header — present on
  // every result that read a verified header (confirmed or a post-header failure).
  const measuredObservedTime = result.observedTime;
  const headerMeasured = result.observedTime != null;

  // The frozen machine code for whatever failed on-chain (undefined when clean).
  const failureCode =
    result.confirmed ? undefined : chainReasonCode(result.status as Exclude<ConfirmInclusionResult['status'], 'confirmed'>);

  // Step 2 (OP_RETURN payload) passes once we reach a payload-clean status: the
  // tx exists, carries a canonical Arkova OP_RETURN, and it commits the expected
  // root. payload-specific failures fail THIS step; later (height/header/
  // inclusion) failures fail step 3 with step 2 already proven.
  const opReturnPassed = result.confirmed || isPostPayloadFailure(result.status);
  const opReturnStep: VerifyStep = {
    id: 'op_return',
    label: OP_RETURN_LABEL,
    status: opReturnPassed ? 'pass' : 'fail',
    detail: opReturnPassed
      ? `The receipt fetched from ${chain.label} commits exactly the published root in its embedded data.`
      : opReturnDetail(result, chain.label),
    ...(opReturnPassed ? {} : { code: failureCode }),
  };

  const blockStep: VerifyStep = {
    id: 'block_confirm',
    label: BLOCK_LABEL,
    status: result.confirmed ? 'pass' : 'fail',
    detail: result.confirmed
      ? `Confirmed in block #${result.blockHeight} (Network Observed Time ${measuredObservedTime ?? 'unavailable'}, measured from the independent header), per ${chain.label}, with an independently recomputed inclusion proof.`
      : blockDetail(result, chain.label),
    ...(result.confirmed ? {} : { code: failureCode }),
  };

  return {
    opReturnStep,
    blockStep,
    blockHeight,
    measuredObservedTime,
    headerMeasured,
  };
}

/**
 * A `confirmInclusion` status that proves the OP_RETURN payload step PASSED
 * (the receipt carries the expected root) but a LATER on-chain binding failed.
 * Pre-payload failures (no tx, no anchor output, payload mismatch, bad request)
 * are NOT in this set — they fail the OP_RETURN step itself.
 */
function isPostPayloadFailure(status: ConfirmInclusionResult['status']): boolean {
  return (
    status === 'height_mismatch' ||
    status === 'block_hash_mismatch' ||
    status === 'header_unavailable' ||
    status === 'inclusion_failed'
  );
}

function opReturnDetail(result: ConfirmInclusionResult, label: string): string {
  switch (result.status) {
    case 'tx_not_found':
      return `The receipt could not be fetched from ${label} (not found on the independent node).`;
    case 'not_in_block':
      return `${label} reports this receipt is not yet confirmed in a block.`;
    case 'txid_mismatch':
      return `The receipt body served by ${label} does NOT identify as the requested receipt — its own identity disagrees with the receipt id we asked for; rejected before reading its contents.`;
    case 'no_anchor_output':
      return `The receipt fetched from ${label} carries no canonical Arkova secured-data output.`;
    case 'payload_mismatch':
      return `The receipt fetched from ${label} does NOT commit the published root (found ${result.extractedMerkleRoot ?? 'a different value'}).`;
    case 'bad_request':
      return `The receipt could not be confirmed against ${label}: ${result.reason ?? 'malformed request'}.`;
    default:
      return `The receipt could not be confirmed against ${label}: ${result.reason ?? result.status}.`;
  }
}

function blockDetail(result: ConfirmInclusionResult, label: string): string {
  switch (result.status) {
    case 'height_mismatch':
      return `${label} places the receipt in block #${result.blockHeight}, but the packet claims a different block height.`;
    case 'block_hash_mismatch':
      return `${label} maps the stated block height to a different block — possible reorg; not confirmed.`;
    case 'header_unavailable':
      return `The block header could not be independently recomputed via ${label}: ${result.reason ?? 'unavailable'}.`;
    case 'inclusion_failed':
      return `The inclusion proof from ${label} does not bind this receipt to the committed block — ${result.reason ?? 'rejected'}.`;
    default:
      return `Not confirmed in a real block via ${label}: ${result.reason ?? result.status}.`;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
