/**
 * Rule Template Gallery (UX-01 — SCRUM-1027)
 *
 * Static, pre-baked rule starter packs surfaced in the admin onboarding
 * wizard. Each template maps directly to the POST /api/rules payload shape
 * from services/worker/src/rules/schemas.ts — selecting one lets a
 * non-technical admin ship a working automation in a single click.
 *
 * Rules ship disabled (SEC-02 defense). The onboarding flow transitions the
 * admin to the rules list so they flip the toggle after eyeballing the
 * generated config.
 */

export interface RuleTemplate {
  id: string;
  /** Card headline — plain language, no jargon. */
  title: string;
  /** 1–2 sentence pitch. */
  pitch: string;
  /** Emoji or lucide-react icon name (rendered by the wizard). */
  icon: string;
  /** Request body fields for POST /api/rules (minus org_id, which the wizard fills). */
  rule: {
    name: string;
    description: string;
    trigger_type: string;
    trigger_config: Record<string, unknown>;
    action_type: string;
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
