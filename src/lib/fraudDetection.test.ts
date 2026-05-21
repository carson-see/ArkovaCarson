import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAUD_DETECTION_FLAG,
  FRAUD_DETECTION_SAMPLE_BYTES,
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

  it('samples large documents before sending bytes to the worker', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);
    const largeDocument = new File(
      [new Uint8Array(FRAUD_DETECTION_SAMPLE_BYTES + 8).fill(65)],
      'large-degree.pdf',
      { type: 'application/pdf' },
    );
    const workerResult: FraudDetectionResult = {
      fraud_risk_level: 'low',
      fraud_score: 0,
      fraud_signals: [],
      analysis_method: 'client_side_worker_v2',
      processing_time_ms: 3,
    };
    const postMessage = vi.fn();

    class WorkerStub {
      onmessage: ((event: MessageEvent<FraudDetectionResult>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage = postMessage.mockImplementation(() => {
        this.onmessage?.({ data: workerResult } as MessageEvent<FraudDetectionResult>);
      });

      terminate(): void {}
    }

    vi.stubGlobal('Worker', WorkerStub);

    await detectFraudForDocument(largeDocument, {
      credentialType: 'DEGREE',
    });

    const [request] = postMessage.mock.calls[0] as [{ documentBytes: ArrayBuffer }, ArrayBuffer[]];
    expect(request.documentBytes.byteLength).toBe(FRAUD_DETECTION_SAMPLE_BYTES);
  });

  it('returns unknown gracefully when the worker posts an invalid response', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    class WorkerStub {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(): void {
        this.onmessage?.({ data: { analysis_method: 'unexpected' } } as MessageEvent<unknown>);
      }

      terminate(): void {}
    }

    vi.stubGlobal('Worker', WorkerStub);

    await expect(detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    })).resolves.toEqual(unknownFraudDetectionResult());
  });

  it('rejects freeform fraud signal fields before metadata persistence', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);
    const workerResult = {
      fraud_risk_level: 'medium',
      fraud_score: 0.35,
      fraud_signals: [{
        signal_type: 'future_date',
        score: 0.35,
        reason: 'Document contains future year 2099 for Jane Doe.',
        field_affected: 'issuedDate',
      }],
      analysis_method: 'client_side_worker_v2',
      processing_time_ms: 4,
    };

    class WorkerStub {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(): void {
        this.onmessage?.({ data: workerResult } as MessageEvent<unknown>);
      }

      terminate(): void {}
    }

    vi.stubGlobal('Worker', WorkerStub);

    await expect(detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    })).resolves.toEqual(unknownFraudDetectionResult());
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
    const { analyzeDocumentBytes, handleFraudWorkerMessage } = await import('../workers/fraud-detection.worker');
    const result = analyzeDocumentBytes(await cleanDocument.arrayBuffer(), {
      credentialType: 'DEGREE',
      metadataHints: { issuerName: 'University of Michigan' },
    });

    expect(result.fraud_risk_level).toBe('low');
    expect(result.analysis_method).toBe('client_side_worker_v2');
    expect(result.fraud_score).toBeGreaterThanOrEqual(0);
    expect(result.fraud_score).toBeLessThanOrEqual(1);
    expect(handleFraudWorkerMessage({ documentBytes: 'not-bytes', credentialType: 'DEGREE' }))
      .toEqual(unknownFraudDetectionResult());
  });

  it('emits only enum/template fraud signal fields from the worker', async () => {
    const { analyzeDocumentBytes } = await import('../workers/fraud-detection.worker');
    const riskyDocument = new File(
      ['University of Michigan\nBachelor of Science\nIssued May 2099'],
      'future-degree.txt',
      { type: 'text/plain' },
    );

    const result = analyzeDocumentBytes(await riskyDocument.arrayBuffer(), {
      credentialType: 'DEGREE',
      metadataHints: { issuerName: 'University of Michigan' },
    });

    expect(result.fraud_signals).toContainEqual({
      signal_type: 'future_date',
      score: 0.35,
      field_affected: 'issuedDate',
    });
    expect(result.fraud_signals[0]).not.toHaveProperty('reason');
  });
});
