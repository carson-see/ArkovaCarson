/**
 * Vertex AI Client (SCRUM-1061)
 *
 * Service-account-authenticated client for Gemini Golden.
 * Replaces Developer API key (@google/generative-ai) with
 * Vertex AI SDK auth for VPC Service Controls, CMEK, US residency.
 *
 * Auth chain: GCP metadata server (Cloud Run) → GOOGLE_APPLICATION_CREDENTIALS → fail.
 * Nessie is NOT touched — it stays on Together.ai + Llama 3.1.
 */

import { logger } from '../utils/logger.js';

const VERTEX_REGION = process.env.VERTEX_AI_REGION ?? 'us-central1';
const VERTEX_PROJECT = process.env.GCP_PROJECT_ID ?? 'arkova1';
const VERTEX_API_BASE = `https://${VERTEX_REGION}-aiplatform.googleapis.com/v1`;

export interface VertexGenerateRequest {
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

export interface VertexGenerateResponse {
  text: string;
  tokensUsed?: number;
  finishReason?: string;
}

export interface VertexEmbeddingRequest {
  model: string;
  text: string;
  taskType?: string;
  outputDimensionality?: number;
}

export interface VertexEmbeddingResponse {
  values: number[];
  dimensions: number;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  try {
    const metaRes = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
    );
    if (metaRes.ok) {
      const data = (await metaRes.json()) as { access_token: string; expires_in: number };
      cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
      return data.access_token;
    }
  } catch {
    // Not on GCP — fall through to GOOGLE_APPLICATION_CREDENTIALS
  }

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    throw new Error('No GCP credentials: set GOOGLE_APPLICATION_CREDENTIALS or run on Cloud Run');
  }

  const { readFileSync } = await import('node:fs');
  const { createSign } = await import('node:crypto');
  const key = JSON.parse(readFileSync(keyPath, 'utf-8')) as {
    client_email: string; private_key: string; token_uri: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email, sub: key.client_email,
    aud: key.token_uri, iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  })).toString('base64url');
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;
  const tokenRes = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!tokenRes.ok) {
    throw new Error('Failed to get access token from service account key');
  }
  const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: tokenData.access_token, expiresAt: Date.now() + tokenData.expires_in * 1000 };
  return tokenData.access_token;
}

export async function vertexGenerate(req: VertexGenerateRequest): Promise<VertexGenerateResponse> {
  const accessToken = await getAccessToken();
  const modelPath = `projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${req.model}`;
  const url = `${VERTEX_API_BASE}/${modelPath}:generateContent`;

  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature ?? 0.1,
    responseMimeType: req.responseMimeType ?? 'application/json',
  };
  if (req.maxOutputTokens) generationConfig.maxOutputTokens = req.maxOutputTokens;
  if (req.responseSchema) generationConfig.responseSchema = req.responseSchema;

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
    generationConfig,
  };
  if (req.systemPrompt) {
    body.systemInstruction = { role: 'system', parts: [{ text: req.systemPrompt }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, model: req.model }, `Vertex AI generate failed: ${errText}`);
    throw new Error(`Vertex AI generate failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: { totalTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return {
    text,
    tokensUsed: data.usageMetadata?.totalTokenCount,
    finishReason: data.candidates?.[0]?.finishReason,
  };
}

export async function vertexEmbed(req: VertexEmbeddingRequest): Promise<VertexEmbeddingResponse> {
  const accessToken = await getAccessToken();
  const modelPath = `projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${req.model}`;
  const url = `${VERTEX_API_BASE}/${modelPath}:predict`;

  const instance: Record<string, unknown> = { content: req.text };
  if (req.taskType) instance.taskType = req.taskType;

  const body: Record<string, unknown> = {
    instances: [instance],
  };
  if (req.outputDimensionality) {
    body.parameters = { outputDimensionality: req.outputDimensionality };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    logger.error({ status: response.status, model: req.model }, `Vertex AI embed failed: ${errText}`);
    throw new Error(`Vertex AI embed failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };

  const values = data.predictions?.[0]?.embeddings?.values ?? [];
  return { values, dimensions: values.length };
}

export function isVertexEnabled(): boolean {
  return process.env.ENABLE_VERTEX_AI === 'true';
}
