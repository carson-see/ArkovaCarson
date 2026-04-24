import { Metadata } from '@grpc/grpc-js';
import { SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { OTLPTraceExporter as GrpcOTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { logger } from '../utils/logger.js';

const DEFAULT_ARIZE_OTLP_ENDPOINT = 'https://otlp.arize.com/v1';
const DEFAULT_ARIZE_PROJECT_NAME = 'arkova-ai-providers';
const TRACER_NAME = 'arkova.worker.ai';

let arizeTracerInitialized = false;

export interface AiTraceMetadata {
  provider: 'together' | 'nessie' | 'gemini' | 'vertex' | string;
  operation:
    | 'chat_completion'
    | 'extract'
    | 'embed'
    | 'generate'
    | 'rag'
    | 'health'
    | 'tags'
    | 'template'
    | string;
  model?: string;
  modelVersion?: string;
  inputCharacterCount?: number;
  outputCharacterCount?: number;
  tokensUsed?: number;
  latencyMs?: number;
  success?: boolean;
  confidence?: number;
  costUsd?: number;
  driftScore?: number;
  hallucinationRate?: number;
  failureMode?: string;
  fraudSignalCount?: number;
  errorType?: string;
  errorMessage?: string;
}

const TRACE_ATTRIBUTE_MAP = {
  provider: 'ai.provider',
  operation: 'ai.operation',
  model: 'llm.model_name',
  modelVersion: 'llm.model_version',
  inputCharacterCount: 'ai.input_characters',
  outputCharacterCount: 'ai.output_characters',
  tokensUsed: 'llm.token_count.total',
  latencyMs: 'ai.latency_ms',
  success: 'ai.success',
  confidence: 'ai.confidence',
  costUsd: 'llm.cost.usd',
  driftScore: 'ai.eval.drift_score',
  hallucinationRate: 'ai.hallucination_rate',
  failureMode: 'ai.failure_mode',
  fraudSignalCount: 'ai.fraud_signal_count',
  errorType: 'error.type',
  errorMessage: 'error.message',
} as const satisfies Record<keyof AiTraceMetadata, string>;

const FREE_TEXT_REDACTIONS: Array<[RegExp, string]> = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email_redacted]'],
  [/\b[a-f0-9]{64}\b/gi, '[sha256_redacted]'],
  [/\b(?:sk|rk|gho|ghp|AIza|rp)_[A-Za-z0-9_-]{12,}\b/g, '[token_redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [token_redacted]'],
];

export function isArizeTracingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARIZE_TRACING_ENABLED === 'true' && Boolean(env.ARIZE_API_KEY) && Boolean(env.ARIZE_SPACE_ID);
}

export function initializeArizeTracing(): void {
  if (arizeTracerInitialized || !isArizeTracingConfigured()) return;

  const spaceId = process.env.ARIZE_SPACE_ID;
  const apiKey = process.env.ARIZE_API_KEY;
  if (!spaceId || !apiKey) return;

  const metadata = new Metadata();
  metadata.set('space_id', spaceId);
  metadata.set('api_key', apiKey);

  const spanProcessors = [
    new BatchSpanProcessor(
      new GrpcOTLPTraceExporter({
        url: process.env.ARIZE_OTLP_ENDPOINT ?? DEFAULT_ARIZE_OTLP_ENDPOINT,
        metadata,
      }),
    ),
  ];

  if (process.env.ARIZE_TRACING_CONSOLE === 'true') {
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      model_id: process.env.ARIZE_PROJECT_NAME ?? DEFAULT_ARIZE_PROJECT_NAME,
      model_version: process.env.npm_package_version ?? '0.1.0',
      'service.name': 'arkova-worker',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    spanProcessors,
  });

  provider.register();
  arizeTracerInitialized = true;

  process.once('beforeExit', () => {
    void provider.shutdown().catch((error: unknown) => {
      logger.warn({ error }, 'Arize tracing shutdown failed');
    });
  });

  logger.info(
    {
      endpoint: process.env.ARIZE_OTLP_ENDPOINT ?? DEFAULT_ARIZE_OTLP_ENDPOINT,
      projectName: process.env.ARIZE_PROJECT_NAME ?? DEFAULT_ARIZE_PROJECT_NAME,
    },
    'Arize AX tracing initialized',
  );
}

export async function traceAiProviderCall<T>(
  metadata: AiTraceMetadata,
  fn: () => Promise<T>,
  extractMetrics: (result: T) => Partial<AiTraceMetadata> = extractAiTraceResultMetrics,
): Promise<T> {
  initializeArizeTracing();

  const tracer = trace.getTracer(TRACER_NAME);
  const startedAt = Date.now();
  const spanName = `ai.${metadata.provider}.${metadata.operation}`;

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes: buildAiTraceAttributes({
        ...metadata,
        success: false,
      }),
    },
    async (span) => {
      try {
        const result = await fn();
        const resultMetrics = extractMetrics(result);
        span.setAttributes(buildAiTraceAttributes({
          ...metadata,
          ...resultMetrics,
          latencyMs: Date.now() - startedAt,
          success: true,
        }));
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        span.recordException(normalized);
        span.setAttributes(buildAiTraceAttributes({
          ...metadata,
          latencyMs: Date.now() - startedAt,
          success: false,
          errorType: normalized.name,
          errorMessage: redactFreeText(normalized.message),
        }));
        span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.name });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export function buildAiTraceAttributes(input: Record<string, unknown>): Attributes {
  const attrs: Attributes = {
    'openinference.span.kind': 'llm',
  };

  for (const [inputKey, attrKey] of Object.entries(TRACE_ATTRIBUTE_MAP)) {
    const rawValue = input[inputKey];
    const value = coerceTraceAttribute(rawValue, inputKey);
    if (value !== undefined) {
      attrs[attrKey] = value;
    }
  }

  return attrs;
}

export function extractAiTraceResultMetrics(result: unknown): Partial<AiTraceMetadata> {
  if (!result || typeof result !== 'object') return {};
  const record = result as Record<string, unknown>;
  const fields = record.fields && typeof record.fields === 'object'
    ? record.fields as Record<string, unknown>
    : undefined;

  const failureModes = Array.isArray(record.topFailureModes)
    ? record.topFailureModes
    : Array.isArray(record.failureModes)
      ? record.failureModes
      : undefined;
  const fraudSignals = Array.isArray(record.fraudSignals)
    ? record.fraudSignals
    : Array.isArray(fields?.fraudSignals)
      ? fields?.fraudSignals
      : undefined;

  return {
    tokensUsed: finiteNumber(record.tokensUsed),
    confidence: finiteNumber(record.confidence),
    modelVersion: stringValue(record.modelVersion),
    costUsd: finiteNumber(record.costUsd),
    failureMode: stringValue(record.failureMode ?? failureModes?.[0]),
    fraudSignalCount: fraudSignals?.length,
  };
}

function coerceTraceAttribute(value: unknown, inputKey: string): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const redacted = inputKey === 'errorMessage'
    ? redactFreeText(trimmed)
    : trimmed;
  return redacted.slice(0, 240);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactFreeText(value: string): string {
  return FREE_TEXT_REDACTIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    value,
  );
}
