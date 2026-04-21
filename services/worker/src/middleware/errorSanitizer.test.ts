/**
 * Error Sanitizer Tests (CISO THREAT-4)
 *
 * Verifies that provider names, API URLs, and internal details
 * are stripped from error messages before reaching clients.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage, sanitizeErrorBody } from './errorSanitizer.js';

describe('errorSanitizer', () => {
  describe('sanitizeErrorMessage', () => {
    it('strips Gemini provider name', () => {
      expect(sanitizeErrorMessage('Gemini API returned 429')).not.toMatch(/gemini/i);
    });

    it('strips Google AI references', () => {
      expect(sanitizeErrorMessage('Google Generative AI quota exceeded')).not.toMatch(/google/i);
    });

    it('strips Cloudflare references', () => {
      expect(sanitizeErrorMessage('Cloudflare Worker timeout')).not.toMatch(/cloudflare/i);
    });

    it('strips Supabase references', () => {
      expect(sanitizeErrorMessage('Supabase connection refused')).not.toMatch(/supabase/i);
    });

    it('strips Stripe references', () => {
      expect(sanitizeErrorMessage('Stripe webhook verification failed')).not.toMatch(/stripe/i);
    });

    it('strips PostgreSQL references', () => {
      expect(sanitizeErrorMessage('PostgreSQL unique constraint violated')).not.toMatch(/postgres/i);
    });

    it('strips API URLs', () => {
      expect(sanitizeErrorMessage('Failed to call generativelanguage.googleapis.com/v1beta/models'))
        .not.toContain('googleapis.com');
    });

    it('strips Sentry references', () => {
      expect(sanitizeErrorMessage('Sentry capture failed')).not.toMatch(/sentry/i);
    });

    it('strips AWS KMS references', () => {
      expect(sanitizeErrorMessage('AWS KMS signing timeout')).not.toMatch(/aws\s*kms/i);
    });

    it('strips Vercel references', () => {
      expect(sanitizeErrorMessage('Vercel edge function timeout')).not.toMatch(/vercel/i);
    });

    it('strips Cloud Run references', () => {
      expect(sanitizeErrorMessage('Cloud Run instance scaling')).not.toMatch(/cloud\s*run/i);
    });

    it('strips API key fragments', () => {
      expect(sanitizeErrorMessage('Invalid key: sk-abc123xyz')).not.toContain('sk-abc123xyz');
      expect(sanitizeErrorMessage('Key AIzaSyD_abcdef12345 is invalid')).not.toContain('AIzaSyD');
    });

    it('preserves generic error messages', () => {
      expect(sanitizeErrorMessage('Request timeout after 30s')).toBe('Request timeout after 30s');
    });

    it('preserves HTTP status codes', () => {
      expect(sanitizeErrorMessage('Service returned 503')).toBe('Service returned 503');
    });

    it('handles empty string', () => {
      expect(sanitizeErrorMessage('')).toBe('');
    });

    it('redacts "worker service" phrasing (UAT 2026-04-18 Bug 3 / UAT5-04)', () => {
      // Exact leaked string from the API-keys fetch error card.
      expect(sanitizeErrorMessage('Ensure the worker service is running.'))
        .not.toMatch(/worker\s+service/i);
    });

    it('preserves the standalone word "worker" (legit in async-job copy)', () => {
      // The narrow `worker service` pattern must not collaterally damage
      // phrases like "background worker queued the anchor job."
      expect(sanitizeErrorMessage('background worker queued the anchor job'))
        .toBe('background worker queued the anchor job');
    });
  });

  describe('sanitizeErrorBody', () => {
    it('sanitizes nested error object', () => {
      const body = {
        error: {
          code: 'AI_ERROR',
          message: 'Gemini API returned 500 from generativelanguage.googleapis.com',
          provider: 'google',
        },
      };
      const sanitized = sanitizeErrorBody(body) as Record<string, unknown>;
      const error = (sanitized as { error: { message: string; provider: string } }).error;
      expect(error.message).not.toMatch(/gemini/i);
      expect(error.message).not.toContain('googleapis.com');
    });

    it('sanitizes string body', () => {
      expect(sanitizeErrorBody('Supabase error')).not.toMatch(/supabase/i);
    });

    it('passes through non-string, non-object values', () => {
      expect(sanitizeErrorBody(42)).toBe(42);
      expect(sanitizeErrorBody(null)).toBe(null);
      expect(sanitizeErrorBody(true)).toBe(true);
    });

    it('sanitizes arrays', () => {
      const body = ['Gemini failed', 'Stripe error'];
      const sanitized = sanitizeErrorBody(body) as string[];
      expect(sanitized[0]).not.toMatch(/gemini/i);
      expect(sanitized[1]).not.toMatch(/stripe/i);
    });
  });
});
