/**
 * Tests for CNPJ Brazil Companies Fetcher
 *
 * Tests URL construction, rate limiting, record transformation,
 * error handling, and deduplication. All HTTP calls mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pipeline module's delay to be a no-op (avoids timer issues)
vi.mock('../utils/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    delay: vi.fn().mockResolvedValue(undefined),
  };
});

import { fetchCnpjBrCompanies } from './brazilFetcher.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createMockSupabase(flagEnabled = true) {
  const insertFn = vi.fn().mockResolvedValue({ error: null });

  return {
    rpc: vi.fn().mockResolvedValue({ data: flagEnabled }),
    from: vi.fn().mockImplementation(() => ({
      insert: insertFn,
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }),
        }),
      }),
    })),
    _insertFn: insertFn,
  };
}

function makeBrasilApiResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    cnpj: '33000167000101',
    razao_social: 'PETROLEO BRASILEIRO S.A. PETROBRAS',
    nome_fantasia: 'PETROBRAS',
    descricao_situacao_cadastral: 'ATIVA',
    data_inicio_atividade: '1966-09-28',
    cnae_fiscal_descricao: 'Extração de petróleo e gás natural',
    cnae_fiscal: 600001,
    logradouro: 'AVENIDA REPUBLICA DO CHILE',
    numero: '65',
    complemento: '',
    bairro: 'CENTRO',
    municipio: 'RIO DE JANEIRO',
    uf: 'RJ',
    cep: '20031170',
    natureza_juridica: 'Sociedade de Economia Mista',
    porte: 'DEMAIS',
    capital_social: 205431960490.97,
    ...overrides,
  };
}

describe('brazilFetcher', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should skip when ENABLE_PUBLIC_RECORDS_INGESTION is disabled', async () => {
    const supabase = createMockSupabase(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should construct correct BrasilAPI URL', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeBrasilApiResponse(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('brasilapi.com.br');
    expect(url).toContain('33000167000101');
  });

  it('should transform CNPJ records and insert into public_records', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeBrasilApiResponse(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.inserted).toBe(1);
    expect(supabase.from).toHaveBeenCalledWith('public_records');
  });

  it('should handle API 404 (CNPJ not found) as skip', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['99999999999999']);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('should handle API 429 (rate limit) as error', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.errors).toBe(1);
  });

  it('should handle network errors gracefully', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockRejectedValue(new Error('Network error'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.errors).toBe(1);
  });

  it('should handle Supabase insert errors', async () => {
    const supabase = createMockSupabase(true);
    supabase.from = vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB error', code: '42P01' } }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }),
        }),
      }),
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeBrasilApiResponse(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.errors).toBe(1);
  });

  it('should treat duplicate constraint (23505) as skip', async () => {
    const supabase = createMockSupabase(true);
    supabase.from = vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockResolvedValue({ error: { message: 'duplicate', code: '23505' } }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [] }),
          }),
        }),
      }),
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeBrasilApiResponse(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('should skip duplicate records found via select', async () => {
    const supabase = createMockSupabase(true);
    supabase.from = vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ id: 'existing-id' }] }),
          }),
        }),
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result.skipped).toBe(1);
    expect(result.inserted).toBe(0);
    // Should not have called fetch since dedup check found existing
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should use seed CNPJs when no custom list provided', async () => {
    const supabase = createMockSupabase(true);
    // Return skipped for all to avoid needing real API responses
    supabase.from = vi.fn().mockImplementation(() => ({
      insert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [{ id: 'existing' }] }),
          }),
        }),
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any);
    // Should have processed multiple seed CNPJs (all skipped since they "exist")
    expect(result.skipped).toBeGreaterThan(5);
  });

  it('should return result with correct shape', async () => {
    const supabase = createMockSupabase(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeBrasilApiResponse(),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchCnpjBrCompanies(supabase as any, ['33000167000101']);
    expect(result).toHaveProperty('inserted');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('errors');
  });
});
