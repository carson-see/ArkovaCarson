/**
 * Bullhorn REST API Connector (INT-07)
 *
 * Provides authenticated access to Bullhorn's REST API for
 * candidate records, file attachments, and custom field updates.
 */

import type {
  BullhornConfig,
  BullhornCandidate,
  BullhornFileResponse,
} from './types';

export class BullhornConnector {
  private readonly restUrl: string;
  private readonly restToken: string;

  constructor(config: BullhornConfig) {
    this.restUrl = config.bullhornRestUrl.replace(/\/+$/, '');
    this.restToken = config.bullhornRestToken;
  }

  /**
   * Update the REST token (e.g., after refresh).
   */
  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      BhRestToken: this.restToken,
    };
  }

  /**
   * Get a candidate by ID.
   */
  async getCandidate(
    candidateId: number,
    fields: string[] = [
      'id', 'firstName', 'lastName', 'email', 'status',
      'customText1', 'customText2', 'customText3',
      'customInt1', 'customInt2',
    ],
  ): Promise<BullhornCandidate> {
    const response = await fetch(
      `${this.restUrl}/entity/Candidate/${candidateId}?fields=${fields.join(',')}`,
      { headers: this.headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to get candidate ${candidateId}: ${response.status}`);
    }
    const data = (await response.json()) as { data: BullhornCandidate };
    return data.data;
  }

  /**
   * List file attachments for a candidate.
   */
  async listCandidateFiles(
    candidateId: number,
  ): Promise<Array<{ id: number; type: string; name: string; contentType: string; dateAdded: number }>> {
    const response = await fetch(
      `${this.restUrl}/entityFiles/Candidate/${candidateId}`,
      { headers: this.headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to list files for candidate ${candidateId}: ${response.status}`);
    }
    const data = (await response.json()) as {
      EntityFiles: Array<{ id: number; type: string; name: string; contentType: string; dateAdded: number }>;
    };
    return data.EntityFiles ?? [];
  }

  /**
   * Download a candidate file's content.
   */
  async downloadFile(
    candidateId: number,
    fileId: number,
  ): Promise<ArrayBuffer> {
    const response = await fetch(
      `${this.restUrl}/file/Candidate/${candidateId}/${fileId}`,
      { headers: this.headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to download file ${fileId}: ${response.status}`);
    }
    const data = (await response.json()) as BullhornFileResponse;
    // Bullhorn returns base64-encoded file content
    const binary = atob(data.File.fileContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Update custom fields on a candidate record.
   */
  async updateCandidateFields(
    candidateId: number,
    fields: Record<string, string | number>,
  ): Promise<void> {
    const response = await fetch(
      `${this.restUrl}/entity/Candidate/${candidateId}`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(fields),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to update candidate ${candidateId}: ${response.status}`);
    }
  }

  /**
   * Search candidates by query.
   */
  async searchCandidates(
    query: string,
    count: number = 20,
  ): Promise<BullhornCandidate[]> {
    const response = await fetch(
      `${this.restUrl}/search/Candidate?query=${encodeURIComponent(query)}&fields=id,firstName,lastName,email,status&count=${count}`,
      { headers: this.headers },
    );
    if (!response.ok) {
      throw new Error(`Candidate search failed: ${response.status}`);
    }
    const data = (await response.json()) as { data: BullhornCandidate[] };
    return data.data ?? [];
  }
}
