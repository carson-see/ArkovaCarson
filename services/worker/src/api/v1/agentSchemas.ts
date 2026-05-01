import { z } from 'zod';
import { API_KEY_SCOPES } from '../apiScopes.js';

export const VALID_AGENT_TYPES = ['llm_agent', 'ats_integration', 'hr_platform', 'compliance_tool', 'custom'] as const;

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  agent_type: z.enum(VALID_AGENT_TYPES).default('custom'),
  allowed_scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['verify']),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  allowed_scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(),
  callback_url: z.string().url().startsWith('https://').nullable().optional(),
});
