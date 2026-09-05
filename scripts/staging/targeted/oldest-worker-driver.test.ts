import { describe, expect, it } from 'vitest';
import { assertQueueScope, assertFlagResults, assertProviderLog } from './oldest-worker-driver.js';
describe('oldest worker release evidence rejects hollow successes', () => {
  it('requires an expected queue record and rejects foreign records', () => {
    expect(() => assertQueueScope({items:[]},['own'],['foreign'])).toThrow();
    expect(() => assertQueueScope({items:[{public_id:'own'},{public_id:'foreign'}]},['own'],['foreign'])).toThrow();
    expect(() => assertQueueScope({items:[{public_id:'own'}]},['own'],['foreign'])).not.toThrow();
  });
  it('does not accept a zero-work response as enabled gate proof', () => {
    expect(() => assertFlagResults('on',{processed:0},{skipped:false})).toThrow();
    expect(() => assertFlagResults('on',{processed:1},{skipped:true})).toThrow();
    expect(() => assertFlagResults('on',{processed:1},{checked:0})).not.toThrow();
  });
  it('requires both disabled responses, not just a successful HTTP status', () => {
    expect(() => assertFlagResults('off',{processed:0},{skipped:false})).toThrow();
    expect(() => assertFlagResults('off',{processed:1},{skipped:true})).toThrow();
    expect(() => assertFlagResults('off',{processed:0},{skipped:true,reason:'ENABLE_EXPIRY_ALERTS flag is disabled'})).not.toThrow();
  });
  it('requires positive factory log evidence, rejects raw URL key and token', () => {
    expect(() => assertProviderLog([], 'marker')).toThrow();
    expect(() => assertProviderLog([{jsonPayload:{rpcOrigin:'https://rpc-soak.invalid',provider:'getblock',rpcUrl:'hidden'}}], 'marker')).toThrow();
    expect(() => assertProviderLog([{jsonPayload:{rpcOrigin:'https://rpc-soak.invalid',provider:'getblock',msg:'marker'}}], 'marker')).toThrow();
    expect(() => assertProviderLog([{jsonPayload:{rpcOrigin:'https://rpc-soak.invalid',provider:'getblock'}}], 'marker')).not.toThrow();
  });
});
