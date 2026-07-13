# Sprint 3.3 — Credential Engine continuation escalation packet

> **Status:** DRAFT · **UNSENT** · prepared for Lane 3 and CTO claims review on 2026-07-13.
> **Authority boundary:** the founder reserves the external send. This document authorizes no email, agreement signature, secret access, key rotation, infrastructure change, or Registry action.
> **Relationship owners:** Jeanne Kitchens owns Credential Engine's Developer Integration Program; Jeff Grann is the technical/CTDL counterpart.

## Why this is a new packet

The earlier permanent-key and sandbox request is historical and must not be sent again. Credential Engine answered it on 2026-06-24:

- the Complimentary Evaluation and API Trial Agreement was completed on 2026-06-09;
- the three-month evaluation window ends on **2026-09-09**; the exact expiry instant and timezone remain unconfirmed;
- Credential Engine copied Arkova's account to its sandbox and sent an invite; Arkova's receipt, acceptance, and usable sandbox access are not established by the reviewed artifacts;
- Credential Engine identified Arkova's organization CTID as **`ce-cd077a1e-7691-4519-b653-d46d1245687f`**; this is organization identity evidence, not proof that Arkova or any credential is published or listed;
- the continuing production-access path is the Developer Agreement plus a selected annual support tier; and
- direct CTID retrieval, Graph Search, and offline download remain available consuming options.

The current escalation is therefore a continuation decision and scheduling packet, not another request for a sandbox, an expiry date, or a permanent key.

## Draft external note

**To:** Jeanne Kitchens, Credential Engine

**Cc:** Jeff Grann, Credential Engine

**Subject:** Arkova — continuation before September 9 and July technical follow-up

Hi Jeanne and Jeff,

Thank you for the June 24 confirmation and for copying Arkova's account into the sandbox environment. We have recorded September 9, 2026 as the end of the evaluation window and are preparing the continuation decision with enough lead time to avoid an access gap.

Could you please help us close the remaining continuation details:

1. confirm that the Developer Agreement version and annual support-tier options already shared remain the current path for uninterrupted production consuming access;
2. confirm the activation lead time and the date by which Arkova must return its completed decision to avoid a gap on September 9; and
3. confirm the exact expiry instant and timezone for the current evaluation credentials so our alerting uses the correct timestamp.

We would also like to schedule the July technical follow-up Jeff proposed. That discussion can cover Arkova's consuming architecture, the minimum record fields for a meaningful Registry connection, CTID-not-found handling, and the production-publishing onboarding sequence.

For clarity, Arkova is not representing itself as listed in the Credential Registry, is not representing Registry publishing as live, and will not fabricate credential-level CTIDs. The current evaluation is consuming-oriented; any publishing path remains subject to Credential Engine coordination and its required sandbox and structural review.

Please let us know the current agreement/tier materials, activation lead time, exact expiry timestamp, and a suitable time for the technical follow-up.

Best,

Carson Seeger

Arkova

## Internal truth and claims boundary — not part of the external note

- **Confirmed:** evaluation agreement completed 2026-06-09; evaluation ends 2026-09-09.
- **Unknown:** exact expiry time/timezone; selected Developer Agreement support tier; decision/activation lead time; whether the sandbox invite was received and accepted; whether usable sandbox credentials are in Arkova's custody.
- **Measured in current correspondence:** Jeanne Kitchens owns Credential Engine's Developer Integration Program, Jeff Grann is the technical/CTDL counterpart, and CE named Arkova's organization CTID as `ce-cd077a1e-7691-4519-b653-d46d1245687f`. These facts do not establish that Arkova or any credential is published or listed.
- **Not asserted:** live Registry publishing, a production Registry-consuming client, credential-level CTID issuance, W3C VC issuance, or partner acceptance of Arkova's implementation.
- **Secret hygiene:** no API key or secret value belongs in this packet, a ticket, a log, or a reply thread.
- **Technical decisions:** route implementation, key-custody, alerting, and claims decisions to the CTO. The founder-reserved action is the external send only.

## Pre-send review gate

- [ ] Lane 3 verifies every technical/status statement against current code and the live Jira/Confluence records.
- [ ] CTO approves the technical claims boundary and continuation-risk framing.
- [ ] Business/legal confirms that requesting the current agreement/tier materials does not constitute agreement acceptance.
- [ ] The September 9 alert records an unknown time/timezone rather than inventing an expiry instant.
- [ ] No secret value, raw credential, personal data, or unverified Registry claim is present.
- [ ] Founder chooses whether and when to send.

## Source trace

- Credential Engine shared notes and June 24 response: [Google Doc `17Ix…`](https://docs.google.com/document/d/17IxHYJ6zvDm0vWGkP6swTYRajo-2Ycrltlo52P-oRSA/edit).
- June 16 technical meeting-prep v2: [Google Doc `1joA…`](https://docs.google.com/document/d/1joAiDUGkEz3JcwnlSIhVNGRyNrx3KlKzRUvDQWzHcNA/edit).
- Historical superseded request: `docs/sprint-0/lane3/04-ce-permanent-key-request-DRAFT.md`.
- Custody design and correspondence reconciliation: `docs/sprint-0/lane3/01-ce-key-custody-design.md`.
