/**
 * NCX-07: Compliance Framework Ingest — SOC 2, ISO 27001, NIST 800-53
 *
 * Ingests compliance framework controls as structured reference data.
 * These are static datasets defined inline — no external API calls needed.
 *
 * Frameworks:
 * - SOC 2 Type II: Trust Services Criteria (CC1-CC9, A1, PI1, C1, P1)
 * - ISO 27001:2022 Annex A: 93 controls across 4 themes
 * - NIST 800-53 Rev 5: 20 control families, ~1000 controls
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const INSERT_BATCH_SIZE = 100;

// ============================================================
// SOC 2 Trust Services Criteria
// ============================================================

interface Soc2Control {
  controlId: string;
  controlName: string;
  category: string;
  description: string;
}

export const SOC2_CONTROLS: Soc2Control[] = [
  // CC1: Control Environment
  { controlId: 'CC1.1', controlName: 'COSO Principle 1', category: 'CC1 — Control Environment', description: 'The entity demonstrates a commitment to integrity and ethical values.' },
  { controlId: 'CC1.2', controlName: 'COSO Principle 2', category: 'CC1 — Control Environment', description: 'The board of directors demonstrates independence from management and exercises oversight.' },
  { controlId: 'CC1.3', controlName: 'COSO Principle 3', category: 'CC1 — Control Environment', description: 'Management establishes structures, reporting lines, and authorities.' },
  { controlId: 'CC1.4', controlName: 'COSO Principle 4', category: 'CC1 — Control Environment', description: 'The entity demonstrates a commitment to attract, develop, and retain competent individuals.' },
  { controlId: 'CC1.5', controlName: 'COSO Principle 5', category: 'CC1 — Control Environment', description: 'The entity holds individuals accountable for their internal control responsibilities.' },
  // CC2: Communication and Information
  { controlId: 'CC2.1', controlName: 'COSO Principle 13', category: 'CC2 — Communication and Information', description: 'The entity obtains or generates and uses relevant, quality information.' },
  { controlId: 'CC2.2', controlName: 'COSO Principle 14', category: 'CC2 — Communication and Information', description: 'The entity internally communicates information necessary to support functioning of internal control.' },
  { controlId: 'CC2.3', controlName: 'COSO Principle 15', category: 'CC2 — Communication and Information', description: 'The entity communicates with external parties regarding matters affecting internal control.' },
  // CC3: Risk Assessment
  { controlId: 'CC3.1', controlName: 'COSO Principle 6', category: 'CC3 — Risk Assessment', description: 'The entity specifies objectives with sufficient clarity to enable identification of risks.' },
  { controlId: 'CC3.2', controlName: 'COSO Principle 7', category: 'CC3 — Risk Assessment', description: 'The entity identifies risks to the achievement of its objectives and analyzes risks.' },
  { controlId: 'CC3.3', controlName: 'COSO Principle 8', category: 'CC3 — Risk Assessment', description: 'The entity considers the potential for fraud in assessing risks.' },
  { controlId: 'CC3.4', controlName: 'COSO Principle 9', category: 'CC3 — Risk Assessment', description: 'The entity identifies and assesses changes that could significantly impact internal control.' },
  // CC4: Monitoring Activities
  { controlId: 'CC4.1', controlName: 'COSO Principle 16', category: 'CC4 — Monitoring Activities', description: 'The entity selects, develops, and performs ongoing or separate evaluations.' },
  { controlId: 'CC4.2', controlName: 'COSO Principle 17', category: 'CC4 — Monitoring Activities', description: 'The entity evaluates and communicates internal control deficiencies in a timely manner.' },
  // CC5: Control Activities
  { controlId: 'CC5.1', controlName: 'COSO Principle 10', category: 'CC5 — Control Activities', description: 'The entity selects and develops control activities that mitigate risks.' },
  { controlId: 'CC5.2', controlName: 'COSO Principle 11', category: 'CC5 — Control Activities', description: 'The entity selects and develops general control activities over technology.' },
  { controlId: 'CC5.3', controlName: 'COSO Principle 12', category: 'CC5 — Control Activities', description: 'The entity deploys control activities through policies and procedures.' },
  // CC6: Logical and Physical Access Controls
  { controlId: 'CC6.1', controlName: 'Logical Access Security', category: 'CC6 — Logical and Physical Access', description: 'The entity implements logical access security software, infrastructure, and architectures.' },
  { controlId: 'CC6.2', controlName: 'User Registration and Authorization', category: 'CC6 — Logical and Physical Access', description: 'Prior to issuing system credentials, the entity registers and authorizes new users.' },
  { controlId: 'CC6.3', controlName: 'Role-Based Access', category: 'CC6 — Logical and Physical Access', description: 'The entity authorizes, modifies, or removes access based on roles and responsibilities.' },
  { controlId: 'CC6.4', controlName: 'Physical Access Restrictions', category: 'CC6 — Logical and Physical Access', description: 'The entity restricts physical access to facilities and protected information assets.' },
  { controlId: 'CC6.5', controlName: 'Asset Disposal', category: 'CC6 — Logical and Physical Access', description: 'The entity discontinues logical and physical protections over assets only after transfer.' },
  { controlId: 'CC6.6', controlName: 'External Threat Protection', category: 'CC6 — Logical and Physical Access', description: 'The entity implements logical access security measures to protect against threats from outside boundaries.' },
  { controlId: 'CC6.7', controlName: 'Data Transmission Restriction', category: 'CC6 — Logical and Physical Access', description: 'The entity restricts the transmission, movement, and removal of information.' },
  { controlId: 'CC6.8', controlName: 'Malicious Software Prevention', category: 'CC6 — Logical and Physical Access', description: 'The entity implements controls to prevent or detect and act upon malicious software.' },
  // CC7: System Operations
  { controlId: 'CC7.1', controlName: 'Infrastructure Monitoring', category: 'CC7 — System Operations', description: 'The entity uses detection and monitoring procedures to identify changes to configurations.' },
  { controlId: 'CC7.2', controlName: 'Anomaly Detection', category: 'CC7 — System Operations', description: 'The entity monitors system components for anomalies indicative of malicious acts.' },
  { controlId: 'CC7.3', controlName: 'Security Event Evaluation', category: 'CC7 — System Operations', description: 'The entity evaluates security events to determine whether they could impact achievement of objectives.' },
  { controlId: 'CC7.4', controlName: 'Incident Response', category: 'CC7 — System Operations', description: 'The entity responds to identified security incidents by executing a defined incident response program.' },
  { controlId: 'CC7.5', controlName: 'Incident Recovery', category: 'CC7 — System Operations', description: 'The entity identifies, develops, and implements activities to recover from identified security incidents.' },
  // CC8: Change Management
  { controlId: 'CC8.1', controlName: 'Change Authorization', category: 'CC8 — Change Management', description: 'The entity authorizes, designs, develops, configures, documents, tests, approves, and implements changes.' },
  // CC9: Risk Mitigation
  { controlId: 'CC9.1', controlName: 'Risk Mitigation Activities', category: 'CC9 — Risk Mitigation', description: 'The entity identifies, selects, and develops risk mitigation activities for risks from business processes.' },
  { controlId: 'CC9.2', controlName: 'Vendor Risk Management', category: 'CC9 — Risk Mitigation', description: 'The entity assesses and manages risks associated with vendors and business partners.' },
  // A1: Availability
  { controlId: 'A1.1', controlName: 'Capacity Management', category: 'A1 — Availability', description: 'The entity maintains, monitors, and evaluates current processing capacity and use of system components.' },
  { controlId: 'A1.2', controlName: 'Recovery Planning', category: 'A1 — Availability', description: 'The entity authorizes, designs, develops, and implements environmental protections and recovery infrastructure.' },
  { controlId: 'A1.3', controlName: 'Recovery Testing', category: 'A1 — Availability', description: 'The entity tests recovery plan procedures supporting system recovery to meet its objectives.' },
  // PI1: Processing Integrity
  { controlId: 'PI1.1', controlName: 'Processing Accuracy', category: 'PI1 — Processing Integrity', description: 'The entity obtains or generates, uses, and communicates relevant quality information regarding processing.' },
  { controlId: 'PI1.2', controlName: 'Processing Policies', category: 'PI1 — Processing Integrity', description: 'The entity implements policies and procedures over system processing to result in products and services meeting objectives.' },
  { controlId: 'PI1.3', controlName: 'Input Validation', category: 'PI1 — Processing Integrity', description: 'The entity implements policies and procedures over system inputs to validate completeness and accuracy.' },
  { controlId: 'PI1.4', controlName: 'Output Review', category: 'PI1 — Processing Integrity', description: 'The entity implements policies and procedures to verify that outputs are complete and accurate.' },
  { controlId: 'PI1.5', controlName: 'Data Storage Integrity', category: 'PI1 — Processing Integrity', description: 'The entity implements policies and procedures to store data completely and accurately.' },
  // C1: Confidentiality
  { controlId: 'C1.1', controlName: 'Confidential Information Identification', category: 'C1 — Confidentiality', description: 'The entity identifies and maintains confidential information to meet the entity objectives.' },
  { controlId: 'C1.2', controlName: 'Confidential Information Disposal', category: 'C1 — Confidentiality', description: 'The entity disposes of confidential information to meet the entity objectives related to confidentiality.' },
  // P1: Privacy
  { controlId: 'P1.1', controlName: 'Privacy Notice', category: 'P1 — Privacy', description: 'The entity provides notice to data subjects about its privacy practices.' },
  { controlId: 'P1.2', controlName: 'Choice and Consent', category: 'P1 — Privacy', description: 'The entity communicates choices available regarding collection, use, retention, and disposal of personal information.' },
  { controlId: 'P1.3', controlName: 'Collection Limitation', category: 'P1 — Privacy', description: 'Personal information is collected consistent with the entity objectives related to privacy.' },
  { controlId: 'P1.4', controlName: 'Use and Retention', category: 'P1 — Privacy', description: 'Personal information is limited to the purposes identified in the notice and retained for the period identified.' },
  { controlId: 'P1.5', controlName: 'Access', category: 'P1 — Privacy', description: 'The entity grants identified and authenticated data subjects the ability to access their stored personal information.' },
  { controlId: 'P1.6', controlName: 'Disclosure and Notification', category: 'P1 — Privacy', description: 'Personal information is disclosed to third parties and incidents notified as identified in the notice.' },
  { controlId: 'P1.7', controlName: 'Quality', category: 'P1 — Privacy', description: 'The entity collects and maintains accurate, up-to-date, complete, and relevant personal information.' },
  { controlId: 'P1.8', controlName: 'Monitoring and Enforcement', category: 'P1 — Privacy', description: 'The entity monitors compliance with its privacy commitments and takes corrective action as necessary.' },
];

// ============================================================
// ISO 27001:2022 Annex A Controls
// ============================================================

interface Iso27001Control {
  controlId: string;
  controlName: string;
  theme: string;
  description: string;
}

export const ISO27001_CONTROLS: Iso27001Control[] = [
  // Theme 5: Organizational controls (37 controls)
  { controlId: 'A.5.1', controlName: 'Policies for information security', theme: 'Organizational', description: 'A set of policies for information security shall be defined, approved by management, published and communicated.' },
  { controlId: 'A.5.2', controlName: 'Information security roles and responsibilities', theme: 'Organizational', description: 'Information security roles and responsibilities shall be defined and allocated.' },
  { controlId: 'A.5.3', controlName: 'Segregation of duties', theme: 'Organizational', description: 'Conflicting duties and conflicting areas of responsibility shall be segregated.' },
  { controlId: 'A.5.4', controlName: 'Management responsibilities', theme: 'Organizational', description: 'Management shall require all employees and contractors to apply information security.' },
  { controlId: 'A.5.5', controlName: 'Contact with authorities', theme: 'Organizational', description: 'Appropriate contacts with relevant authorities shall be maintained.' },
  { controlId: 'A.5.6', controlName: 'Contact with special interest groups', theme: 'Organizational', description: 'Appropriate contacts with special interest groups shall be maintained.' },
  { controlId: 'A.5.7', controlName: 'Threat intelligence', theme: 'Organizational', description: 'Information relating to information security threats shall be collected and analyzed.' },
  { controlId: 'A.5.8', controlName: 'Information security in project management', theme: 'Organizational', description: 'Information security shall be integrated into project management.' },
  { controlId: 'A.5.9', controlName: 'Inventory of information and other associated assets', theme: 'Organizational', description: 'An inventory of information and other associated assets shall be developed and maintained.' },
  { controlId: 'A.5.10', controlName: 'Acceptable use of information and other associated assets', theme: 'Organizational', description: 'Rules for the acceptable use of information and other associated assets shall be identified, documented and implemented.' },
  { controlId: 'A.5.11', controlName: 'Return of assets', theme: 'Organizational', description: 'Personnel and other interested parties shall return all organizational assets on change or termination.' },
  { controlId: 'A.5.12', controlName: 'Classification of information', theme: 'Organizational', description: 'Information shall be classified according to the information security needs of the organization.' },
  { controlId: 'A.5.13', controlName: 'Labelling of information', theme: 'Organizational', description: 'An appropriate set of procedures for information labelling shall be developed and implemented.' },
  { controlId: 'A.5.14', controlName: 'Information transfer', theme: 'Organizational', description: 'Information transfer rules, procedures, or agreements shall be in place for all types of transfer.' },
  { controlId: 'A.5.15', controlName: 'Access control', theme: 'Organizational', description: 'Rules to control physical and logical access to information shall be established.' },
  { controlId: 'A.5.16', controlName: 'Identity management', theme: 'Organizational', description: 'The full life cycle of identities shall be managed.' },
  { controlId: 'A.5.17', controlName: 'Authentication information', theme: 'Organizational', description: 'Allocation and management of authentication information shall be controlled.' },
  { controlId: 'A.5.18', controlName: 'Access rights', theme: 'Organizational', description: 'Access rights to information and other associated assets shall be provisioned, reviewed, modified and removed.' },
  { controlId: 'A.5.19', controlName: 'Information security in supplier relationships', theme: 'Organizational', description: 'Processes and procedures shall be defined to manage information security risks associated with suppliers.' },
  { controlId: 'A.5.20', controlName: 'Addressing information security within supplier agreements', theme: 'Organizational', description: 'Relevant information security requirements shall be established with each supplier.' },
  { controlId: 'A.5.21', controlName: 'Managing information security in the ICT supply chain', theme: 'Organizational', description: 'Processes and procedures shall be defined to manage information security risks associated with the ICT supply chain.' },
  { controlId: 'A.5.22', controlName: 'Monitoring, review and change management of supplier services', theme: 'Organizational', description: 'The organization shall regularly monitor, review, evaluate and manage change in supplier information security practices.' },
  { controlId: 'A.5.23', controlName: 'Information security for use of cloud services', theme: 'Organizational', description: 'Processes for acquisition, use, management and exit from cloud services shall be established.' },
  { controlId: 'A.5.24', controlName: 'Information security incident management planning and preparation', theme: 'Organizational', description: 'The organization shall plan and prepare for managing information security incidents.' },
  { controlId: 'A.5.25', controlName: 'Assessment and decision on information security events', theme: 'Organizational', description: 'The organization shall assess information security events and decide if they are to be categorized as incidents.' },
  { controlId: 'A.5.26', controlName: 'Response to information security incidents', theme: 'Organizational', description: 'Information security incidents shall be responded to in accordance with the documented procedures.' },
  { controlId: 'A.5.27', controlName: 'Learning from information security incidents', theme: 'Organizational', description: 'Knowledge gained from information security incidents shall be used to strengthen and improve controls.' },
  { controlId: 'A.5.28', controlName: 'Collection of evidence', theme: 'Organizational', description: 'The organization shall establish and implement procedures for the identification, collection, acquisition and preservation of evidence.' },
  { controlId: 'A.5.29', controlName: 'Information security during disruption', theme: 'Organizational', description: 'The organization shall plan how to maintain information security at an appropriate level during disruption.' },
  { controlId: 'A.5.30', controlName: 'ICT readiness for business continuity', theme: 'Organizational', description: 'ICT readiness shall be planned, implemented, maintained and tested based on business continuity objectives.' },
  { controlId: 'A.5.31', controlName: 'Legal, statutory, regulatory and contractual requirements', theme: 'Organizational', description: 'Legal, statutory, regulatory and contractual requirements relevant to information security shall be identified and documented.' },
  { controlId: 'A.5.32', controlName: 'Intellectual property rights', theme: 'Organizational', description: 'The organization shall implement appropriate procedures to protect intellectual property rights.' },
  { controlId: 'A.5.33', controlName: 'Protection of records', theme: 'Organizational', description: 'Records shall be protected from loss, destruction, falsification, unauthorized access and unauthorized release.' },
  { controlId: 'A.5.34', controlName: 'Privacy and protection of PII', theme: 'Organizational', description: 'The organization shall identify and meet the requirements regarding the preservation of privacy and protection of PII.' },
  { controlId: 'A.5.35', controlName: 'Independent review of information security', theme: 'Organizational', description: 'The organizations approach to managing information security shall be independently reviewed at planned intervals.' },
  { controlId: 'A.5.36', controlName: 'Compliance with policies, rules and standards', theme: 'Organizational', description: 'Compliance with the organizations information security policy and standards shall be regularly reviewed.' },
  { controlId: 'A.5.37', controlName: 'Documented operating procedures', theme: 'Organizational', description: 'Operating procedures for information processing facilities shall be documented and made available.' },
  // Theme 6: People controls (8 controls)
  { controlId: 'A.6.1', controlName: 'Screening', theme: 'People', description: 'Background verification checks on all candidates for employment shall be carried out prior to joining.' },
  { controlId: 'A.6.2', controlName: 'Terms and conditions of employment', theme: 'People', description: 'Employment contractual agreements shall state the employees and organizations responsibilities for information security.' },
  { controlId: 'A.6.3', controlName: 'Information security awareness, education and training', theme: 'People', description: 'Personnel of the organization and relevant interested parties shall receive appropriate information security awareness, education and training.' },
  { controlId: 'A.6.4', controlName: 'Disciplinary process', theme: 'People', description: 'A disciplinary process shall be formalized and communicated to take actions against personnel who have committed violations.' },
  { controlId: 'A.6.5', controlName: 'Responsibilities after termination or change of employment', theme: 'People', description: 'Information security responsibilities and duties that remain valid after termination or change of employment shall be defined.' },
  { controlId: 'A.6.6', controlName: 'Confidentiality or non-disclosure agreements', theme: 'People', description: 'Confidentiality or non-disclosure agreements reflecting the organizations needs for the protection of information shall be identified.' },
  { controlId: 'A.6.7', controlName: 'Remote working', theme: 'People', description: 'Security measures shall be implemented when personnel are working remotely.' },
  { controlId: 'A.6.8', controlName: 'Information security event reporting', theme: 'People', description: 'The organization shall provide a mechanism for personnel to report observed or suspected information security events.' },
  // Theme 7: Physical controls (14 controls)
  { controlId: 'A.7.1', controlName: 'Physical security perimeters', theme: 'Physical', description: 'Security perimeters shall be defined and used to protect areas that contain information and other associated assets.' },
  { controlId: 'A.7.2', controlName: 'Physical entry', theme: 'Physical', description: 'Secure areas shall be protected by appropriate entry controls to ensure that only authorized personnel are allowed access.' },
  { controlId: 'A.7.3', controlName: 'Securing offices, rooms and facilities', theme: 'Physical', description: 'Physical security for offices, rooms and facilities shall be designed and implemented.' },
  { controlId: 'A.7.4', controlName: 'Physical security monitoring', theme: 'Physical', description: 'Premises shall be continuously monitored for unauthorized physical access.' },
  { controlId: 'A.7.5', controlName: 'Protecting against physical and environmental threats', theme: 'Physical', description: 'Protection against physical and environmental threats shall be designed and implemented.' },
  { controlId: 'A.7.6', controlName: 'Working in secure areas', theme: 'Physical', description: 'Security measures for working in secure areas shall be designed and implemented.' },
  { controlId: 'A.7.7', controlName: 'Clear desk and clear screen', theme: 'Physical', description: 'Clear desk rules for papers and clear screen rules for information processing facilities shall be defined.' },
  { controlId: 'A.7.8', controlName: 'Equipment siting and protection', theme: 'Physical', description: 'Equipment shall be sited and protected to reduce the risks from physical and environmental threats.' },
  { controlId: 'A.7.9', controlName: 'Security of assets off-premises', theme: 'Physical', description: 'Off-site assets shall be protected.' },
  { controlId: 'A.7.10', controlName: 'Storage media', theme: 'Physical', description: 'Storage media shall be managed through their life cycle of acquisition, use, transportation and disposal.' },
  { controlId: 'A.7.11', controlName: 'Supporting utilities', theme: 'Physical', description: 'Information processing facilities shall be protected from power failures and other disruptions.' },
  { controlId: 'A.7.12', controlName: 'Cabling security', theme: 'Physical', description: 'Cables carrying power, data or supporting information services shall be protected from interception, interference or damage.' },
  { controlId: 'A.7.13', controlName: 'Equipment maintenance', theme: 'Physical', description: 'Equipment shall be maintained correctly to ensure availability, integrity and confidentiality of information.' },
  { controlId: 'A.7.14', controlName: 'Secure disposal or re-use of equipment', theme: 'Physical', description: 'Items of equipment containing storage media shall be verified to ensure that sensitive data and licensed software has been removed or overwritten.' },
  // Theme 8: Technological controls (34 controls)
  { controlId: 'A.8.1', controlName: 'User endpoint devices', theme: 'Technological', description: 'Information stored on, processed by or accessible via user endpoint devices shall be protected.' },
  { controlId: 'A.8.2', controlName: 'Privileged access rights', theme: 'Technological', description: 'The allocation and use of privileged access rights shall be restricted and managed.' },
  { controlId: 'A.8.3', controlName: 'Information access restriction', theme: 'Technological', description: 'Access to information and other associated assets shall be restricted in accordance with the established access control policy.' },
  { controlId: 'A.8.4', controlName: 'Access to source code', theme: 'Technological', description: 'Read and write access to source code, development tools and software libraries shall be appropriately managed.' },
  { controlId: 'A.8.5', controlName: 'Secure authentication', theme: 'Technological', description: 'Secure authentication technologies and procedures shall be established and implemented.' },
  { controlId: 'A.8.6', controlName: 'Capacity management', theme: 'Technological', description: 'The use of resources shall be monitored and adjusted in line with current and expected capacity requirements.' },
  { controlId: 'A.8.7', controlName: 'Protection against malware', theme: 'Technological', description: 'Protection against malware shall be implemented and supported by appropriate user awareness.' },
  { controlId: 'A.8.8', controlName: 'Management of technical vulnerabilities', theme: 'Technological', description: 'Information about technical vulnerabilities of information systems shall be obtained, exposure evaluated and appropriate measures taken.' },
  { controlId: 'A.8.9', controlName: 'Configuration management', theme: 'Technological', description: 'Configurations, including security configurations, of hardware, software, services and networks shall be established, documented, implemented, monitored and reviewed.' },
  { controlId: 'A.8.10', controlName: 'Information deletion', theme: 'Technological', description: 'Information stored in information systems, devices or in any other storage media shall be deleted when no longer required.' },
  { controlId: 'A.8.11', controlName: 'Data masking', theme: 'Technological', description: 'Data masking shall be used in accordance with the organizations topic-specific policy on access control and business requirements.' },
  { controlId: 'A.8.12', controlName: 'Data leakage prevention', theme: 'Technological', description: 'Data leakage prevention measures shall be applied to systems, networks and any other devices that process, store or transmit sensitive information.' },
  { controlId: 'A.8.13', controlName: 'Information backup', theme: 'Technological', description: 'Backup copies of information, software and systems shall be maintained and regularly tested.' },
  { controlId: 'A.8.14', controlName: 'Redundancy of information processing facilities', theme: 'Technological', description: 'Information processing facilities shall be implemented with redundancy sufficient to meet availability requirements.' },
  { controlId: 'A.8.15', controlName: 'Logging', theme: 'Technological', description: 'Logs that record activities, exceptions, faults and other relevant events shall be produced, stored, protected and analyzed.' },
  { controlId: 'A.8.16', controlName: 'Monitoring activities', theme: 'Technological', description: 'Networks, systems and applications shall be monitored for anomalous behaviour and appropriate actions taken.' },
  { controlId: 'A.8.17', controlName: 'Clock synchronization', theme: 'Technological', description: 'The clocks of information processing systems used by the organization shall be synchronized to approved time sources.' },
  { controlId: 'A.8.18', controlName: 'Use of privileged utility programs', theme: 'Technological', description: 'The use of utility programs that might be capable of overriding system and application controls shall be restricted.' },
  { controlId: 'A.8.19', controlName: 'Installation of software on operational systems', theme: 'Technological', description: 'Procedures and measures shall be implemented to securely manage software installation on operational systems.' },
  { controlId: 'A.8.20', controlName: 'Networks security', theme: 'Technological', description: 'Networks and network devices shall be secured, managed and controlled to protect information in systems and applications.' },
  { controlId: 'A.8.21', controlName: 'Security of network services', theme: 'Technological', description: 'Security mechanisms, service levels and service requirements of network services shall be identified, implemented and monitored.' },
  { controlId: 'A.8.22', controlName: 'Segregation of networks', theme: 'Technological', description: 'Groups of information services, users and information systems shall be segregated in the organizations networks.' },
  { controlId: 'A.8.23', controlName: 'Web filtering', theme: 'Technological', description: 'Access to external websites shall be managed to reduce exposure to malicious content.' },
  { controlId: 'A.8.24', controlName: 'Use of cryptography', theme: 'Technological', description: 'Rules for the effective use of cryptography, including cryptographic key management, shall be defined and implemented.' },
  { controlId: 'A.8.25', controlName: 'Secure development life cycle', theme: 'Technological', description: 'Rules for the secure development of software and systems shall be established and applied.' },
  { controlId: 'A.8.26', controlName: 'Application security requirements', theme: 'Technological', description: 'Information security requirements shall be identified, specified and approved when developing or acquiring applications.' },
  { controlId: 'A.8.27', controlName: 'Secure system architecture and engineering principles', theme: 'Technological', description: 'Principles for engineering secure systems shall be established, documented, maintained and applied.' },
  { controlId: 'A.8.28', controlName: 'Secure coding', theme: 'Technological', description: 'Secure coding principles shall be applied to software development.' },
  { controlId: 'A.8.29', controlName: 'Security testing in development and acceptance', theme: 'Technological', description: 'Security testing processes shall be defined and implemented in the development life cycle.' },
  { controlId: 'A.8.30', controlName: 'Outsourced development', theme: 'Technological', description: 'The organization shall direct, monitor and review the activities related to outsourced system development.' },
  { controlId: 'A.8.31', controlName: 'Separation of development, test and production environments', theme: 'Technological', description: 'Development, testing and production environments shall be separated.' },
  { controlId: 'A.8.32', controlName: 'Change management', theme: 'Technological', description: 'Changes to information processing facilities and information systems shall be subject to change management procedures.' },
  { controlId: 'A.8.33', controlName: 'Test information', theme: 'Technological', description: 'Test information shall be appropriately selected, protected and managed.' },
  { controlId: 'A.8.34', controlName: 'Protection of information systems during audit testing', theme: 'Technological', description: 'Audit tests and other assurance activities involving assessment of operational systems shall be planned and agreed.' },
];

// ============================================================
// NIST 800-53 Rev 5 Control Families
// ============================================================

interface NistControl {
  controlId: string;
  controlName: string;
  description: string;
}

interface NistFamily {
  familyId: string;
  familyName: string;
  controls: NistControl[];
}

export const NIST_800_53_FAMILIES: NistFamily[] = [
  {
    familyId: 'AC',
    familyName: 'Access Control',
    controls: [
      { controlId: 'AC-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate access control policy and procedures.' },
      { controlId: 'AC-2', controlName: 'Account Management', description: 'Define and document account types; create, enable, modify, disable, and remove accounts.' },
      { controlId: 'AC-3', controlName: 'Access Enforcement', description: 'Enforce approved authorizations for logical access to information and system resources.' },
      { controlId: 'AC-4', controlName: 'Information Flow Enforcement', description: 'Enforce approved authorizations for controlling the flow of information within the system and between systems.' },
      { controlId: 'AC-5', controlName: 'Separation of Duties', description: 'Identify and document duties of individuals requiring separation; define system access authorizations.' },
      { controlId: 'AC-6', controlName: 'Least Privilege', description: 'Employ the principle of least privilege, allowing only authorized accesses necessary for assigned tasks.' },
      { controlId: 'AC-7', controlName: 'Unsuccessful Logon Attempts', description: 'Enforce a limit of consecutive invalid logon attempts by a user during a time period.' },
      { controlId: 'AC-8', controlName: 'System Use Notification', description: 'Display system use notification message or banner before granting access.' },
      { controlId: 'AC-9', controlName: 'Previous Logon Notification', description: 'Notify the user upon successful logon of the date and time of the last logon.' },
      { controlId: 'AC-10', controlName: 'Concurrent Session Control', description: 'Limit the number of concurrent sessions for each system account.' },
      { controlId: 'AC-11', controlName: 'Device Lock', description: 'Prevent further access to the system by initiating a device lock after a period of inactivity.' },
      { controlId: 'AC-12', controlName: 'Session Termination', description: 'Automatically terminate a user session after defined conditions.' },
      { controlId: 'AC-14', controlName: 'Permitted Actions without Identification', description: 'Identify specific user actions that can be performed without identification or authentication.' },
      { controlId: 'AC-16', controlName: 'Security and Privacy Attributes', description: 'Provide the means to associate security and privacy attributes with information in storage, process, and transmission.' },
      { controlId: 'AC-17', controlName: 'Remote Access', description: 'Establish usage restrictions, configuration requirements, and implementation guidance for remote access.' },
      { controlId: 'AC-18', controlName: 'Wireless Access', description: 'Establish usage restrictions, configuration requirements, and implementation guidance for wireless access.' },
      { controlId: 'AC-19', controlName: 'Access Control for Mobile Devices', description: 'Establish usage restrictions, configuration requirements, and implementation guidance for mobile devices.' },
      { controlId: 'AC-20', controlName: 'Use of External Systems', description: 'Establish terms and conditions for authorized use of external systems.' },
      { controlId: 'AC-21', controlName: 'Information Sharing', description: 'Enable authorized users to determine whether access authorizations of sharing partners match access restrictions.' },
      { controlId: 'AC-22', controlName: 'Publicly Accessible Content', description: 'Designate individuals authorized to post information onto publicly accessible systems.' },
      { controlId: 'AC-23', controlName: 'Data Mining Protection', description: 'Employ data mining prevention and detection techniques for data storage objects.' },
      { controlId: 'AC-24', controlName: 'Access Control Decisions', description: 'Establish procedures for access control decisions.' },
      { controlId: 'AC-25', controlName: 'Reference Monitor', description: 'Implement a reference monitor for access control that is tamperproof, always invoked, and small enough to be subject to analysis and testing.' },
    ],
  },
  {
    familyId: 'AT',
    familyName: 'Awareness and Training',
    controls: [
      { controlId: 'AT-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate awareness and training policy and procedures.' },
      { controlId: 'AT-2', controlName: 'Literacy Training and Awareness', description: 'Provide security and privacy literacy training to system users.' },
      { controlId: 'AT-3', controlName: 'Role-Based Training', description: 'Provide role-based security and privacy training to personnel with assigned security and privacy roles.' },
      { controlId: 'AT-4', controlName: 'Training Records', description: 'Document and monitor information security and privacy training activities.' },
      { controlId: 'AT-5', controlName: 'Contacts with Security Groups and Associations', description: 'Establish contact with selected groups and associations within the security community.' },
      { controlId: 'AT-6', controlName: 'Training Feedback', description: 'Provide feedback on organizational training results.' },
    ],
  },
  {
    familyId: 'AU',
    familyName: 'Audit and Accountability',
    controls: [
      { controlId: 'AU-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate audit and accountability policy and procedures.' },
      { controlId: 'AU-2', controlName: 'Event Logging', description: 'Identify the types of events that the system is capable of logging in support of the audit function.' },
      { controlId: 'AU-3', controlName: 'Content of Audit Records', description: 'Ensure that audit records contain sufficient information to establish what events occurred.' },
      { controlId: 'AU-4', controlName: 'Audit Log Storage Capacity', description: 'Allocate audit log storage capacity and configure auditing to reduce likelihood of capacity exceeded.' },
      { controlId: 'AU-5', controlName: 'Response to Audit Logging Process Failures', description: 'Alert designated personnel in the event of an audit logging process failure.' },
      { controlId: 'AU-6', controlName: 'Audit Record Review, Analysis, and Reporting', description: 'Review and analyze system audit records for indications of inappropriate or unusual activity.' },
      { controlId: 'AU-7', controlName: 'Audit Record Reduction and Report Generation', description: 'Provide and implement an audit record reduction and report generation capability.' },
      { controlId: 'AU-8', controlName: 'Time Stamps', description: 'Use internal system clocks to generate time stamps for audit records.' },
      { controlId: 'AU-9', controlName: 'Protection of Audit Information', description: 'Protect audit information and audit logging tools from unauthorized access, modification, and deletion.' },
      { controlId: 'AU-10', controlName: 'Non-Repudiation', description: 'Provide irrefutable evidence that a user performed particular actions.' },
      { controlId: 'AU-11', controlName: 'Audit Record Retention', description: 'Retain audit records for a defined time period to provide support for after-the-fact investigations.' },
      { controlId: 'AU-12', controlName: 'Audit Record Generation', description: 'Provide audit record generation capability for auditable events at all system components.' },
      { controlId: 'AU-13', controlName: 'Monitoring for Information Disclosure', description: 'Monitor open-source information and information-sharing sites for evidence of disclosure.' },
      { controlId: 'AU-14', controlName: 'Session Audit', description: 'Provide and implement the capability for authorized users to select a user session to capture and record.' },
      { controlId: 'AU-16', controlName: 'Cross-Organizational Audit Logging', description: 'Employ methods for coordinating audit information among external organizations when audit information is transmitted.' },
    ],
  },
  {
    familyId: 'CA',
    familyName: 'Assessment, Authorization, and Monitoring',
    controls: [
      { controlId: 'CA-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate assessment, authorization, and monitoring policy and procedures.' },
      { controlId: 'CA-2', controlName: 'Control Assessments', description: 'Select the appropriate assessor or assessment team for the type of assessment being conducted.' },
      { controlId: 'CA-3', controlName: 'Information Exchange', description: 'Approve and manage the exchange of information between the system and other systems.' },
      { controlId: 'CA-5', controlName: 'Plan of Action and Milestones', description: 'Develop a plan of action and milestones for the system to document planned remedial actions.' },
      { controlId: 'CA-6', controlName: 'Authorization', description: 'Assign a senior official as the authorizing official for the system.' },
      { controlId: 'CA-7', controlName: 'Continuous Monitoring', description: 'Develop a system-level continuous monitoring strategy and implement the continuous monitoring program.' },
      { controlId: 'CA-8', controlName: 'Penetration Testing', description: 'Conduct penetration testing on systems or system components.' },
      { controlId: 'CA-9', controlName: 'Internal System Connections', description: 'Authorize internal connections of system components and monitor the connections.' },
    ],
  },
  {
    familyId: 'CM',
    familyName: 'Configuration Management',
    controls: [
      { controlId: 'CM-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate configuration management policy and procedures.' },
      { controlId: 'CM-2', controlName: 'Baseline Configuration', description: 'Develop, document, and maintain a current baseline configuration of the system.' },
      { controlId: 'CM-3', controlName: 'Configuration Change Control', description: 'Determine and document the types of changes to the system that are configuration-controlled.' },
      { controlId: 'CM-4', controlName: 'Impact Analyses', description: 'Analyze changes to the system to determine potential security and privacy impacts prior to change implementation.' },
      { controlId: 'CM-5', controlName: 'Access Restrictions for Change', description: 'Define, document, approve, and enforce physical and logical access restrictions associated with changes.' },
      { controlId: 'CM-6', controlName: 'Configuration Settings', description: 'Establish and document configuration settings for components employed within the system.' },
      { controlId: 'CM-7', controlName: 'Least Functionality', description: 'Configure the system to provide only mission-essential capabilities.' },
      { controlId: 'CM-8', controlName: 'System Component Inventory', description: 'Develop and document an inventory of system components that accurately reflects the system.' },
      { controlId: 'CM-9', controlName: 'Configuration Management Plan', description: 'Develop, document, and implement a configuration management plan for the system.' },
      { controlId: 'CM-10', controlName: 'Software Usage Restrictions', description: 'Use software and associated documentation in accordance with contract agreements and copyright laws.' },
      { controlId: 'CM-11', controlName: 'User-Installed Software', description: 'Establish and enforce policies governing the installation of software by users.' },
      { controlId: 'CM-12', controlName: 'Information Location', description: 'Identify and document the location of information and the system components on which information is processed and stored.' },
      { controlId: 'CM-14', controlName: 'Signed Components', description: 'Prevent the installation of software and firmware components without verification that the component has been digitally signed.' },
    ],
  },
  {
    familyId: 'CP',
    familyName: 'Contingency Planning',
    controls: [
      { controlId: 'CP-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate contingency planning policy and procedures.' },
      { controlId: 'CP-2', controlName: 'Contingency Plan', description: 'Develop a contingency plan for the system that identifies essential missions and business functions.' },
      { controlId: 'CP-3', controlName: 'Contingency Training', description: 'Provide contingency training to system users consistent with assigned roles and responsibilities.' },
      { controlId: 'CP-4', controlName: 'Contingency Plan Testing', description: 'Test the contingency plan for the system to determine the effectiveness of the plan.' },
      { controlId: 'CP-6', controlName: 'Alternate Storage Site', description: 'Establish an alternate storage site with agreements to permit storage and retrieval of system backup information.' },
      { controlId: 'CP-7', controlName: 'Alternate Processing Site', description: 'Establish an alternate processing site with agreements to permit transfer and resumption of operations.' },
      { controlId: 'CP-8', controlName: 'Telecommunications Services', description: 'Establish alternate telecommunications services with necessary agreements to permit resumption of operations.' },
      { controlId: 'CP-9', controlName: 'System Backup', description: 'Conduct backups of user-level and system-level information contained in the system.' },
      { controlId: 'CP-10', controlName: 'System Recovery and Reconstitution', description: 'Provide for the recovery and reconstitution of the system to a known state after a disruption, compromise, or failure.' },
      { controlId: 'CP-11', controlName: 'Alternate Communications Protocols', description: 'Provide the capability to employ alternative communications protocols in support of maintaining continuity of operations.' },
      { controlId: 'CP-12', controlName: 'Safe Mode', description: 'When conditions are detected, enter a safe mode of operation with capability to restrict which security functions can be carried out.' },
      { controlId: 'CP-13', controlName: 'Alternative Security Mechanisms', description: 'Employ alternative or supplemental security mechanisms when primary means of implementing a security function is unavailable.' },
    ],
  },
  {
    familyId: 'IA',
    familyName: 'Identification and Authentication',
    controls: [
      { controlId: 'IA-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate identification and authentication policy and procedures.' },
      { controlId: 'IA-2', controlName: 'Identification and Authentication (Organizational Users)', description: 'Uniquely identify and authenticate organizational users.' },
      { controlId: 'IA-3', controlName: 'Device Identification and Authentication', description: 'Uniquely identify and authenticate devices before establishing a connection.' },
      { controlId: 'IA-4', controlName: 'Identifier Management', description: 'Manage system identifiers by receiving authorization, selecting, assigning, and preventing reuse of identifiers.' },
      { controlId: 'IA-5', controlName: 'Authenticator Management', description: 'Manage system authenticators by verifying identity, establishing initial authenticator content, and ensuring adequate protection.' },
      { controlId: 'IA-6', controlName: 'Authentication Feedback', description: 'Obscure feedback of authentication information during the authentication process.' },
      { controlId: 'IA-7', controlName: 'Cryptographic Module Authentication', description: 'Implement mechanisms for authentication to a cryptographic module that meet applicable requirements.' },
      { controlId: 'IA-8', controlName: 'Identification and Authentication (Non-Organizational Users)', description: 'Uniquely identify and authenticate non-organizational users or processes acting on behalf of non-organizational users.' },
      { controlId: 'IA-9', controlName: 'Service Identification and Authentication', description: 'Uniquely identify and authenticate services before establishing communications with the service.' },
      { controlId: 'IA-10', controlName: 'Adaptive Authentication', description: 'Require users to provide additional authentication factors when accessing systems under specific conditions.' },
      { controlId: 'IA-11', controlName: 'Re-Authentication', description: 'Require users to re-authenticate when certain circumstances or situations are encountered.' },
      { controlId: 'IA-12', controlName: 'Identity Proofing', description: 'Identity proof users that require accounts for logical access to systems based on appropriate identity evidence.' },
    ],
  },
  {
    familyId: 'IR',
    familyName: 'Incident Response',
    controls: [
      { controlId: 'IR-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate incident response policy and procedures.' },
      { controlId: 'IR-2', controlName: 'Incident Response Training', description: 'Provide incident response training to system users consistent with assigned roles and responsibilities.' },
      { controlId: 'IR-3', controlName: 'Incident Response Testing', description: 'Test the effectiveness of the incident response capability for the system.' },
      { controlId: 'IR-4', controlName: 'Incident Handling', description: 'Implement an incident handling capability for incidents that includes preparation, detection and analysis, containment, eradication, and recovery.' },
      { controlId: 'IR-5', controlName: 'Incident Monitoring', description: 'Track and document system security and privacy incidents.' },
      { controlId: 'IR-6', controlName: 'Incident Reporting', description: 'Require personnel to report suspected incidents to the organizational incident response capability.' },
      { controlId: 'IR-7', controlName: 'Incident Response Assistance', description: 'Provide an incident response support resource, integral to the incident response capability.' },
      { controlId: 'IR-8', controlName: 'Incident Response Plan', description: 'Develop an incident response plan that provides the organization with a roadmap for implementing its incident response capability.' },
      { controlId: 'IR-9', controlName: 'Information Spillage Response', description: 'Respond to information spills by identifying contaminated systems, isolating them, and eradicating the information.' },
      { controlId: 'IR-10', controlName: 'Integrated Information Security Analysis Team', description: 'Establish an integrated team of forensic and malware analysts, tool developers, and real-time operations personnel.' },
    ],
  },
  {
    familyId: 'MA',
    familyName: 'Maintenance',
    controls: [
      { controlId: 'MA-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate maintenance policy and procedures.' },
      { controlId: 'MA-2', controlName: 'Controlled Maintenance', description: 'Schedule, document, and review records of maintenance and repairs on system components.' },
      { controlId: 'MA-3', controlName: 'Maintenance Tools', description: 'Approve, control, and monitor the use of system maintenance tools.' },
      { controlId: 'MA-4', controlName: 'Nonlocal Maintenance', description: 'Approve and monitor nonlocal maintenance and diagnostic activities.' },
      { controlId: 'MA-5', controlName: 'Maintenance Personnel', description: 'Establish a process for maintenance personnel authorization and maintain a list of authorized maintenance personnel.' },
      { controlId: 'MA-6', controlName: 'Timely Maintenance', description: 'Obtain maintenance support or spare parts for system components within a defined time period.' },
      { controlId: 'MA-7', controlName: 'Field Maintenance', description: 'Restrict or prohibit field maintenance on system components to authorized facilities.' },
    ],
  },
  {
    familyId: 'MP',
    familyName: 'Media Protection',
    controls: [
      { controlId: 'MP-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate media protection policy and procedures.' },
      { controlId: 'MP-2', controlName: 'Media Access', description: 'Restrict access to digital and non-digital media to authorized individuals.' },
      { controlId: 'MP-3', controlName: 'Media Marking', description: 'Mark system media indicating the distribution limitations, handling caveats, and applicable security markings.' },
      { controlId: 'MP-4', controlName: 'Media Storage', description: 'Physically control and securely store digital and non-digital media within controlled areas.' },
      { controlId: 'MP-5', controlName: 'Media Transport', description: 'Protect and control digital and non-digital media during transport outside of controlled areas.' },
      { controlId: 'MP-6', controlName: 'Media Sanitization', description: 'Sanitize system media prior to disposal, release out of organizational control, or release for reuse.' },
      { controlId: 'MP-7', controlName: 'Media Use', description: 'Restrict the use of certain types of media on systems or system components.' },
      { controlId: 'MP-8', controlName: 'Media Downgrading', description: 'Establish a media downgrading process that includes employing downgrading mechanisms with strength and integrity commensurate with the security category.' },
    ],
  },
  {
    familyId: 'PE',
    familyName: 'Physical and Environmental Protection',
    controls: [
      { controlId: 'PE-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate physical and environmental protection policy and procedures.' },
      { controlId: 'PE-2', controlName: 'Physical Access Authorizations', description: 'Develop, approve, and maintain a list of individuals with authorized access to the facility.' },
      { controlId: 'PE-3', controlName: 'Physical Access Control', description: 'Enforce physical access authorizations at entry and exit points to the facility.' },
      { controlId: 'PE-4', controlName: 'Access Control for Transmission', description: 'Control physical access to system distribution and transmission lines within organizational facilities.' },
      { controlId: 'PE-5', controlName: 'Access Control for Output Devices', description: 'Control physical access to output from output devices to prevent unauthorized individuals from obtaining the output.' },
      { controlId: 'PE-6', controlName: 'Monitoring Physical Access', description: 'Monitor physical access to the facility where the system resides to detect and respond to physical security incidents.' },
      { controlId: 'PE-8', controlName: 'Visitor Access Records', description: 'Maintain visitor access records to the facility where the system resides.' },
      { controlId: 'PE-9', controlName: 'Power Equipment and Cabling', description: 'Protect power equipment and power cabling for the system from damage and destruction.' },
      { controlId: 'PE-10', controlName: 'Emergency Shutoff', description: 'Provide the capability of shutting off power to the system or individual system components in emergency situations.' },
      { controlId: 'PE-11', controlName: 'Emergency Power', description: 'Provide an uninterruptible power supply to facilitate an orderly shutdown of the system in the event of a primary power source loss.' },
      { controlId: 'PE-12', controlName: 'Emergency Lighting', description: 'Employ and maintain automatic emergency lighting for the system that activates in the event of a power outage or disruption.' },
      { controlId: 'PE-13', controlName: 'Fire Protection', description: 'Employ and maintain fire detection and suppression systems that are supported by an independent energy source.' },
      { controlId: 'PE-14', controlName: 'Environmental Controls', description: 'Maintain temperature and humidity levels within the facility where the system resides.' },
      { controlId: 'PE-15', controlName: 'Water Damage Protection', description: 'Protect the system from damage resulting from water leakage by providing master shutoff or isolation valves.' },
      { controlId: 'PE-16', controlName: 'Delivery and Removal', description: 'Authorize and control system components entering and exiting the facility.' },
      { controlId: 'PE-17', controlName: 'Alternate Work Site', description: 'Employ management, operational, and technical controls at alternate work sites.' },
      { controlId: 'PE-18', controlName: 'Location of System Components', description: 'Position system components within the facility to minimize potential damage from physical and environmental hazards.' },
      { controlId: 'PE-19', controlName: 'Information Leakage', description: 'Protect the system from information leakage due to electromagnetic signals emanations.' },
      { controlId: 'PE-20', controlName: 'Asset Monitoring and Tracking', description: 'Employ asset location technologies to track and monitor the location and movement of systems within the facility.' },
      { controlId: 'PE-21', controlName: 'Electromagnetic Pulse Protection', description: 'Employ protective measures against electromagnetic pulse damage for the system.' },
      { controlId: 'PE-22', controlName: 'Component Marking', description: 'Mark system hardware components indicating the impact level or classification level of the information permitted.' },
      { controlId: 'PE-23', controlName: 'Facility Location', description: 'Plan the location or site of the facility considering physical and environmental hazards.' },
    ],
  },
  {
    familyId: 'PL',
    familyName: 'Planning',
    controls: [
      { controlId: 'PL-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate planning policy and procedures.' },
      { controlId: 'PL-2', controlName: 'System Security and Privacy Plans', description: 'Develop security and privacy plans for the system that describe the controls in place or planned.' },
      { controlId: 'PL-4', controlName: 'Rules of Behavior', description: 'Establish and provide to individuals requiring access to the system, the rules that describe their responsibilities.' },
      { controlId: 'PL-7', controlName: 'Concept of Operations', description: 'Develop a security and privacy concept of operations for the system consistent with organizational risk management strategy.' },
      { controlId: 'PL-8', controlName: 'Security and Privacy Architectures', description: 'Develop security and privacy architectures for the system that describe the philosophy, requirements, and approach.' },
      { controlId: 'PL-9', controlName: 'Central Management', description: 'Centrally manage designated controls and related processes.' },
      { controlId: 'PL-10', controlName: 'Baseline Selection', description: 'Select a control baseline for the system.' },
      { controlId: 'PL-11', controlName: 'Baseline Tailoring', description: 'Tailor the selected control baseline by applying specified tailoring actions.' },
    ],
  },
  {
    familyId: 'PM',
    familyName: 'Program Management',
    controls: [
      { controlId: 'PM-1', controlName: 'Information Security Program Plan', description: 'Develop and disseminate an organization-wide information security program plan.' },
      { controlId: 'PM-2', controlName: 'Information Security Program Leadership Role', description: 'Appoint a senior information security officer with the mission and resources to coordinate, develop, implement, and maintain an organization-wide information security program.' },
      { controlId: 'PM-3', controlName: 'Information Security and Privacy Resources', description: 'Include the resources needed to implement the information security and privacy programs in capital planning.' },
      { controlId: 'PM-4', controlName: 'Plan of Action and Milestones Process', description: 'Implement a process to ensure that plans of action and milestones for the information security, privacy, and supply chain risk management programs are maintained.' },
      { controlId: 'PM-5', controlName: 'System Inventory', description: 'Develop and maintain an inventory of organizational systems.' },
      { controlId: 'PM-6', controlName: 'Measures of Performance', description: 'Develop, monitor, and report on the results of information security and privacy measures of performance.' },
      { controlId: 'PM-7', controlName: 'Enterprise Architecture', description: 'Develop and maintain an enterprise architecture with consideration for information security, privacy, and the resulting risk.' },
      { controlId: 'PM-8', controlName: 'Critical Infrastructure Plan', description: 'Address information security and privacy issues in the development, documentation, and updating of a critical infrastructure and key resources protection plan.' },
      { controlId: 'PM-9', controlName: 'Risk Management Strategy', description: 'Develop a comprehensive strategy to manage risk to organizational operations, assets, individuals, other organizations, and the Nation.' },
      { controlId: 'PM-10', controlName: 'Authorization Process', description: 'Manage the security and privacy state of organizational systems through authorization processes.' },
      { controlId: 'PM-11', controlName: 'Mission and Business Process Definition', description: 'Define organizational mission and business processes with consideration for information security and privacy.' },
      { controlId: 'PM-12', controlName: 'Insider Threat Program', description: 'Implement an insider threat program that includes a cross-discipline insider threat incident handling team.' },
      { controlId: 'PM-13', controlName: 'Security and Privacy Workforce', description: 'Establish a security and privacy workforce development and improvement program.' },
      { controlId: 'PM-14', controlName: 'Testing, Training, and Monitoring', description: 'Implement a process for ensuring that organizational plans for conducting security and privacy testing, training, and monitoring activities are developed and maintained.' },
      { controlId: 'PM-15', controlName: 'Security and Privacy Groups and Associations', description: 'Establish and institutionalize contact with selected groups and associations within the security and privacy communities.' },
      { controlId: 'PM-16', controlName: 'Threat Awareness Program', description: 'Implement a threat awareness program that includes a cross-organization information-sharing capability.' },
      { controlId: 'PM-17', controlName: 'Protecting Controlled Unclassified Information', description: 'Implement controls for the protection of controlled unclassified information.' },
      { controlId: 'PM-18', controlName: 'Privacy Program Plan', description: 'Develop and disseminate an organization-wide privacy program plan.' },
      { controlId: 'PM-19', controlName: 'Privacy Program Leadership Role', description: 'Appoint a senior agency official for privacy with authority, mission, accountability, and resources.' },
      { controlId: 'PM-20', controlName: 'Dissemination of Privacy Program Information', description: 'Maintain a central resource page on the organizations public-facing website for information about organizational privacy activities.' },
      { controlId: 'PM-21', controlName: 'Accounting of Disclosures', description: 'Develop and maintain an accurate accounting of disclosures of personally identifiable information.' },
      { controlId: 'PM-22', controlName: 'Personally Identifiable Information Quality Management', description: 'Develop and document organization-wide policies and procedures for ensuring quality of personally identifiable information used in programs.' },
      { controlId: 'PM-23', controlName: 'Data Governance Body', description: 'Establish a data governance body consisting of stakeholders with representation from multiple organizations and business areas.' },
      { controlId: 'PM-24', controlName: 'Data Integrity Board', description: 'Establish a data integrity board to oversee organizational computer matching agreements and ensure compliance.' },
      { controlId: 'PM-25', controlName: 'Minimization of Personally Identifiable Information', description: 'Develop, document, and implement policies and procedures to minimize the creation, collection, use, processing, storage, maintenance, and dissemination of personally identifiable information.' },
      { controlId: 'PM-26', controlName: 'Complaint Management', description: 'Implement a process for receiving and responding to complaints, concerns, or questions from individuals about organizational privacy practices.' },
      { controlId: 'PM-27', controlName: 'Privacy Reporting', description: 'Develop, maintain, and disseminate privacy reports.' },
      { controlId: 'PM-28', controlName: 'Risk Framing', description: 'Establish and implement risk framing to facilitate the risk management process.' },
      { controlId: 'PM-29', controlName: 'Risk Management Program Leadership Roles', description: 'Appoint a senior accountable official for risk management to lead and align risk management processes across the organization.' },
      { controlId: 'PM-30', controlName: 'Supply Chain Risk Management Strategy', description: 'Develop an organization-wide strategy for managing supply chain risks associated with the development, acquisition, maintenance, and disposal of systems.' },
      { controlId: 'PM-31', controlName: 'Supply Chain Risk Management Plan', description: 'Develop a plan for managing supply chain risks associated with the research and development, design, manufacturing, acquisition, delivery, integration, operations and maintenance, and disposal of systems.' },
      { controlId: 'PM-32', controlName: 'Purposing', description: 'Analyze systems to identify how they are being used and the purpose of the data they process, store, and transmit.' },
    ],
  },
  {
    familyId: 'PS',
    familyName: 'Personnel Security',
    controls: [
      { controlId: 'PS-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate personnel security policy and procedures.' },
      { controlId: 'PS-2', controlName: 'Position Risk Designation', description: 'Assign a risk designation to all organizational positions.' },
      { controlId: 'PS-3', controlName: 'Personnel Screening', description: 'Screen individuals prior to authorizing access to the system.' },
      { controlId: 'PS-4', controlName: 'Personnel Termination', description: 'Upon termination of individual employment, disable system access within a defined time period.' },
      { controlId: 'PS-5', controlName: 'Personnel Transfer', description: 'Review and confirm ongoing operational need for current logical and physical access authorizations when individuals are reassigned or transferred.' },
      { controlId: 'PS-6', controlName: 'Access Agreements', description: 'Require individuals requiring access to organizational information and systems to sign appropriate access agreements.' },
      { controlId: 'PS-7', controlName: 'External Personnel Security', description: 'Establish personnel security requirements for external providers, including security roles and responsibilities.' },
      { controlId: 'PS-8', controlName: 'Personnel Sanctions', description: 'Employ a formal sanctions process for individuals failing to comply with established information security and privacy policies.' },
      { controlId: 'PS-9', controlName: 'Position Descriptions', description: 'Incorporate security and privacy roles and responsibilities into organizational position descriptions.' },
    ],
  },
  {
    familyId: 'PT',
    familyName: 'Personally Identifiable Information Processing and Transparency',
    controls: [
      { controlId: 'PT-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate PII processing and transparency policy and procedures.' },
      { controlId: 'PT-2', controlName: 'Authority to Process Personally Identifiable Information', description: 'Determine and document the legal authority that permits the collection, use, maintenance, and sharing of PII.' },
      { controlId: 'PT-3', controlName: 'Personally Identifiable Information Processing Purposes', description: 'Identify and document the purposes for processing PII.' },
      { controlId: 'PT-4', controlName: 'Consent', description: 'Implement mechanisms to obtain consent from individuals for the processing of their PII.' },
      { controlId: 'PT-5', controlName: 'Privacy Notice', description: 'Provide notice to individuals about the processing of their PII.' },
      { controlId: 'PT-6', controlName: 'System of Records Notice', description: 'Publish system of records notices in the Federal Register for each system of records maintained.' },
      { controlId: 'PT-7', controlName: 'Specific Categories of Personally Identifiable Information', description: 'Apply processing conditions for specific categories of PII.' },
      { controlId: 'PT-8', controlName: 'Computer Matching Requirements', description: 'When a system or organization is involved in a matching program, implement required procedural provisions.' },
    ],
  },
  {
    familyId: 'RA',
    familyName: 'Risk Assessment',
    controls: [
      { controlId: 'RA-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate risk assessment policy and procedures.' },
      { controlId: 'RA-2', controlName: 'Security Categorization', description: 'Categorize the system and information it processes, stores, and transmits.' },
      { controlId: 'RA-3', controlName: 'Risk Assessment', description: 'Conduct an assessment of risk, including the likelihood and magnitude of harm, from unauthorized access, use, disclosure, disruption, modification, or destruction.' },
      { controlId: 'RA-5', controlName: 'Vulnerability Monitoring and Scanning', description: 'Monitor and scan for vulnerabilities in the system and hosted applications.' },
      { controlId: 'RA-6', controlName: 'Technical Surveillance Countermeasures Survey', description: 'Employ a technical surveillance countermeasures survey at selected locations.' },
      { controlId: 'RA-7', controlName: 'Risk Response', description: 'Respond to findings from security and privacy assessments, monitoring, and audits.' },
      { controlId: 'RA-8', controlName: 'Privacy Impact Assessments', description: 'Conduct privacy impact assessments for systems, programs, or other activities before collecting PII.' },
      { controlId: 'RA-9', controlName: 'Criticality Analysis', description: 'Identify critical system components and functions by performing a criticality analysis.' },
      { controlId: 'RA-10', controlName: 'Threat Hunting', description: 'Establish and maintain a cyber threat hunting capability to search for indicators of compromise in organizational systems.' },
    ],
  },
  {
    familyId: 'SA',
    familyName: 'System and Services Acquisition',
    controls: [
      { controlId: 'SA-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate system and services acquisition policy and procedures.' },
      { controlId: 'SA-2', controlName: 'Allocation of Resources', description: 'Determine the high-level information security and privacy requirements for the system.' },
      { controlId: 'SA-3', controlName: 'System Development Life Cycle', description: 'Acquire, develop, and manage the system using a system development life cycle.' },
      { controlId: 'SA-4', controlName: 'Acquisition Process', description: 'Include security and privacy functional requirements in the acquisition contract.' },
      { controlId: 'SA-5', controlName: 'System Documentation', description: 'Obtain or develop administrator documentation for the system that describes secure configuration.' },
      { controlId: 'SA-8', controlName: 'Security and Privacy Engineering Principles', description: 'Apply systems security and privacy engineering principles in the specification, design, development, implementation, and modification of the system.' },
      { controlId: 'SA-9', controlName: 'External System Services', description: 'Require that providers of external system services comply with organizational security and privacy requirements.' },
      { controlId: 'SA-10', controlName: 'Developer Configuration Management', description: 'Require the developer of the system to perform configuration management during system design, development, implementation, and operation.' },
      { controlId: 'SA-11', controlName: 'Developer Testing and Evaluation', description: 'Require the developer of the system to create and implement a security and privacy assessment plan.' },
      { controlId: 'SA-15', controlName: 'Development Process, Standards, and Tools', description: 'Require the developer of the system to follow a documented development process.' },
      { controlId: 'SA-16', controlName: 'Developer-Provided Training', description: 'Require the developer of the system to provide training on the correct use and operation of implemented security and privacy functions.' },
      { controlId: 'SA-17', controlName: 'Developer Security and Privacy Architecture and Design', description: 'Require the developer to produce a design specification and security and privacy architecture.' },
      { controlId: 'SA-20', controlName: 'Customized Development of Critical Components', description: 'Re-implement or custom develop critical system components.' },
      { controlId: 'SA-21', controlName: 'Developer Screening', description: 'Require that the developer of the system screen personnel.' },
      { controlId: 'SA-22', controlName: 'Unsupported System Components', description: 'Replace system components when support for the components is no longer available from the developer, vendor, or manufacturer.' },
      { controlId: 'SA-23', controlName: 'Specialization', description: 'Employ specialized processing components to limit the attack surface.' },
    ],
  },
  {
    familyId: 'SC',
    familyName: 'System and Communications Protection',
    controls: [
      { controlId: 'SC-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate system and communications protection policy and procedures.' },
      { controlId: 'SC-2', controlName: 'Separation of System and User Functionality', description: 'Separate user functionality from system management functionality.' },
      { controlId: 'SC-3', controlName: 'Security Function Isolation', description: 'Isolate security functions from nonsecurity functions.' },
      { controlId: 'SC-4', controlName: 'Information in Shared System Resources', description: 'Prevent unauthorized and unintended information transfer via shared system resources.' },
      { controlId: 'SC-5', controlName: 'Denial-of-Service Protection', description: 'Protect against or limit the effects of denial-of-service attacks.' },
      { controlId: 'SC-7', controlName: 'Boundary Protection', description: 'Monitor and control communications at the external managed interfaces to the system and at key internal boundaries.' },
      { controlId: 'SC-8', controlName: 'Transmission Confidentiality and Integrity', description: 'Protect the confidentiality and integrity of transmitted information.' },
      { controlId: 'SC-10', controlName: 'Network Disconnect', description: 'Terminate the network connection associated with a communications session at the end of the session or after a period of inactivity.' },
      { controlId: 'SC-12', controlName: 'Cryptographic Key Establishment and Management', description: 'Establish and manage cryptographic keys when cryptography is employed within the system.' },
      { controlId: 'SC-13', controlName: 'Cryptographic Protection', description: 'Implement FIPS-validated cryptography when used to protect the confidentiality and integrity of information.' },
      { controlId: 'SC-15', controlName: 'Collaborative Computing Devices and Applications', description: 'Prohibit remote activation of collaborative computing devices and applications and provide indication of use to users.' },
      { controlId: 'SC-17', controlName: 'Public Key Infrastructure Certificates', description: 'Issue public key certificates under an appropriate certificate policy or obtain public key certificates from an approved service provider.' },
      { controlId: 'SC-18', controlName: 'Mobile Code', description: 'Define acceptable and unacceptable mobile code and mobile code technologies.' },
      { controlId: 'SC-20', controlName: 'Secure Name/Address Resolution Service (Authoritative Source)', description: 'Provide additional data origin authentication and integrity verification artifacts along with authoritative name resolution data.' },
      { controlId: 'SC-21', controlName: 'Secure Name/Address Resolution Service (Recursive or Caching Resolver)', description: 'Request and perform data origin authentication and data integrity verification on name/address resolution responses.' },
      { controlId: 'SC-22', controlName: 'Architecture and Provisioning for Name/Address Resolution Service', description: 'Ensure the systems that collectively provide name and address resolution service for an organization are fault-tolerant.' },
      { controlId: 'SC-23', controlName: 'Session Authenticity', description: 'Protect the authenticity of communications sessions.' },
      { controlId: 'SC-24', controlName: 'Fail in Known State', description: 'Fail to a known secure state in the event of failures.' },
      { controlId: 'SC-25', controlName: 'Thin Nodes', description: 'Employ minimal functionality and information storage on system components.' },
      { controlId: 'SC-26', controlName: 'Decoys', description: 'Employ decoys to detect, deflect, or deter attacks against the system.' },
      { controlId: 'SC-27', controlName: 'Platform-Independent Applications', description: 'Include within organizational systems the use of applications that are platform-independent.' },
      { controlId: 'SC-28', controlName: 'Protection of Information at Rest', description: 'Protect the confidentiality and integrity of information at rest.' },
      { controlId: 'SC-29', controlName: 'Heterogeneity', description: 'Employ a diverse set of information technologies for system components.' },
      { controlId: 'SC-30', controlName: 'Concealment and Misdirection', description: 'Employ concealment and misdirection techniques for systems to confuse and mislead adversaries.' },
      { controlId: 'SC-31', controlName: 'Covert Channel Analysis', description: 'Perform a covert channel analysis to identify those aspects of communications within the system that are potential avenues for covert storage and timing channels.' },
      { controlId: 'SC-32', controlName: 'System Partitioning', description: 'Partition the system into components residing in separate physical or logical domains or environments.' },
      { controlId: 'SC-34', controlName: 'Non-Modifiable Executable Programs', description: 'Employ hardware-enforced, write-protect of firmware stored in hardware components.' },
      { controlId: 'SC-36', controlName: 'Distributed Processing and Storage', description: 'Distribute processing and storage across multiple physical locations.' },
      { controlId: 'SC-37', controlName: 'Out-of-Band Channels', description: 'Employ out-of-band channels for the physical delivery of systems or system components.' },
      { controlId: 'SC-38', controlName: 'Operations Security', description: 'Employ operations security safeguards to protect key organizational information.' },
      { controlId: 'SC-39', controlName: 'Process Isolation', description: 'Maintain a separate execution domain for each executing system process.' },
      { controlId: 'SC-40', controlName: 'Wireless Link Protection', description: 'Protect external and internal wireless links from signal parameter attacks.' },
      { controlId: 'SC-41', controlName: 'Port and I/O Device Access', description: 'Disable or remove unnecessary physical ports and input/output devices on systems.' },
      { controlId: 'SC-42', controlName: 'Sensor Capability and Data', description: 'Prohibit the use of devices possessing environmental sensing capabilities in restricted areas.' },
      { controlId: 'SC-43', controlName: 'Usage Restrictions', description: 'Establish usage restrictions and implementation guidelines for system components.' },
      { controlId: 'SC-44', controlName: 'Detonation Chambers', description: 'Employ a detonation chamber capability within the system.' },
      { controlId: 'SC-45', controlName: 'System Time Synchronization', description: 'Synchronize system clocks within and between systems and system components.' },
      { controlId: 'SC-46', controlName: 'Cross Domain Policy Enforcement', description: 'Implement a policy enforcement mechanism between interconnected systems.' },
      { controlId: 'SC-48', controlName: 'Sensor Relocation', description: 'Relocate sensors or monitoring capabilities to varying locations.' },
      { controlId: 'SC-49', controlName: 'Hardware-Enforced Separation and Policy Enforcement', description: 'Implement hardware-enforced separation and policy enforcement mechanisms between security domains.' },
      { controlId: 'SC-50', controlName: 'Software-Enforced Separation and Policy Enforcement', description: 'Implement software-enforced separation and policy enforcement mechanisms between security domains.' },
      { controlId: 'SC-51', controlName: 'Hardware-Based Protection', description: 'Implement hardware-based protections to safeguard the confidentiality and integrity of system firmware.' },
    ],
  },
  {
    familyId: 'SI',
    familyName: 'System and Information Integrity',
    controls: [
      { controlId: 'SI-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate system and information integrity policy and procedures.' },
      { controlId: 'SI-2', controlName: 'Flaw Remediation', description: 'Identify, report, and correct system flaws.' },
      { controlId: 'SI-3', controlName: 'Malicious Code Protection', description: 'Implement malicious code protection mechanisms at system entry and exit points.' },
      { controlId: 'SI-4', controlName: 'System Monitoring', description: 'Monitor the system to detect attacks and indicators of potential attacks.' },
      { controlId: 'SI-5', controlName: 'Security Alerts, Advisories, and Directives', description: 'Receive system security alerts, advisories, and directives from external organizations on an ongoing basis.' },
      { controlId: 'SI-6', controlName: 'Security and Privacy Function Verification', description: 'Verify the correct operation of security and privacy functions.' },
      { controlId: 'SI-7', controlName: 'Software, Firmware, and Information Integrity', description: 'Employ integrity verification tools to detect unauthorized changes to software, firmware, and information.' },
      { controlId: 'SI-8', controlName: 'Spam Protection', description: 'Employ spam protection mechanisms at system entry and exit points.' },
      { controlId: 'SI-10', controlName: 'Information Input Validation', description: 'Check the validity of information inputs.' },
      { controlId: 'SI-11', controlName: 'Error Handling', description: 'Generate error messages that provide information necessary for corrective actions without revealing information that could be exploited.' },
      { controlId: 'SI-12', controlName: 'Information Management and Retention', description: 'Manage and retain information within the system and information output from the system.' },
      { controlId: 'SI-13', controlName: 'Predictable Failure Prevention', description: 'Determine mean time to failure for system components and take protective measures to ensure availability.' },
      { controlId: 'SI-14', controlName: 'Non-Persistence', description: 'Implement non-persistent system components and services that are initiated in a known state and terminated upon nonuse.' },
      { controlId: 'SI-15', controlName: 'Information Output Filtering', description: 'Validate information output from software programs or applications to ensure information is consistent with the expected content.' },
      { controlId: 'SI-16', controlName: 'Memory Protection', description: 'Implement security safeguards to protect system memory from unauthorized code execution.' },
      { controlId: 'SI-17', controlName: 'Fail-Safe Procedures', description: 'Implement system fail-safe procedures in the event of failures.' },
      { controlId: 'SI-18', controlName: 'Personally Identifiable Information Quality Operations', description: 'Take action to correct or delete inaccurate or outdated personally identifiable information.' },
      { controlId: 'SI-19', controlName: 'De-Identification', description: 'Remove PII elements from datasets prior to release to reduce the risk of re-identification.' },
      { controlId: 'SI-20', controlName: 'Tainting', description: 'Embed data or capabilities in organizational systems for the purpose of determining data integrity and the provenance of data.' },
      { controlId: 'SI-21', controlName: 'Information Refresh', description: 'Refresh information at defined frequencies to ensure accuracy and relevance.' },
      { controlId: 'SI-22', controlName: 'Information Diversity', description: 'Employ information diversity to increase the accuracy and relevance of information gathered and reduce potential for single points of failure.' },
      { controlId: 'SI-23', controlName: 'Information Fragmentation', description: 'Fragment information based on the criticality and sensitivity of the information.' },
    ],
  },
  {
    familyId: 'SR',
    familyName: 'Supply Chain Risk Management',
    controls: [
      { controlId: 'SR-1', controlName: 'Policy and Procedures', description: 'Develop, document, and disseminate supply chain risk management policy and procedures.' },
      { controlId: 'SR-2', controlName: 'Supply Chain Risk Management Plan', description: 'Develop a plan for managing supply chain risks associated with the research and development, design, manufacturing, acquisition, delivery, integration, operations and maintenance, and disposal of systems.' },
      { controlId: 'SR-3', controlName: 'Supply Chain Controls and Processes', description: 'Establish a process or processes to identify and address weaknesses or deficiencies in the supply chain elements and processes.' },
      { controlId: 'SR-4', controlName: 'Provenance', description: 'Document, monitor, and maintain valid provenance of systems, system components, and associated data.' },
      { controlId: 'SR-5', controlName: 'Acquisition Strategies, Tools, and Methods', description: 'Employ acquisition strategies, contract tools, and procurement methods to protect against, identify, and mitigate supply chain risks.' },
      { controlId: 'SR-6', controlName: 'Supplier Assessments and Reviews', description: 'Assess and review the supply chain-related risks associated with suppliers or contractors.' },
      { controlId: 'SR-7', controlName: 'Supply Chain Operations Security', description: 'Employ operations security controls to protect supply chain-related information.' },
      { controlId: 'SR-8', controlName: 'Notification Agreements', description: 'Establish agreements and procedures with entities involved in the supply chain for notification of supply chain compromises.' },
      { controlId: 'SR-9', controlName: 'Tamper Resistance and Detection', description: 'Implement a tamper protection program for the system, system component, or system service.' },
      { controlId: 'SR-10', controlName: 'Inspection of Systems or Components', description: 'Inspect systems or system components to detect tampering.' },
      { controlId: 'SR-11', controlName: 'Component Authenticity', description: 'Develop and implement anti-counterfeit policy and procedures.' },
      { controlId: 'SR-12', controlName: 'Component Disposal', description: 'Dispose of system components using organization-defined techniques and methods.' },
    ],
  },
];

interface ComplianceFrameworkFetchResult {
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Ingest compliance framework controls as structured reference data.
 * SOC 2 + ISO 27001 + NIST 800-53 controls stored as public_records.
 */
export async function fetchComplianceFrameworks(
  supabase: SupabaseClient,
): Promise<ComplianceFrameworkFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping compliance framework ingest');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalErrors = 0;

  logger.info('Starting compliance framework ingest (NCX-07)');

  // --- SOC 2 ---
  {
    const records = SOC2_CONTROLS.map(c => ({
      source: 'soc2' as const,
      source_id: `SOC2-${c.controlId}`,
      source_url: 'https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2',
      record_type: 'compliance_control',
      title: `SOC 2 ${c.controlId} — ${c.controlName}`,
      content_hash: computeContentHash(JSON.stringify({ framework: 'SOC2', id: c.controlId, name: c.controlName })),
      metadata: {
        framework: 'SOC 2 Type II',
        controlId: c.controlId,
        controlName: c.controlName,
        family: c.category,
        description: c.description,
        category: 'Trust Services Criteria',
        pipeline_source: 'soc2',
      },
    }));

    for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
      const batch = records.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) {
        logger.error({ error, count: batch.length }, 'SOC 2 batch insert failed');
        totalErrors += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }
    logger.info({ count: SOC2_CONTROLS.length }, 'SOC 2 controls ingested');
  }

  // --- ISO 27001 ---
  {
    const records = ISO27001_CONTROLS.map(c => ({
      source: 'iso27001' as const,
      source_id: `ISO27001-${c.controlId}`,
      source_url: 'https://www.iso.org/standard/27001',
      record_type: 'compliance_control',
      title: `ISO 27001 ${c.controlId} — ${c.controlName}`,
      content_hash: computeContentHash(JSON.stringify({ framework: 'ISO27001', id: c.controlId, name: c.controlName })),
      metadata: {
        framework: 'ISO 27001:2022',
        controlId: c.controlId,
        controlName: c.controlName,
        family: c.theme,
        description: c.description,
        category: 'Annex A',
        pipeline_source: 'iso27001',
      },
    }));

    for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
      const batch = records.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) {
        logger.error({ error, count: batch.length }, 'ISO 27001 batch insert failed');
        totalErrors += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }
    logger.info({ count: ISO27001_CONTROLS.length }, 'ISO 27001 controls ingested');
  }

  // --- NIST 800-53 ---
  {
    const records: Array<Record<string, unknown>> = [];
    for (const family of NIST_800_53_FAMILIES) {
      for (const control of family.controls) {
        records.push({
          source: 'nist800_53',
          source_id: `NIST-${control.controlId}`,
          source_url: `https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final`,
          record_type: 'compliance_control',
          title: `NIST 800-53 ${control.controlId} — ${control.controlName}`,
          content_hash: computeContentHash(JSON.stringify({ framework: 'NIST800-53', id: control.controlId, name: control.controlName })),
          metadata: {
            framework: 'NIST 800-53 Rev 5',
            controlId: control.controlId,
            controlName: control.controlName,
            family: `${family.familyId} — ${family.familyName}`,
            description: control.description,
            category: family.familyName,
            pipeline_source: 'nist800_53',
          },
        });
      }
    }

    for (let i = 0; i < records.length; i += INSERT_BATCH_SIZE) {
      const batch = records.slice(i, i + INSERT_BATCH_SIZE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) {
        logger.error({ error, count: batch.length }, 'NIST 800-53 batch insert failed');
        totalErrors += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }
    logger.info({ count: records.length }, 'NIST 800-53 controls ingested');
  }

  const result = { inserted: totalInserted, skipped: 0, errors: totalErrors };
  logger.info(result, 'Compliance framework ingest complete');
  return result;
}
