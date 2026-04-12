/**
 * Clio OAuth2 Connector (INT-06)
 *
 * Handles OAuth2 authorization code flow with Clio API v4.
 * Provides authenticated access to documents, contacts, and matters.
 */

import type { ClioConfig, ClioDocument, ClioContact, ClioTokenResponse } from './types';

const CLIO_API_BASE = 'https://app.clio.com/api/v4';
const CLIO_AUTH_URL = 'https://app.clio.com/oauth/authorize';
const CLIO_TOKEN_URL = 'https://app.clio.com/oauth/token';

export class ClioConnector {
  private readonly config: ClioConfig;
  private readonly clioBaseUrl: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: ClioConfig) {
    this.config = config;
    this.clioBaseUrl = config.clioBaseUrl ?? CLIO_API_BASE;
  }

  /**
   * Generate the OAuth2 authorization URL for Clio.
   * Redirect the user to this URL to begin the OAuth flow.
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clioClientId,
      redirect_uri: this.config.clioRedirectUri,
    });
    if (state) params.set('state', state);
    return `${CLIO_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for access + refresh tokens.
   */
  async exchangeCode(code: string): Promise<ClioTokenResponse> {
    const response = await fetch(CLIO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.clioClientId,
        client_secret: this.config.clioClientSecret,
        redirect_uri: this.config.clioRedirectUri,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Clio token exchange failed: ${response.status} ${err}`);
    }

    const tokens = (await response.json()) as ClioTokenResponse;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiresAt = tokens.created_at + tokens.expires_in;
    return tokens;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  async refreshAccessToken(): Promise<ClioTokenResponse> {
    if (!this.refreshToken) throw new Error('No refresh token available');

    const response = await fetch(CLIO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.config.clioClientId,
        client_secret: this.config.clioClientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Clio token refresh failed: ${response.status}`);
    }

    const tokens = (await response.json()) as ClioTokenResponse;
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.tokenExpiresAt = tokens.created_at + tokens.expires_in;
    return tokens;
  }

  /**
   * Set tokens directly (e.g., from stored credentials).
   */
  setTokens(accessToken: string, refreshToken: string, expiresAt?: number): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiresAt = expiresAt ?? 0;
  }

  /**
   * List documents from Clio, optionally filtered by matter.
   */
  async listDocuments(options?: {
    matterId?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ data: ClioDocument[]; meta: { paging: { next?: string } } }> {
    const params = new URLSearchParams({
      fields: 'id,name,content_type,created_at,updated_at,size,parent_id,contact{id,name},matter{id,display_number,description}',
    });
    if (options?.matterId) params.set('matter_id', String(options.matterId));
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    return this.clioRequest(`/documents.json?${params.toString()}`);
  }

  /**
   * Get a single document by ID.
   */
  async getDocument(documentId: number): Promise<{ data: ClioDocument }> {
    return this.clioRequest(
      `/documents/${documentId}.json?fields=id,name,content_type,created_at,updated_at,size,parent_id,contact{id,name},matter{id,display_number,description}`,
    );
  }

  /**
   * Download a document's content as ArrayBuffer (for hashing).
   */
  async downloadDocument(documentId: number): Promise<ArrayBuffer> {
    await this.ensureToken();
    const response = await fetch(
      `${this.clioBaseUrl}/documents/${documentId}/download`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to download Clio document ${documentId}: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  /**
   * Get a contact by ID.
   */
  async getContact(contactId: number): Promise<{ data: ClioContact }> {
    return this.clioRequest(
      `/contacts/${contactId}.json?fields=id,name,type,email_addresses{address,name},custom_fields{id,name,value}`,
    );
  }

  /**
   * Search contacts by name.
   */
  async searchContacts(query: string): Promise<{ data: ClioContact[] }> {
    return this.clioRequest(
      `/contacts.json?query=${encodeURIComponent(query)}&fields=id,name,type`,
    );
  }

  // ── Internal ───────────────────────────────────────────────────────

  private async ensureToken(): Promise<void> {
    if (!this.accessToken) throw new Error('Not authenticated with Clio');
    if (this.tokenExpiresAt && Date.now() / 1000 > this.tokenExpiresAt - 60) {
      await this.refreshAccessToken();
    }
  }

  private async clioRequest<T>(path: string): Promise<T> {
    await this.ensureToken();
    const response = await fetch(`${this.clioBaseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Clio API error: ${response.status} ${err}`);
    }
    return response.json() as Promise<T>;
  }
}
