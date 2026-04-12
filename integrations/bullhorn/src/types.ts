/**
 * Bullhorn Integration Types (INT-07)
 */

/** Configuration for the Bullhorn–Arkova connector */
export interface BullhornConfig {
  /** Bullhorn REST API base URL (varies by datacenter) */
  bullhornRestUrl: string;
  /** Bullhorn REST token (BhRestToken) */
  bullhornRestToken: string;
  /** Arkova API key */
  arkovaApiKey: string;
  /** Arkova API base URL */
  arkovaBaseUrl?: string;
  /** Custom field ID for syncing verification status */
  verificationStatusFieldId?: string;
  /** Custom field ID for syncing verification count */
  verificationCountFieldId?: string;
  /** Auto-verify new candidate file attachments */
  autoVerify?: boolean;
}

/** Bullhorn candidate record */
export interface BullhornCandidate {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  /** Custom fields for verification data */
  customText1?: string;
  customText2?: string;
  customText3?: string;
  customInt1?: number;
  customInt2?: number;
}

/** Bullhorn candidate file/credential attachment */
export interface BullhornCredential {
  id: number;
  candidateId: number;
  type: string;
  name: string;
  contentType: string;
  dateAdded: string;
  /** Arkova public_id if anchored */
  arkovaPublicId?: string;
  /** Arkova verification status */
  arkovaStatus?: 'PENDING' | 'SECURED' | 'ACTIVE' | 'REVOKED' | 'NOT_ANCHORED';
}

/** Summary of candidate's credential verification */
export interface CandidateVerificationSummary {
  candidateId: number;
  candidateName: string;
  totalCredentials: number;
  verifiedCount: number;
  pendingCount: number;
  revokedCount: number;
  notAnchoredCount: number;
  verificationPercentage: number;
  credentials: BullhornCredential[];
  lastChecked: string;
}

/** Mapping between Bullhorn custom fields and Arkova data */
export interface BullhornCustomFieldMapping {
  /** Custom field for overall verification status (e.g., "Fully Verified", "Partially Verified") */
  statusField: string;
  /** Custom field for verified credential count */
  countField: string;
  /** Custom field for verification percentage (0-100) */
  percentageField: string;
  /** Custom field for last verification date */
  lastVerifiedField: string;
}

/** Bullhorn REST API entity file response */
export interface BullhornFileResponse {
  File: {
    contentType: string;
    fileContent: string; // base64 encoded
    name: string;
  };
}

/** Bullhorn webhook subscription event */
export interface BullhornSubscriptionEvent {
  events: Array<{
    eventId: string;
    eventType: 'ENTITY' | 'FILE';
    entityName: string;
    entityId: number;
    updatedProperties?: string[];
    eventTimestamp: number;
  }>;
  requestId: number;
  lastRequestId: number;
}
