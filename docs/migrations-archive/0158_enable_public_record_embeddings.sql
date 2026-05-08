-- Migration: 0158_enable_public_record_embeddings.sql
-- Description: Enable the public record embeddings pipeline for Nessie intelligence.
-- Nessie is the compliance intelligence engine — it needs embeddings to perform
-- RAG queries against the 320K+ anchored public records corpus.
-- ROLLBACK: UPDATE switchboard_flags SET value = false WHERE id = 'ENABLE_PUBLIC_RECORD_EMBEDDINGS';

UPDATE switchboard_flags
SET value = true
WHERE id = 'ENABLE_PUBLIC_RECORD_EMBEDDINGS';
