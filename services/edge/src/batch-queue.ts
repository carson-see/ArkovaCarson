/**
 * Batch Anchor Queue Consumer (INFRA-04)
 *
 * Consumes messages from ARKOVA_BATCH_QUEUE and calls the Express worker
 * for anchor processing. Provides dead-letter support for failed messages.
 *
 * STATUS: STUB — scaffolding only. No application logic until INFRA-04 is started.
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md Section 2
 */

export default {
  async queue(_batch: MessageBatch<unknown>, _env: unknown, _ctx: ExecutionContext): Promise<void> {
    // Stub — no processing logic yet
  },
};
