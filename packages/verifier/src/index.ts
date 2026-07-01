/**
 * @arkova/verifier — standalone, zero-Arkova-dependency Bitcoin anchor verifier.
 *
 * The PROOF-07 verifier CLI imports from here. Everything is pure-buffer +
 * injectable HTTP, so the package runs with no Arkova runtime coupling and
 * confirms anchors against an INDEPENDENT Esplora/Blockstream node.
 */

export {
  confirmInclusion,
  createEsploraFetch,
  type ConfirmInclusionRequest,
  type ConfirmInclusionOptions,
  type ConfirmInclusionResult,
  type ConfirmInclusionStatus,
  type IndependentNodeFetch,
  type IndependentNodeResponse,
  type EsploraTx,
} from './independent-node.js';
