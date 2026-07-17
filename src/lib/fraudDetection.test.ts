import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FRAUD_DETECTION_FLAG,
  FRAUD_DETECTION_SAMPLE_BYTES,
  FRAUD_DETECTION_WORKER_TIMEOUT_MS,
  detectFraudForDocument,
  isFraudMetadataKey,
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

type WorkerStubInstance = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

function createWorkerStub(config: {
  response?: unknown;
  shouldError?: boolean;
  postMessage?: (
    instance: WorkerStubInstance,
    message: unknown,
    transfer?: Transferable[],
  ) => void;
  postMessageSpy?: ReturnType<typeof vi.fn>;
  terminateSpy?: ReturnType<typeof vi.fn>;
} = {}) {
  const hasResponse = Object.prototype.hasOwnProperty.call(config, 'response');
  const postMessage = config.postMessageSpy ?? vi.fn();
  const terminate = config.terminateSpy ?? vi.fn();

  return class WorkerStub {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage = postMessage.mockImplementation((message: unknown, transfer?: Transferable[]) => {
      if (config.postMessage) {
        config.postMessage(this, message, transfer);
        return;
      }
      if (config.shouldError) {
        this.onerror?.(new ErrorEvent('error', { message: 'worker failed' }));
        return;
      }
      if (hasResponse) {
        this.onmessage?.({ data: config.response } as MessageEvent<unknown>);
      }
    });

    terminate = terminate;
  };
}

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

    vi.stubGlobal('Worker', createWorkerStub({
      response: workerResult,
      postMessageSpy: postMessage,
      terminateSpy: terminate,
    }));

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

    vi.stubGlobal('Worker', createWorkerStub({
      response: workerResult,
      postMessageSpy: postMessage,
    }));

    await detectFraudForDocument(largeDocument, {
      credentialType: 'DEGREE',
    });

    const [request] = postMessage.mock.calls[0] as [{ documentBytes: ArrayBuffer }, ArrayBuffer[]];
    expect(request.documentBytes.byteLength).toBe(FRAUD_DETECTION_SAMPLE_BYTES);
  });

  it('returns unknown gracefully when the worker posts an invalid response', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    vi.stubGlobal('Worker', createWorkerStub({
      response: { analysis_method: 'unexpected' },
    }));

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

    vi.stubGlobal('Worker', createWorkerStub({ response: workerResult }));

    await expect(detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    })).resolves.toEqual(unknownFraudDetectionResult());
  });

  it('returns unknown gracefully when the worker cannot run', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    vi.stubGlobal('Worker', createWorkerStub({ shouldError: true }));

    await expect(detectFraudForDocument(cleanDocument, {
      credentialType: 'DEGREE',
    })).resolves.toEqual(unknownFraudDetectionResult());
  });

  it('returns unknown gracefully when the worker does not respond', async () => {
    vi.useFakeTimers();
    vi.mocked(getFlag).mockResolvedValueOnce(true);

    vi.stubGlobal('Worker', createWorkerStub());

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

  it('ignores inherited metadata hint properties at the worker boundary', async () => {
    const { handleFraudWorkerMessage } = await import('../workers/fraud-detection.worker');
    const inheritedHints = Object.create({ issuerName: 'Mallory University' }) as Record<string, string>;

    const result = handleFraudWorkerMessage({
      documentBytes: await cleanDocument.arrayBuffer(),
      credentialType: 'DEGREE',
      metadataHints: inheritedHints,
    });

    expect(result.fraud_signals).toEqual([]);
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

describe('isFraudMetadataKey (BUG-2026-07-17-010, SCRUM-2910)', () => {
  it.each([
    'fraud_score',
    'fraud_risk_level',
    'fraud_signals',
    'fraud_analysis_method',
    'fraud_processing_time_ms',
    'fraudSignals',
    'Fraud_Score',
    'FRAUD_SCORE',
    ' fraud_score ',
    'fraud-score',
    'fraud score',
  ])('treats %j as a fraud metadata key', (key) => {
    expect(isFraudMetadataKey(key)).toBe(true);
  });

  it.each(['issuer', 'field_of_study', 'confidence', 'defrauded_notes', 'antifraud'])(
    'does not flag unrelated key %j',
    (key) => {
      expect(isFraudMetadataKey(key)).toBe(false);
    },
  );
});
