import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAUD_DETECTION_FLAG,
  FRAUD_DETECTION_WORKER_TIMEOUT_MS,
  detectFraudForDocument,
  unknownFraudDetectionResult,
  type FraudDetectionResult,
} from './fraudDetection';
import { getFlag } from './switchboard';

vi.mock('./switchboard', () => ({
  getFlag: vi.fn(),
}));

const cleanDocument = new File(
  ['University of Michigan\nBachelor of Science\nIssued May 2025'],
  'clean-degree.txt',
  { type: 'text/plain' },
);

describe('SCRUM-1955 fraud detection worker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps fraud detection off by default when the flag lookup falls back', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(false);

    const result = await detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
      metadataHints: { issuerName: 'University of Michigan' },
    });

    expect(getFlag).toHaveBeenCalledWith(FRAUD_DETECTION_FLAG);
    expect(result).toEqual(null);
  });

  it('activates the Web Worker when ENABLE_FRAUD_DETECTION is on', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);
    const workerResult: FraudDetectionResult = {
      fraud_risk_level: 'low',
      fraud_score: 0,
      fraud_signals: [],
      analysis_method: 'client_side_worker_v2',
      processing_time_ms: 4,
    };
    const postMessage = vi.fn();
    const terminate = vi.fn();

    class WorkerStub {
      onmessage: ((event: MessageEvent<FraudDetectionResult>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage = postMessage.mockImplementation(() => {
        this.onmessage?.({ data: workerResult } as MessageEvent<FraudDetectionResult>);
      });

      terminate = terminate;
    }

    vi.stubGlobal('Worker', WorkerStub);

    const result = await detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
      metadataHints: { issuerName: 'University of Michigan' },
    });

    expect(result).toEqual(workerResult);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('returns unknown gracefully when the worker cannot run', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    class WorkerStub {
      onmessage: ((event: MessageEvent<FraudDetectionResult>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(): void {
        this.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
      }

      terminate(): void {}
    }

    vi.stubGlobal('Worker', WorkerStub);

    await expect(detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    })).resolves.toEqual(unknownFraudDetectionResult());
  });

  it('returns unknown gracefully when the worker does not respond', async () => {
    vi.useFakeTimers();
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    class WorkerStub {
      onmessage: ((event: MessageEvent<FraudDetectionResult>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(): void {}

      terminate(): void {}
    }

    vi.stubGlobal('Worker', WorkerStub);

    const pending = detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    });

    await vi.advanceTimersByTimeAsync(FRAUD_DETECTION_WORKER_TIMEOUT_MS);

    await expect(pending).resolves.toEqual(unknownFraudDetectionResult());
    vi.useRealTimers();
  });

  it('produces low risk for a known-clean document without server input', async () => {
    const { analyzeDocumentBytes } = await import('../workers/fraud-detection.worker');
    const result = analyzeDocumentBytes(await cleanDocument.arrayBuffer(), {
      credentialType: 'DEGREE',
      metadataHints: { issuerName: 'University of Michigan' },
    });

    expect(result.fraud_risk_level).toBe('low');
    expect(result.analysis_method).toBe('client_side_worker_v2');
    expect(result.fraud_score).toBeGreaterThanOrEqual(0);
    expect(result.fraud_score).toBeLessThanOrEqual(1);
  });
});
