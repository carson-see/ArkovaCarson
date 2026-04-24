/**
 * Rules Engine Zod schema tests (ARK-105 — SCRUM-1017).
 *
 * Red-Green-Refactor: these were written alongside schemas.ts to pin the AC
 * behavior before any downstream code (worker in ARK-106, wizard in ARK-108)
 * could consume the schema.
 */

import { describe, expect, it } from 'vitest';

import {
  ActionConfig,
  CreateOrgRuleInput,
  TriggerConfig,
  assertNoInlineSecrets,
  validateRuleConfigs,
} from './schemas.js';

describe('TriggerConfig discriminator', () => {
  it('accepts a well-formed ESIGN_COMPLETED trigger', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'ESIGN_COMPLETED',
      config: {
        vendors: ['docusign'],
        sender_email_equals: 'legal@acme.com',
      },
    });
    expect(parsed.trigger_type).toBe('ESIGN_COMPLETED');
  });

  it('rejects ESIGN_COMPLETED with a non-ENUM vendor', () => {
    expect(() =>
      TriggerConfig.parse({
        trigger_type: 'ESIGN_COMPLETED',
        config: { vendors: ['hellosign'] },
      }),
    ).toThrow();
  });

  it('accepts a semantic_match threshold at the lower bound', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      config: {
        semantic_match: { description: 'match NDAs', threshold: 0.5 },
      },
    });
    if (parsed.trigger_type !== 'WORKSPACE_FILE_MODIFIED') throw new Error('narrow');
    expect(parsed.config.semantic_match?.threshold).toBe(0.5);
  });

  it('applies default threshold 0.75 when omitted', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      config: { semantic_match: { description: 'match NDAs' } },
    });
    if (parsed.trigger_type !== 'WORKSPACE_FILE_MODIFIED') throw new Error('narrow');
    expect(parsed.config.semantic_match?.threshold).toBe(0.75);
  });

  it('accepts a single Google Drive folder binding config', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      config: {
        vendors: ['google_drive'],
        type: 'drive_folder',
        folder_id: 'folder-123',
        watch_channel_id: 'channel-123',
      },
    });
    if (parsed.trigger_type !== 'WORKSPACE_FILE_MODIFIED') throw new Error('narrow');
    expect(parsed.config.folder_id).toBe('folder-123');
  });

  it('accepts multiple Google Drive folder bindings per rule', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      config: {
        vendors: ['google_drive'],
        drive_folders: [
          { type: 'drive_folder', folder_id: 'folder-a', folder_name: 'Legal' },
          { type: 'drive_folder', folder_id: 'folder-b', folder_path: '/HR/Contracts' },
        ],
      },
    });
    if (parsed.trigger_type !== 'WORKSPACE_FILE_MODIFIED') throw new Error('narrow');
    expect(parsed.config.drive_folders).toHaveLength(2);
  });

  it('rejects a Drive folder binding without folder_id', () => {
    expect(() =>
      TriggerConfig.parse({
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        config: {
          drive_folders: [{ type: 'drive_folder' }],
        },
      }),
    ).toThrow();
  });

  it('rejects semantic_match threshold above 1.0', () => {
    expect(() =>
      TriggerConfig.parse({
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        config: { semantic_match: { description: 'x', threshold: 1.5 } },
      }),
    ).toThrow();
  });

  it('accepts QUEUE_DIGEST with cron + timezone', () => {
    const parsed = TriggerConfig.parse({
      trigger_type: 'QUEUE_DIGEST',
      config: {
        cron: '0 9,16 * * 1-5',
        timezone: 'America/New_York',
      },
    });
    expect(parsed.trigger_type).toBe('QUEUE_DIGEST');
  });

  it('rejects QUEUE_DIGEST with an empty cron', () => {
    expect(() =>
      TriggerConfig.parse({
        trigger_type: 'QUEUE_DIGEST',
        config: { cron: '', timezone: 'UTC' },
      }),
    ).toThrow();
  });

  it('rejects CONNECTOR_DOCUMENT_RECEIVED with an unknown connector', () => {
    expect(() =>
      TriggerConfig.parse({
        trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
        config: { connector_type: 'pandadoc' },
      }),
    ).toThrow();
  });
});

describe('ActionConfig discriminator', () => {
  it('accepts NOTIFY with email channel and recipient emails', () => {
    const parsed = ActionConfig.parse({
      action_type: 'NOTIFY',
      config: {
        channels: ['email'],
        recipient_emails: ['bob@acme.com', 'alice@acme.com'],
      },
    });
    expect(parsed.action_type).toBe('NOTIFY');
  });

  it('rejects NOTIFY with zero channels', () => {
    expect(() =>
      ActionConfig.parse({
        action_type: 'NOTIFY',
        config: { channels: [] },
      }),
    ).toThrow();
  });

  it('rejects FORWARD_TO_URL with a malformed (non-URL) target_url string', () => {
    // CIBA-HARDEN-05: title used to claim this test enforced HTTPS, but
    // z.string().url() accepts http://. The actual HTTPS / domain-allowlist
    // enforcement happens at runtime against org settings — this test only
    // pins the *shape*: target_url must parse as a URL, malformed rejected.
    expect(() =>
      ActionConfig.parse({
        action_type: 'FORWARD_TO_URL',
        config: {
          target_url: 'not a url',
          hmac_secret_handle: 'sm:acme_forward_secret',
        },
      }),
    ).toThrow();
  });

  it('rejects FORWARD_TO_URL with a non-handle secret', () => {
    expect(() =>
      ActionConfig.parse({
        action_type: 'FORWARD_TO_URL',
        config: {
          target_url: 'https://example.com/hook',
          hmac_secret_handle: 'my-raw-secret-value',
        },
      }),
    ).toThrow();
  });

  it('applies default FLAG_COLLISION window of 5 minutes', () => {
    const parsed = ActionConfig.parse({
      action_type: 'FLAG_COLLISION',
      config: {},
    });
    if (parsed.action_type !== 'FLAG_COLLISION') throw new Error('wrong branch');
    expect(parsed.config.window_minutes).toBe(5);
  });

  it('caps NOTIFY recipient lists at 50 each', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `user${i}@acme.com`);
    expect(() =>
      ActionConfig.parse({
        action_type: 'NOTIFY',
        config: { channels: ['email'], recipient_emails: tooMany },
      }),
    ).toThrow();
  });
});

describe('CreateOrgRuleInput + validateRuleConfigs', () => {
  it('accepts a valid input end-to-end', () => {
    const input = CreateOrgRuleInput.parse({
      org_id: '00000000-0000-0000-0000-000000000001',
      name: 'Anchor every DocuSign contract',
      description: 'Anchor DocuSign envelopes where the filename contains "contract"',
      trigger_type: 'ESIGN_COMPLETED',
      trigger_config: { vendors: ['docusign'], filename_contains: 'contract' },
      action_type: 'AUTO_ANCHOR',
      action_config: { tag: 'docusign-contracts' },
    });
    expect(() => validateRuleConfigs(input)).not.toThrow();
    expect(input.enabled).toBe(false); // defaults to false — never auto-enabled
  });

  it('rejects a rule with a 101-char name', () => {
    expect(() =>
      CreateOrgRuleInput.parse({
        org_id: '00000000-0000-0000-0000-000000000001',
        name: 'x'.repeat(101),
        trigger_type: 'MANUAL_UPLOAD',
        trigger_config: {},
        action_type: 'AUTO_ANCHOR',
        action_config: {},
      }),
    ).toThrow();
  });

  it('catches mismatched trigger_type / trigger_config in validateRuleConfigs', () => {
    const input = CreateOrgRuleInput.parse({
      org_id: '00000000-0000-0000-0000-000000000001',
      name: 'Mismatched rule',
      trigger_type: 'QUEUE_DIGEST', // needs cron + timezone
      trigger_config: {}, // missing required fields
      action_type: 'NOTIFY',
      action_config: { channels: ['email'], recipient_emails: ['x@y.com'] },
    });
    expect(() => validateRuleConfigs(input)).toThrow();
  });
});

describe('assertNoInlineSecrets', () => {
  it('passes for configs with only handles', () => {
    expect(() =>
      assertNoInlineSecrets({
        target_url: 'https://example.com',
        hmac_secret_handle: 'sm:acme_secret',
      }),
    ).not.toThrow();
  });

  it('rejects a config that looks like it has an api_key inline', () => {
    expect(() =>
      assertNoInlineSecrets({
        some_field: 'api_key: abc123def',
      }),
    ).toThrow(/Inline secret/);
  });

  it('rejects a config with a nested token', () => {
    expect(() =>
      assertNoInlineSecrets({
        auth: { token: 'xoxb-real-token-value' },
      }),
    ).toThrow(/Inline secret/);
  });

  it('does not flag the literal word "token" without a colon-value pattern', () => {
    expect(() =>
      assertNoInlineSecrets({
        description: 'This rule describes how we handle tokens as concept',
      }),
    ).not.toThrow();
  });
});
