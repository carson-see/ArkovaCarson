# Africa Jurisdiction Readiness Matrix for HakiChain

**Date:** 2026-04-24
**Jira:** SCRUM-1175
**Confluence:** https://arkova.atlassian.net/wiki/spaces/A/pages/26673153/SCRUM-1175+-+HAKI-REQ-06+Africa+jurisdiction+readiness+matrix+for+HakiChain+pilot
**Status:** Drafted for counsel review
**Scope:** Kenya, Uganda, Tanzania, Rwanda, Nigeria, Ghana, and cross-border HakiChain workflows

This matrix is a product/compliance readiness tool, not legal advice. It identifies what Arkova can safely claim today, what is already covered by REG artifacts, and what must be reviewed before HakiChain processes production personal data from each country.

## Launch recommendation

| Jurisdiction | Readiness | Recommendation |
| --- | --- | --- |
| Kenya | Partially ready | Use as the first target after ODPC filing path and HakiChain local-support handoff are approved. |
| Nigeria | Partially documented, not filed | Defer production data until NDPC registration, SCC execution, and Nigeria privacy notice are ready. |
| Uganda | Not ready | File REG follow-up before production processing. |
| Tanzania | Not ready | File REG follow-up before production processing. |
| Rwanda | Not ready | File REG follow-up before production processing, especially for outside-Rwanda storage/transfer. |
| Ghana | Not ready | File REG follow-up before production processing. |
| International/multi-jurisdiction | Partially ready | Demo with synthetic data is fine; production needs per-country launch gates. |

## Matrix

| Country | Primary regulator / law | Existing Arkova coverage | Registration / filing posture | Transfer posture | Breach posture | Product implication |
| --- | --- | --- | --- | --- | --- | --- |
| Kenya | ODPC; Data Protection Act, 2019; Registration Regulations, 2021 | REG-15/16, ODPC packet, DPIA, Kenya privacy notice, residency options | Registration packet drafted; local filing/DPO/fee/submission still external | SCCs and Kenya-specific transfer analysis documented | Existing Arkova docs track 72h ODPC posture | Kenya is the best first production candidate, but only after SCRUM-1176 human filing path is approved. |
| Nigeria | NDPC; Nigeria Data Protection Act, 2023 | REG-23/24/25 docs and Nigeria SCC annex exist | NDPC registration not started; major-importance assessment and DPO needed | US has no known NDPC adequacy; use SCCs/contract basis pending counsel review | Local docs use 48h processor to controller and 72h controller to NDPC | Do not process Nigerian production data until existing Nigeria REG work is reviewed and filed. |
| Uganda | Personal Data Protection Office under NITA-U; Data Protection and Privacy Act/Regulations | No Arkova country pack yet | PDPO guidance says data collectors, processors, and controllers register; applies broadly including outside Uganda in public guidance | Cross-border posture needs counsel review; recent PDPO enforcement emphasis makes this higher-risk | PDPO publishes breach notification form and annual compliance-report guidance | File Uganda REG follow-up before production launch. |
| Tanzania | Personal Data Protection Commission; Personal Data Protection Act No. 11 of 2022 | No Arkova country pack yet | PDPC registration is active for data controllers/processors | PDPC materials reference permits for data crossing borders; exact path needs counsel review | PDPC publishes data-breach notification template; timeline needs counsel review | File Tanzania REG follow-up before production launch. |
| Rwanda | NCSA / Data Protection and Privacy Office; Law No 058/2021 | No Arkova country pack yet | NCSA registration required for controllers/processors processing data of people in Rwanda | Rwanda has explicit outside-Rwanda transfer/storage authorization services | Gazette/articles cover personal data breach notification/reporting; counsel should pin exact timing | File Rwanda REG follow-up before production launch; this is a strong blocker if data is stored outside Rwanda. |
| Ghana | Data Protection Commission; Data Protection Act, 2012 (Act 843) | No Arkova country pack yet | DPC says all entities processing personal data must register; unregistered controllers cannot process personal data | Transfer posture needs Ghana counsel review | DPC runs breach-reporting channel; statutory timing needs counsel review | File Ghana REG follow-up before production launch. |

## Follow-up stories to file or keep linked

| Country | Jira action |
| --- | --- |
| Uganda | File REG story for PDPO registration, privacy notice, transfer posture, breach procedure. |
| Tanzania | File REG story for PDPC registration, outside-country transfer/permit analysis, breach procedure. |
| Rwanda | File REG story for NCSA registration and outside-Rwanda transfer/storage authorization. |
| Ghana | File REG story for DPC registration, privacy notice, transfer posture, breach procedure. |
| Nigeria | Continue REG-23/24/25; no duplicate HakiChain ticket needed unless HakiChain becomes first Nigerian customer. |
| Kenya | Continue SCRUM-1176 and REG-15/16; HakiChain local support is the new coordination path. |

## Country notes

### Kenya

Arkova has the strongest documentation here. The Kenya ODPC filing checklist, registration packet, DPIA, privacy notice, SCC annex, and residency-options document already exist. The practical blocker is external: DPO designation, counsel/local representative path, fee, and ODPC submission.

HakiChain's offer to help locally should be treated as a coordination channel, not as authority to file anything automatically.

### Nigeria

Nigeria has existing REG docs, including NDPC registration and cross-border SCCs. The gap is execution: register if Arkova is a data controller/processor of major importance, appoint/confirm DPO path, execute SCCs with Nigerian institutional customers, publish Nigeria privacy notice, and confirm annual audit obligations.

### Uganda

Uganda should not be included in production launch claims yet. PDPO registration guidance and breach/reporting materials exist, and public commentary from PDPO reinforces active enforcement. The required Arkova work is a small REG pack: registration assessment, cross-border transfer position, privacy notice language, breach procedure, and customer onboarding disclosure.

### Tanzania

Tanzania's PDPC is active and registers data controllers/processors. PDPC materials also reference permits for data crossing borders. Arkova needs counsel to confirm whether HakiChain workflows require registration, transfer permit, both, or a customer-controller path before production launch.

### Rwanda

Rwanda is a high-attention jurisdiction because official NCSA/DPO materials call out registration and outside-Rwanda storage/transfer authorization. Since Arkova currently uses US/EU infrastructure, this should be treated as blocked until counsel confirms the authorization path.

### Ghana

Ghana's Data Protection Commission states that all entities processing personal data must register, and Act 843 prohibits unregistered controllers from processing personal data. Arkova has no Ghana-specific pack today, so production Ghana data should wait.

## Sources checked

- Kenya ODPC registration regulations and FAQ: https://www.odpc.go.ke/faqs/ and https://www.odpc.go.ke/wp-content/uploads/2024/03/THE-DATA-PROTECTION-REGISTRATION-OF-DATA-CONTROLLERS-AND-DATA-PROCESSORS-REGULATIONS-2021.pdf
- Nigeria NDPC and NDPA 2023: https://www.ndpc.gov.ng/ and https://ndpc.gov.ng/wp-content/uploads/2024/03/Nigeria_Data_Protection_Act_2023.pdf
- Uganda PDPO registration guidance and breach/compliance forms: https://pdpo.go.ug/media/2022/01/20102021105143-Registration_Classification_and_Guidance_Notes.pdf, https://pdpo.go.ug/media/2022/02/Form_7_-_Notification_of_Data_Breach.pdf, and https://pdpo.go.ug/media/2024/01/Guidance-Note-on-Completion-of-the-Annual-DPP-Compliance-Report.pdf
- Tanzania PDPC registration, Act, and public notices: https://www.pdpc.go.tz/en/registration-data-controller-processor/, https://www.pdpc.go.tz/media/media/THE_PERSONAL_DATA_PROTECTION_ACT.pdf, and https://www.pdpc.go.tz/media/media/DATA_BREACH_NOTIFICATION_TEMPLATE.pdf
- Rwanda NCSA/DPO registration and law materials: https://cyber.gov.rw/updates/article/faq-personal-data-protection-and-privacy-law/, https://dpo.gov.rw/assets/documents/registration-guide-for-data-controller-and-processor.pdf, and https://cyber.gov.rw/fileadmin/user_upload/NCSA/Documents/Laws/OG_Special_of_15.10.2021_Amakuru_bwite.pdf
- Ghana DPC registration, breach reporting, and Act 843: https://dataprotection.org.gh/registration/, https://dataprotection.org.gh/report-a-breach/, and https://dataprotection.org.gh/wp-content/uploads/2025/05/Data-Protection-Act-2012-Act-843.pdf
