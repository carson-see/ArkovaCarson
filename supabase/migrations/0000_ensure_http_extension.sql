-- Ensure http extension exists before migration 0112 attempts to revoke its functions.
-- In production this is a no-op (extension already exists).
-- In CI/local this prevents 0112 from failing with "type http_request does not exist".
-- ROLLBACK: DROP EXTENSION IF EXISTS http;

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;
