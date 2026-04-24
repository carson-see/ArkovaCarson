# v1 Deprecation Customer Communication Plan

Last updated: 2026-04-24

## Audience

All active v1 API-key holders, defined as API keys with successful `/api/v1` traffic in the last 90 days or keys created in the last 90 days.

## Required Human Action

Codex must not send production customer email. Carson or the release owner sends the blast from the approved customer communication system and stores delivery receipts as SOC 2 evidence.

## Evidence to Retain

- Export criteria and timestamp.
- Final email body.
- Delivery receipt CSV or provider export.
- Bounce and unsubscribe report.
- Link to the PR that added the production `Deprecation` header.

## Email Template

Subject: Arkova API v1 deprecation calendar and v2 migration guide

Body:

Hello,

Arkova API v2 is now generally available. API v1 is entering a 12-month deprecation period and will remain available for security and reliability fixes until the published cutoff.

Important dates:

- API v2 GA: 2026-04-24
- v1 deprecation headers begin: 2026-04-24
- v1 sunset and hard cutoff: 2027-04-23 00:00:00 GMT

Your v1 responses will now include:

```http
Deprecation: Sun, 23 Apr 2027 00:00:00 GMT; link="<https://arkova.ai/docs/v2-migration>; rel=successor-version"
```

Migration guide: https://arkova.ai/docs/v2-migration

Recommended next steps:

1. Create a v2-scoped API key.
2. Move verification lookups to `/api/v2/anchors/{public_id}` or `/api/v2/verify/{fingerprint}`.
3. Update retry handling to honor `Retry-After`.
4. Confirm your integration has no `/api/v1` traffic before 2027-04-23.

Reply to this message if you need help planning the cutover.

Arkova Engineering

## Send Checklist

1. Export active v1 API-key holders.
2. Send the email from the approved system.
3. Store delivery receipts with release evidence.
4. Add a PR comment confirming the send and evidence location.
5. Update Jira SCRUM-1110 with the evidence link.
