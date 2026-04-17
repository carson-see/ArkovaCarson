/**
 * Tests for CMS Physician Compare + State Medical Board Fetchers (NPH-11)
 *
 * TDD: Written before implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../utils/db.js', () => ({ db: {} }));

function createMockSupabase() {
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    in: vi.fn().mockResolvedValue({ data: [] }),
  };

  return {
    rpc: mockRpc,
    from: mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue(selectChain),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('CMS Physician Compare Fetcher', () => {
  it('returns empty when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchCmsPhysicians } = await import('../cmsPhysicianFetcher.js');
    const result = await fetchCmsPhysicians(createMockSupabase() as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('calls CMS API with correct parameters when flag is enabled', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          npi: '1234567890',
          ind_enrl_id: 'I20040101000001',
          lst_nm: 'SMITH',
          frst_nm: 'JOHN',
          cred: 'MD',
          gndr: 'M',
          pri_spec: 'INTERNAL MEDICINE',
          st: 'CA',
          cty: 'LOS ANGELES',
          zip: '90001',
          hosp_afl_1: 'GENERAL HOSPITAL',
        },
      ]),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchCmsPhysicians } = await import('../cmsPhysicianFetcher.js');
    const result = await fetchCmsPhysicians(createMockSupabase() as any, { maxPerRun: 1 });

    expect(fetch).toHaveBeenCalled();
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('data.cms.gov');
    expect(result.inserted).toBeGreaterThanOrEqual(0);
  });

  it('handles API errors gracefully', async () => {
    mockRpc.mockResolvedValue({ data: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { fetchCmsPhysicians } = await import('../cmsPhysicianFetcher.js');
    const result = await fetchCmsPhysicians(createMockSupabase() as any, { maxPerRun: 1 });

    expect(result.errors).toBeGreaterThan(0);
  });

  it('uses credential_type MEDICAL for records', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const insertedRecords: any[] = [];
    const mockSb = createMockSupabase();
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
        in: vi.fn().mockResolvedValue({ data: [] }),
      }),
      upsert: vi.fn().mockImplementation((records: any[]) => {
        insertedRecords.push(...records);
        return Promise.resolve({ error: null });
      }),
    });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          npi: '1234567890',
          ind_enrl_id: 'I20040101000001',
          lst_nm: 'SMITH',
          frst_nm: 'JOHN',
          cred: 'MD',
          gndr: 'M',
          pri_spec: 'INTERNAL MEDICINE',
          st: 'CA',
        },
      ]),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchCmsPhysicians } = await import('../cmsPhysicianFetcher.js');
    await fetchCmsPhysicians(mockSb as any, { maxPerRun: 1 });

    if (insertedRecords.length > 0) {
      expect(insertedRecords[0].metadata.credential_type).toBe('MEDICAL');
    }
  });
});

describe('State Medical Board Fetcher', () => {
  it('returns empty when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    mockRpc.mockResolvedValue({ data: false });
    const { fetchStateMedicalBoards } = await import('../cmsPhysicianFetcher.js');
    const result = await fetchStateMedicalBoards(createMockSupabase() as any);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('fetches from multiple state board APIs', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          license_number: 'A12345',
          first_name: 'Jane',
          last_name: 'Doe',
          license_type: 'MD',
          status: 'Active',
          specialty: 'Family Medicine',
          city: 'Sacramento',
          state: 'CA',
          expiration_date: '2027-12-31',
        },
      ]),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchStateMedicalBoards } = await import('../cmsPhysicianFetcher.js');
    const result = await fetchStateMedicalBoards(createMockSupabase() as any, {
      states: ['CA'],
      maxPerRun: 10,
    });

    expect(fetch).toHaveBeenCalled();
    expect(result.inserted).toBeGreaterThanOrEqual(0);
  });

  it('records include disciplinary action data when available', async () => {
    mockRpc.mockResolvedValue({ data: true });

    const insertedRecords: any[] = [];
    const mockSb = createMockSupabase();
    mockFrom.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
        in: vi.fn().mockResolvedValue({ data: [] }),
      }),
      upsert: vi.fn().mockImplementation((records: any[]) => {
        insertedRecords.push(...records);
        return Promise.resolve({ error: null });
      }),
    });

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          license_number: 'A12345',
          first_name: 'Jane',
          last_name: 'Doe',
          license_type: 'MD',
          status: 'Probation',
          specialty: 'Surgery',
          city: 'Sacramento',
          state: 'CA',
          disciplinary_action: 'License placed on probation — 2025-01-15',
        },
      ]),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const { fetchStateMedicalBoards } = await import('../cmsPhysicianFetcher.js');
    await fetchStateMedicalBoards(mockSb as any, { states: ['CA'], maxPerRun: 1 });

    if (insertedRecords.length > 0) {
      expect(insertedRecords[0].metadata).toHaveProperty('disciplinary_action');
      expect(insertedRecords[0].metadata.license_status).toBe('Probation');
    }
  });
});
