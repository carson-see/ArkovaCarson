import { config } from '../config.js';

export const PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_ERROR = 'professional_education_schema_unavailable' as const;

const PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_MESSAGE =
  'Professional education schema is not ready in this environment; PR #841 CPE/CLE runtime paths are disabled until schema and migration-ledger reconciliation completes.';

export function isProfessionalEducationSchemaReady(): boolean {
  return config.enableProfessionalEducationSchemaReady === true;
}

export function professionalEducationSchemaUnavailableBody(scope: string): {
  error: typeof PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_ERROR;
  message: string;
  scope: string;
} {
  return {
    error: PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_ERROR,
    message: PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_MESSAGE,
    scope,
  };
}
