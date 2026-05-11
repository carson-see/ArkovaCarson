/**
 * usePublicSearch + useIssuerRegistry Hook Tests (UF-02 / AUDIT-12)
 * + buildSubtreeIndex tests (SCRUM-1087)
 * + useOrgProfile / usePublicMemberProfile / useOrgSubtree (SCRUM-1788)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  usePublicSearch,
  useIssuerRegistry,
  useOrgProfile,
  useOrgSubtree,
  usePublicMemberProfile,
  buildSubtreeIndex,
  type OrgSubtreeNode,
} from './usePublicSearch';

// Mock supabase with RPC
const mockRpc = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

describe('usePublicSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with empty results', () => {
    const { result } = renderHook(() => usePublicSearch());
    expect(result.current.issuerResults).toEqual([]);
    expect(result.current.searching).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('searches for issuers', async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: 'o1', display_name: 'University of Michigan', legal_name: 'University of Michigan', public_id: 'pub1', verified: true, credential_count: 42 }],
      error: null,
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('Michigan');
    });

    expect(result.current.issuerResults).toHaveLength(1);
    expect(result.current.issuerResults[0].org_name).toBe('University of Michigan');
  });

  it('skips empty queries', async () => {
    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('  ');
    });

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.current.issuerResults).toEqual([]);
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'RPC not found' },
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('test');
    });

    expect(result.current.error).toBe('Search failed. Please try again.');
  });

  it('clears results', async () => {
    mockRpc.mockResolvedValue({
      data: [{ org_id: 'o1', org_name: 'Test U', org_domain: null, credential_count: 1 }],
      error: null,
    });

    const { result } = renderHook(() => usePublicSearch());

    await act(async () => {
      await result.current.searchIssuers('test');
    });
    expect(result.current.issuerResults).toHaveLength(1);

    act(() => {
      result.current.clearResults();
    });
    expect(result.current.issuerResults).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useIssuerRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null registry', () => {
    const { result } = renderHook(() => useIssuerRegistry());
    expect(result.current.registry).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches registry by org ID', async () => {
    const registryData = {
      org_id: 'o1',
      org_name: 'Test University',
      org_domain: 'test.edu',
      total: 5,
      anchors: [
        { public_id: 'ARK-001', credential_type: 'DIPLOMA', filename: 'diploma.pdf', issued_at: null, created_at: '2026-01-01', label: 'BSc CS' },
      ],
    };
    mockRpc.mockResolvedValue({ data: registryData, error: null });

    const { result } = renderHook(() => useIssuerRegistry());

    await act(async () => {
      await result.current.fetchRegistry('o1');
    });

    expect(result.current.registry?.org_name).toBe('Test University');
    expect(result.current.registry?.anchors).toHaveLength(1);
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Not found' } });

    const { result } = renderHook(() => useIssuerRegistry());

    await act(async () => {
      await result.current.fetchRegistry('nonexistent');
    });

    expect(result.current.error).toBe('Not found');
  });
});

// ─── SCRUM-1087: buildSubtreeIndex helper ─────────────────────────────────────

function subNode(over: Partial<OrgSubtreeNode>): OrgSubtreeNode {
  return {
    org_id: over.org_id ?? 'x',
    public_id: null,
    parent_org_id: null,
    display_name: over.display_name ?? 'X',
    domain: null,
    description: null,
    logo_url: null,
    banner_url: null,
    org_type: null,
    website_url: null,
    verification_status: null,
    verified_badge_granted_at: null,
    depth: over.depth ?? 1,
    ...over,
  };
}

describe('buildSubtreeIndex (SCRUM-1087)', () => {
  it('keys roots under null and children under their parent_org_id', () => {
    const idx = buildSubtreeIndex([
      subNode({ org_id: 'root', depth: 1, parent_org_id: null }),
      subNode({ org_id: 'child-a', depth: 2, parent_org_id: 'root' }),
      subNode({ org_id: 'child-b', depth: 2, parent_org_id: 'root' }),
      subNode({ org_id: 'grandchild', depth: 3, parent_org_id: 'child-a' }),
    ]);
    expect(idx.get(null)?.map((n) => n.org_id)).toEqual(['root']);
    expect(idx.get('root')?.map((n) => n.org_id).sort()).toEqual(['child-a', 'child-b']);
    expect(idx.get('child-a')?.map((n) => n.org_id)).toEqual(['grandchild']);
    expect(idx.get('grandchild')).toBeUndefined();
  });

  it('preserves the depth-ordered server payload within each parent bucket', () => {
    const idx = buildSubtreeIndex([
      subNode({ org_id: 'r', depth: 1, parent_org_id: null }),
      subNode({ org_id: 'c1', depth: 2, parent_org_id: 'r', display_name: 'Alpha' }),
      subNode({ org_id: 'c2', depth: 2, parent_org_id: 'r', display_name: 'Beta' }),
    ]);
    expect(idx.get('r')?.[0].display_name).toBe('Alpha');
    expect(idx.get('r')?.[1].display_name).toBe('Beta');
  });

  it('handles a flat list with no children (single root)', () => {
    const idx = buildSubtreeIndex([subNode({ org_id: 'only', parent_org_id: null })]);
    expect(idx.size).toBe(1);
    expect(idx.get(null)?.[0].org_id).toBe('only');
  });
});

// ─── SCRUM-1788: useOrgProfile — privacy gate evidence ──────────────────────

describe('useOrgProfile (SCRUM-1788)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null profile', () => {
    const { result } = renderHook(() => useOrgProfile());
    expect(result.current.profile).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches org profile with public members', async () => {
    const orgProfile = {
      org_id: 'org-1',
      public_id: 'pub_org1',
      display_name: 'Test University',
      domain: 'test.edu',
      description: 'A test university',
      org_type: 'UNIVERSITY',
      website_url: 'https://test.edu',
      linkedin_url: null,
      twitter_url: null,
      logo_url: null,
      location: null,
      founded_date: null,
      industry_tag: null,
      verification_status: 'VERIFIED',
      created_at: '2026-01-01',
      total_credentials: 100,
      secured_credentials: 90,
      credential_breakdown: [{ type: 'DIPLOMA', count: 90 }],
      public_members: [
        { profile_public_id: 'mem_1', display_name: 'Dr. Smith', avatar_url: null, role: 'ORG_ADMIN', is_public_profile: true },
        { profile_public_id: null, display_name: 'Anonymous member', avatar_url: null, role: 'ORG_MEMBER', is_public_profile: false },
      ],
      sub_organizations: [],
    };
    mockRpc.mockResolvedValue({ data: orgProfile, error: null });

    const { result } = renderHook(() => useOrgProfile());

    await act(async () => {
      await result.current.fetchProfile('org-1');
    });

    expect(result.current.profile?.display_name).toBe('Test University');
    expect(result.current.profile?.public_members).toHaveLength(2);
  });

  it('privacy gate: public members include is_public_profile flag for client-side rendering', async () => {
    const orgProfile = {
      org_id: 'org-1',
      public_id: 'pub_org1',
      display_name: 'Test University',
      domain: null,
      description: null,
      org_type: null,
      website_url: null,
      linkedin_url: null,
      twitter_url: null,
      logo_url: null,
      location: null,
      founded_date: null,
      industry_tag: null,
      verification_status: null,
      created_at: '2026-01-01',
      total_credentials: 0,
      secured_credentials: 0,
      credential_breakdown: [],
      public_members: [
        { profile_public_id: 'mem_pub', display_name: 'Visible User', avatar_url: 'https://img.test/a.png', role: 'ORG_ADMIN', is_public_profile: true },
        { profile_public_id: null, display_name: 'Anonymous member', avatar_url: null, role: 'ORG_MEMBER', is_public_profile: false },
      ],
      sub_organizations: [],
    };
    mockRpc.mockResolvedValue({ data: orgProfile, error: null });

    const { result } = renderHook(() => useOrgProfile());

    await act(async () => {
      await result.current.fetchProfile('org-1');
    });

    const publicMember = result.current.profile!.public_members.find(m => m.is_public_profile);
    const privateMember = result.current.profile!.public_members.find(m => !m.is_public_profile);

    expect(publicMember?.display_name).toBe('Visible User');
    expect(publicMember?.profile_public_id).toBe('mem_pub');
    expect(privateMember?.display_name).toBe('Anonymous member');
    expect(privateMember?.profile_public_id).toBeNull();
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Organization not found' } });

    const { result } = renderHook(() => useOrgProfile());

    await act(async () => {
      await result.current.fetchProfile('nonexistent');
    });

    expect(result.current.error).toBe('Organization not found');
    expect(result.current.profile).toBeNull();
  });

  it('unwraps SETOF jsonb response shape', async () => {
    mockRpc.mockResolvedValue({
      data: [{ get_public_org_profile: { org_id: 'org-wrapped', display_name: 'Wrapped', public_id: null, domain: null, description: null, org_type: null, website_url: null, linkedin_url: null, twitter_url: null, logo_url: null, location: null, founded_date: null, industry_tag: null, verification_status: null, created_at: '2026-01-01', total_credentials: 0, secured_credentials: 0, credential_breakdown: [], public_members: [], sub_organizations: [] } }],
      error: null,
    });

    const { result } = renderHook(() => useOrgProfile());

    await act(async () => {
      await result.current.fetchProfile('org-wrapped');
    });

    expect(result.current.profile?.org_id).toBe('org-wrapped');
  });
});

// ─── SCRUM-1788: usePublicMemberProfile — privacy gate evidence ─────────────

describe('usePublicMemberProfile (SCRUM-1788)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null profile', () => {
    const { result } = renderHook(() => usePublicMemberProfile());
    expect(result.current.profile).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches public member profile with organizations', async () => {
    const memberProfile = {
      public_id: 'mem_abc',
      display_name: 'Dr. Jane Smith',
      avatar_url: 'https://img.test/jane.png',
      bio: 'Researcher at Test University',
      social_links: { linkedin: 'https://linkedin.com/in/janesmith' },
      created_at: '2026-01-15',
      organizations: [
        { org_id: 'org-1', public_id: 'pub_org1', display_name: 'Test University', domain: 'test.edu', logo_url: null, verification_status: 'VERIFIED', role: 'ORG_ADMIN' },
      ],
    };
    mockRpc.mockResolvedValue({ data: memberProfile, error: null });

    const { result } = renderHook(() => usePublicMemberProfile());

    await act(async () => {
      await result.current.fetchProfile('mem_abc');
    });

    expect(result.current.profile?.display_name).toBe('Dr. Jane Smith');
    expect(result.current.profile?.organizations).toHaveLength(1);
    expect(result.current.profile?.organizations[0].display_name).toBe('Test University');
  });

  it('privacy gate: RPC returns error for non-public profiles', async () => {
    mockRpc.mockResolvedValue({
      data: [{ get_public_member_profile: { error: 'Profile not found' } }],
      error: null,
    });

    const { result } = renderHook(() => usePublicMemberProfile());

    await act(async () => {
      await result.current.fetchProfile('mem_private');
    });

    expect(result.current.error).toBe('Profile not found');
    expect(result.current.profile).toBeNull();
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Internal error' } });

    const { result } = renderHook(() => usePublicMemberProfile());

    await act(async () => {
      await result.current.fetchProfile('mem_err');
    });

    expect(result.current.error).toBe('Internal error');
  });
});

// ─── SCRUM-1788: useOrgSubtree ──────────────────────────────────────────────

describe('useOrgSubtree (SCRUM-1788)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with null subtree', () => {
    const { result } = renderHook(() => useOrgSubtree());
    expect(result.current.subtree).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches org subtree with depth hierarchy', async () => {
    const subtreeData = {
      root_id: 'org-root',
      max_depth: 3,
      nodes: [
        { org_id: 'org-root', public_id: 'pub_root', parent_org_id: null, display_name: 'Root Org', domain: 'root.edu', description: null, logo_url: null, banner_url: null, org_type: 'UNIVERSITY', website_url: null, verification_status: 'VERIFIED', verified_badge_granted_at: null, depth: 1 },
        { org_id: 'org-child', public_id: 'pub_child', parent_org_id: 'org-root', display_name: 'CS Department', domain: null, description: null, logo_url: null, banner_url: null, org_type: 'DEPARTMENT', website_url: null, verification_status: null, verified_badge_granted_at: null, depth: 2 },
      ],
    };
    mockRpc.mockResolvedValue({ data: subtreeData, error: null });

    const { result } = renderHook(() => useOrgSubtree());

    await act(async () => {
      await result.current.fetchSubtree('org-root');
    });

    expect(result.current.subtree?.root_id).toBe('org-root');
    expect(result.current.subtree?.nodes).toHaveLength(2);
    expect(result.current.subtree?.nodes[1].display_name).toBe('CS Department');
  });

  it('handles RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Org not found' } });

    const { result } = renderHook(() => useOrgSubtree());

    await act(async () => {
      await result.current.fetchSubtree('nonexistent');
    });

    expect(result.current.error).toBe('Org not found');
    expect(result.current.subtree).toBeNull();
  });
});
