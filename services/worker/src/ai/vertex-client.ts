import { logger } from '../utils/logger.js';
import { getGcpAccessToken } from '../utils/gcp-auth.js';
import { traceAiProviderCall } from './observability.js';

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

export async function vertexGenerate(req: VertexGenerateRequest): Promise<VertexGenerateResponse> {
  const accessToken = await getGcpAccessToken();
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

  return await traceAiProviderCall<VertexGenerateResponse>(
    {
      provider: 'vertex',
      operation: 'generate',
      model: req.model,
      inputCharacterCount: req.userPrompt.length,
    },
    async () => {
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
    },
    (response) => ({ tokensUsed: response.tokensUsed }),
  );
}

export async function vertexEmbed(req: VertexEmbeddingRequest): Promise<VertexEmbeddingResponse> {
  const accessToken = await getGcpAccessToken();
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

  return await traceAiProviderCall<VertexEmbeddingResponse>(
    {
      provider: 'vertex',
      operation: 'embed',
      model: req.model,
      inputCharacterCount: req.text.length,
    },
    async () => {
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
    },
  );
}

export function isVertexEnabled(): boolean {
  return process.env.ENABLE_VERTEX_AI === 'true';
}
