#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1306 (R0-7) rule: feedback_jira_user_story_format.
 *
 * Validates Jira ticket format (user story structure, acceptance criteria).
 * This rule is enforced via Atlassian Automation (issue-create rule), not CI.
 * The CI script is a no-op stub that documents the enforcement path.
 *
 * See memory/feedback_jira_user_story_format.md for the rule definition.
 * See docs/jira-workflow/automation-rules.json for the Atlassian Automation config.
 *
 * Always exits 0.
 */

export function run(): { ok: boolean; message: string } {
  return {
    ok: true,
    message:
      '✅ feedback_jira_user_story_format: This rule is enforced via Atlassian Automation, not CI. Skipping.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
}
