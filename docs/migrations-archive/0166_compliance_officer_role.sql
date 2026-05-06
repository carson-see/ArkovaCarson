-- Migration 0166: Add compliance_officer role to org_member_role enum
-- Phase III — PH3-ESIG-03: Compliance Center requires a dedicated role
-- for viewing compliance data, exporting proofs, without admin access.
--
-- ROLLBACK: Cannot remove enum values in Postgres without recreation.
-- If needed, recreate the enum type.

ALTER TYPE org_member_role ADD VALUE IF NOT EXISTS 'compliance_officer';

COMMENT ON TYPE org_member_role IS 'owner = created the org, admin = can manage members/settings, member = can view records, compliance_officer = can view compliance data and export proofs';
