import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPrivateAnchorList } from './usePrivateAnchorList';

const calls: Array<[string, ...unknown[]]> = [];
const mockEq = vi.fn();
let rows: unknown[] = [];
const chain: Record<string, (...args: unknown[]) => unknown> = {};
for (const method of ['select','is','not','order']) chain[method] = (...args: unknown[]) => { calls.push([method,...args]); return chain; };
chain.eq = (...args: unknown[]) => { mockEq(...args); calls.push(['eq',...args]); return chain; };
chain.range = async (...args: unknown[]) => { calls.push(['range',...args]); return { data: rows, error: null }; };
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(() => chain) } }));

const row = (id: number) => ({ id:`id-${id}`,filename:`proof-${id}.pdf`,fingerprint:'a'.repeat(64),status:'SECURED',created_at:'2026-09-27T10:00:00Z',chain_timestamp:null,file_size:1,credential_type:'OTHER',chain_tx_id:null,chain_block_height:null,public_id:`ARK-${id}`,metadata:null,folder_id:null,anchor_private_tags:[{tag:'audit'}] });

describe('fetchPrivateAnchorList', () => {
  beforeEach(() => { calls.length=0; rows=[]; mockEq.mockReset(); });
  it('uses an inner relational tag filter plus explicit user ownership and a 26-row page', async () => {
    rows=Array.from({length:26},(_,i)=>row(i));
    const result=await fetchPrivateAnchorList({userId:'user-1',orgId:null,role:'INDIVIDUAL',tag:' Audit ',scope:'user',page:0});
    expect(calls).toContainEqual(['select',expect.stringContaining('anchor_private_tags!inner')]);
    expect(calls).toContainEqual(['eq','anchor_private_tags.owner_user_id','user-1']);
    expect(mockEq).toHaveBeenCalledWith('user_id','user-1');
    expect(calls).toContainEqual(['is','anchor_private_tags.org_id',null]);
    expect(calls).toContainEqual(['eq','anchor_private_tags.normalized_tag','audit']);
    expect(calls).toContainEqual(['is','metadata->>pipeline_source',null]);
    expect(calls).toContainEqual(['range',0,25]);
    expect(calls.filter(([method]) => method === 'order')).toEqual([['order','created_at',{ascending:false}],['order','id',{ascending:false}]]);
    expect(result.records).toHaveLength(25); expect(result.hasMore).toBe(true);
  });
  it('retains exact-org and member-owned anchor predicates for organization tags', async () => {
    await fetchPrivateAnchorList({userId:'user-1',orgId:'org-1',role:'INDIVIDUAL',tag:'audit',scope:'organization',page:1});
    expect(calls).toContainEqual(['eq','anchor_private_tags.org_id','org-1']);
    expect(calls).toContainEqual(['eq','org_id','org-1']);
    expect(calls).toContainEqual(['eq','user_id','user-1']);
    expect(calls).toContainEqual(['range',25,50]);
  });
  it('does not query organization tags without an active organization', async () => {
    const result=await fetchPrivateAnchorList({userId:'user-1',orgId:null,role:'INDIVIDUAL',tag:'audit',scope:'organization',page:0});
    expect(result).toEqual({records:[],hasMore:false}); expect(calls).toEqual([]);
  });
});
