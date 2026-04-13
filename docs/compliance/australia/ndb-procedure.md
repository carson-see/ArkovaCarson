# Australia Notifiable Data Breach (NDB) Procedure

> **Version:** 1.0 | **Date:** 2026-04-12 | **Classification:** CONFIDENTIAL
> **Legal Reference:** Privacy Act 1988 Part IIIC (Sections 26WA-26WR)
> **Jira:** SCRUM-579 (REG-18) | **Owner:** Arkova Legal
> **Integrated into:** Unified Breach Procedure (REG-13, operational runbook Section 14)

---

## 1. Overview

The Notifiable Data Breaches (NDB) scheme requires entities covered by the Australian Privacy Act to notify affected individuals and the OAIC when a data breach is likely to result in serious harm.

---

## 2. Eligible Data Breach Definition (Section 26WE)

A data breach is "eligible" when:
1. There is unauthorized access to, or disclosure of, personal information; AND
2. A reasonable person would conclude the access/disclosure is **likely to result in serious harm** to any of the affected individuals; AND
3. The entity has not been able to prevent the likely risk of serious harm through remedial action.

---

## 3. Assessment Procedure (30-Day Window)

Upon becoming aware of grounds to suspect an eligible data breach, Arkova has **30 calendar days** to complete an assessment.

| Day | Action | Owner |
|-----|--------|-------|
| T+0 | Incident detected; grounds to suspect eligible breach identified | On-call engineer |
| T+0 | Assessment clock starts; incident log created | Security Lead |
| T+1-5 | Initial investigation: scope, affected records, Australian data subjects identified | Engineering + Security |
| T+5-15 | Harm assessment: types of information, risk factors, remedial actions taken | Legal + Security |
| T+15-25 | Decision: eligible data breach or not? Document reasoning | DPO + Legal |
| T+25-30 | If eligible: prepare OAIC notification and individual notifications | DPO |
| T+30 | **DEADLINE:** Assessment must be complete. If eligible, notification must be sent | DPO |

### Harm Assessment Factors (Section 26WG)

Consider:
- Kind(s) of information involved (health info = higher risk)
- Sensitivity of the information
- Whether the information is protected by security measures (encryption, hashing)
- The person(s) who have obtained or could obtain the information
- The nature of the harm that could result

---

## 4. OAIC Notification (Section 26WK)

### Required Content

The notification to the OAIC must include:

1. **Identity and contact details** of the entity (Arkova, Inc.)
2. **Description of the breach** — what happened and when
3. **Kind(s) of information** involved in the breach
4. **Recommendations** about the steps individuals should take in response

### Submission Method

OAIC notifications are submitted via the online Notifiable Data Breach form:
https://www.oaic.gov.au/privacy/notifiable-data-breaches/report-a-data-breach

---

## 5. Individual Notification (Section 26WL)

### Required Content

The notification to each affected individual must include:

1. **Identity and contact details** of the entity
2. **Description of the eligible data breach**
3. **Kind(s) of information** concerned
4. **Recommendations** about steps the individual should take

### Template

```
Subject: Important Privacy Notification — Data Breach

Dear [Name / "Valued User"],

Arkova, Inc. is writing to notify you of a data breach that may
have affected your personal information, as required under the
Australian Privacy Act 1988 (Notifiable Data Breaches scheme).

WHAT HAPPENED:
[Description of the breach]

DATE OF BREACH:
[Date or approximate date]

INFORMATION INVOLVED:
[Specific types of personal information affected]

WHAT WE RECOMMEND YOU DO:
1. [Specific, actionable recommendation]
2. [Specific, actionable recommendation]
3. Monitor your accounts for any unusual activity

WHAT WE ARE DOING:
[Steps taken to contain the breach]
[Steps taken to prevent recurrence]

FURTHER INFORMATION:
If you have questions or concerns, please contact us:
  Email: privacy@arkova.ai
  Phone: [Phone]

You also have the right to lodge a complaint with the Office of
the Australian Information Commissioner:
  Website: https://www.oaic.gov.au/privacy/privacy-complaints
  Phone: 1300 363 992

We sincerely apologize for any inconvenience or concern.

Sincerely,
Carson Seeger
CEO, Arkova, Inc.
```

---

## 6. Record Keeping

Maintain records of:
- All suspected data breaches (whether eligible or not)
- Assessment process and reasoning for each determination
- All notifications sent to OAIC and individuals
- Remedial actions taken

Records retained for a minimum of 5 years.

---

## 7. Integration with Unified Breach Procedure

This NDB-specific procedure is integrated into the unified multi-jurisdiction breach procedure (operational runbook Section 14). When a breach affects Australian data subjects alongside other jurisdictions:

1. The 30-day NDB assessment runs **in parallel** with other jurisdiction notifications
2. Kenya/Nigeria 72-hour and GDPR 72-hour deadlines are met first
3. HIPAA 60-day deadline runs in parallel
4. Australia NDB assessment completed within 30 days
5. If eligible: OAIC + individual notifications sent immediately after assessment
