/**
 * Unit tests for Agent Identity & Delegation API (PH2-AGENT-05)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AGENT_ALLOWED_SCOPES,
  CreateAgentSchema,
  UpdateAgentSchema,
  VALID_AGENT_TYPES,
} from './agents.js';
import { API_KEY_SCOPES } from '../apiScopes.js';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Agent Identity schemas', () => {
  describe('CreateAgentSchema', () => {
    it('accepts valid agent registration', () => {
      const result = CreateAgentSchema.safeParse({
        name: 'HR Verification Bot',
        description: 'Automated credential verification for ATS',
        agent_type: 'ats_integration',
        allowed_scopes: ['verify', 'verify:batch', 'oracle:read', 'attestations:write'],
        framework: 'langchain',
        version: '1.0.0',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('HR Verification Bot');
        expect(result.data.allowed_scopes).toEqual([
          'verify',
          'verify:batch',
          'oracle:read',
          'attestations:write',
        ]);
      }
    });

    it('applies defaults for minimal registration', () => {
      const result = CreateAgentSchema.safeParse({ name: 'Test Agent' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agent_type).toBe('custom');
        expect(result.data.allowed_scopes).toEqual(['verify']);
      }
    });

    it('rejects empty name', () => {
      expect(CreateAgentSchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('rejects name over 200 chars', () => {
      expect(CreateAgentSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    });

    it('rejects invalid agent_type', () => {
      expect(CreateAgentSchema.safeParse({ name: 'Test', agent_type: 'invalid' }).success).toBe(false);
    });

    it('rejects invalid scope', () => {
      expect(CreateAgentSchema.safeParse({ name: 'Test', allowed_scopes: ['admin'] }).success).toBe(false);
    });

    it('rejects stale pre-canonical agent scope names', () => {
      expect(CreateAgentSchema.safeParse({ name: 'Test', allowed_scopes: ['attest'] }).success).toBe(false);
      expect(CreateAgentSchema.safeParse({ name: 'Test', allowed_scopes: ['oracle'] }).success).toBe(false);
    });

    it('rejects empty scopes array', () => {
      expect(CreateAgentSchema.safeParse({ name: 'Test', allowed_scopes: [] }).success).toBe(false);
    });

    it('rejects non-HTTPS callback URL', () => {
      expect(CreateAgentSchema.safeParse({ name: 'Test', callback_url: 'http://evil.com' }).success).toBe(false);
    });

    it('accepts HTTPS callback URL', () => {
      const result = CreateAgentSchema.safeParse({ name: 'Test', callback_url: 'https://webhook.example.com/agent' });
      expect(result.success).toBe(true);
    });

    it('accepts all valid agent types', () => {
      for (const type of VALID_AGENT_TYPES) {
        expect(CreateAgentSchema.safeParse({ name: 'Test', agent_type: type }).success).toBe(true);
      }
    });

    it('uses the canonical API key scope vocabulary', () => {
      expect(AGENT_ALLOWED_SCOPES).toEqual(API_KEY_SCOPES);
      const result = CreateAgentSchema.safeParse({ name: 'Test', allowed_scopes: [...API_KEY_SCOPES] });
      expect(result.success).toBe(true);
    });
  });

  describe('UpdateAgentSchema', () => {
    it('accepts partial update', () => {
      expect(UpdateAgentSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    });

    it('accepts status change to suspended', () => {
      expect(UpdateAgentSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    });

    it('rejects status change to revoked (use DELETE instead)', () => {
      expect(UpdateAgentSchema.safeParse({ status: 'revoked' }).success).toBe(false);
    });

    it('accepts nullable callback_url (to clear it)', () => {
      expect(UpdateAgentSchema.safeParse({ callback_url: null }).success).toBe(true);
    });

    it('accepts empty object (no-op update)', () => {
      expect(UpdateAgentSchema.safeParse({}).success).toBe(true);
    });
  });
});
