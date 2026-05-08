-- Migration: 0001_enums.sql
-- Description: Create enum types for user roles and anchor statuses
-- Rollback: DROP TYPE IF EXISTS anchor_status; DROP TYPE IF EXISTS user_role;

-- User role enum
-- INDIVIDUAL: Regular user, manages their own anchors
-- ORG_ADMIN: Organization administrator, manages org anchors
CREATE TYPE user_role AS ENUM ('INDIVIDUAL', 'ORG_ADMIN');

-- Anchor status enum
-- PENDING: Anchor created, awaiting on-chain confirmation
-- SECURED: Anchor confirmed on-chain
-- REVOKED: Anchor has been revoked (soft delete)
CREATE TYPE anchor_status AS ENUM ('PENDING', 'SECURED', 'REVOKED');

-- Note: Enum modifications require migrations. To add a value:
-- ALTER TYPE user_role ADD VALUE 'NEW_ROLE';
-- To remove a value, you must recreate the type (complex migration).
