import {
  defineMachine, scalarVar, enumType, domainValues, variable,
  lit, param, eq, and, or, not, setVar,
} from 'tla-precheck';

const phase = variable('phase');
const storedAnchor = variable('storedAnchor');
const storedProof = variable('storedProof');
const capturedAnchor = variable('capturedAnchor');
const capturedProof = variable('capturedProof');
const source = variable('source');
const isReady = eq(phase, lit('proof_read'));
const bothKnown = and(not(eq(capturedAnchor, lit('unknown'))), not(eq(capturedProof, lit('unknown'))));
const sameBlock = eq(capturedAnchor, capturedProof);

/**
 * PR #2782: bind certificate metadata to the block named by its proof.
 * Independent anchor/proof updates may interleave with the two reads. Decisions
 * bind the captured identities, not a claim that neither database row changes
 * later. Unknown identities retain existing proof metadata without asserting a
 * new measurement. A known mismatch withholds the packet.
 *
 * This finite abstraction owns no database table. The accompanying contract test
 * compares the real resolver with this interpreter, including stale-read traces.
 * It does not prove Bitcoin consensus, stored-data accuracy or snapshot freshness.
 */
export default defineMachine({
  version: 2,
  moduleName: 'ProofBlockMetadata',
  variables: {
    phase: scalarVar(enumType('start', 'anchor_read', 'proof_read', 'done'), lit('start')),
    storedAnchor: scalarVar(enumType('unknown', 'a', 'b'), lit('unknown')),
    storedProof: scalarVar(enumType('unknown', 'a', 'b'), lit('unknown')),
    capturedAnchor: scalarVar(enumType('unknown', 'a', 'b'), lit('unknown')),
    capturedProof: scalarVar(enumType('unknown', 'a', 'b'), lit('unknown')),
    source: scalarVar(enumType('unselected', 'anchor', 'proof', 'rejected'), lit('unselected')),
  },
  actions: {
    updateAnchor: {
      params: { block: 'Blocks' }, guard: lit(true),
      updates: [setVar('storedAnchor', param('block'))],
    },
    updateProof: {
      params: { block: 'Blocks' }, guard: lit(true),
      updates: [setVar('storedProof', param('block'))],
    },
    readAnchor: {
      params: {}, guard: eq(phase, lit('start')),
      updates: [setVar('capturedAnchor', storedAnchor), setVar('phase', lit('anchor_read'))],
    },
    readProof: {
      params: {}, guard: eq(phase, lit('anchor_read')),
      updates: [setVar('capturedProof', storedProof), setVar('phase', lit('proof_read'))],
    },
    useAnchor: {
      params: {}, guard: and(isReady, bothKnown, sameBlock),
      updates: [setVar('source', lit('anchor')), setVar('phase', lit('done'))],
    },
    retainProof: {
      params: {}, guard: and(isReady, not(bothKnown)),
      updates: [setVar('source', lit('proof')), setVar('phase', lit('done'))],
    },
    rejectMismatch: {
      params: {}, guard: and(isReady, bothKnown, not(sameBlock)),
      updates: [setVar('source', lit('rejected')), setVar('phase', lit('done'))],
    },
    reset: {
      params: {}, guard: eq(phase, lit('done')),
      updates: [setVar('phase', lit('start')), setVar('source', lit('unselected')),
        setVar('capturedAnchor', lit('unknown')), setVar('capturedProof', lit('unknown'))],
    },
  },
  invariants: {
    anchorRequiresKnownMatchingBlock: {
      description: 'Anchor metadata is selected only for a known matching proof block',
      formula: or(not(eq(source, lit('anchor'))), and(bothKnown, sameBlock)),
    },
    mismatchedBlockNeverPublished: {
      description: 'A known mismatch cannot publish a packet from either metadata source',
      formula: or(not(or(eq(source, lit('anchor')), eq(source, lit('proof')))), not(bothKnown), sameBlock),
    },
    rejectionRequiresKnownMismatch: {
      description: 'Missing metadata alone does not turn into a claimed block mismatch',
      formula: or(not(eq(source, lit('rejected'))), and(bothKnown, not(sameBlock))),
    },
  },
  proof: {
    defaultTier: 'pr',
    tiers: { pr: { domains: { Blocks: domainValues('unknown', 'a', 'b') }, budgets: { maxEstimatedStates: 10_000 } } },
  },
});
