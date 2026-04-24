/**
 * Rule Template Gallery (UX-01 — SCRUM-1027). Pre-baked starter packs for
 * the admin onboarding wizard; rules always ship disabled per SEC-02.
 */

// Mirrors services/worker/src/rules/schemas.ts discriminated unions.
// Kept local (not imported) so the frontend bundle stays small; a typo
// surfaces as a Zod 400 from POST /api/rules, which is an acceptable
// integration-test boundary.
export type TriggerType =
  | 'ESIGN_COMPLETED'
  | 'WORKSPACE_FILE_MODIFIED'
  | 'CONNECTOR_DOCUMENT_RECEIVED'
  | 'MANUAL_UPLOAD'
  | 'SCHEDULED_CRON'
  | 'QUEUE_DIGEST'
  | 'EMAIL_INTAKE';

export type ActionType =
  | 'AUTO_ANCHOR'
  | 'FAST_TRACK_ANCHOR'
  | 'QUEUE_FOR_REVIEW'
  | 'FLAG_COLLISION'
  | 'NOTIFY'
  | 'FORWARD_TO_URL';

export type TemplateIconName = 'FileSignature' | 'Users' | 'ClipboardCheck';

export interface RuleTemplate {
  id: string;
  title: string;
  pitch: string;
  icon: TemplateIconName;
  rule: {
    name: string;
    description: string;
    trigger_type: TriggerType;
    trigger_config: Record<string, unknown>;
    action_type: ActionType;
    action_config: Record<string, unknown>;
  };
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'anchor-docusign',
    title: 'Anchor every signed DocuSign contract',
    pitch:
      'When a DocuSign envelope is complete, auto-anchor the final PDF so its fingerprint is on-chain within the hour.',
    icon: 'FileSignature',
    rule: {
      name: 'Anchor all DocuSign completions',
      description:
        'Auto-anchor every DocuSign contract once it is signed by all parties. Tagged for easy filtering in Treasury.',
      trigger_type: 'ESIGN_COMPLETED',
      trigger_config: { vendors: ['docusign'] },
      action_type: 'AUTO_ANCHOR',
      action_config: { tag: 'docusign-auto' },
    },
  },
  {
    id: 'flag-multi-author-drive',
    title: 'Flag multi-author Google Docs for my review',
    pitch:
      'When a file in Google Drive changes, queue it for your review so two versions never go out silently.',
    icon: 'Users',
    rule: {
      name: 'Queue Google Drive changes',
      description:
        'Route every Google Drive modification event into the review queue so you can approve the canonical version before it anchors.',
      trigger_type: 'WORKSPACE_FILE_MODIFIED',
      trigger_config: { vendors: ['google_drive'] },
      action_type: 'QUEUE_FOR_REVIEW',
      action_config: { priority: 'medium' },
    },
  },
  {
    id: 'bgc-daily-digest',
    title: 'Queue every background check for daily review',
    pitch:
      'ATS / background-check partners drop reports; keep them in the queue and email you one digest per day.',
    icon: 'ClipboardCheck',
    rule: {
      name: 'Daily digest of background-check reports',
      description:
        'Background-check connectors land reports in the queue; a 9am digest summarizes the day.',
      trigger_type: 'QUEUE_DIGEST',
      trigger_config: { cron: '0 9 * * *', timezone: 'America/New_York', send_when_empty: false },
      action_type: 'NOTIFY',
      action_config: { channels: ['email'], recipient_emails: [], recipient_user_ids: [] },
    },
  },
] as const;
