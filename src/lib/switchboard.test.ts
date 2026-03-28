/**
 * Switchboard Feature Flags Tests
 *
 * DH-01: Feature flag hot-reload via realtime subscription
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks
const mockChannel = vi.hoisted(() => ({
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
  unsubscribe: vi.fn(),
}));

const mockFrom = vi.hoisted(() => vi.fn());
const mockRpc = vi.hoisted(() => vi.fn());
const mockRemoveChannel = vi.hoisted(() => vi.fn());

vi.mock('./supabase', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    channel: vi.fn(() => mockChannel),
    removeChannel: mockRemoveChannel,
  },
}));

import {
  getFlag,
  getAllFlags,
  FLAGS,
  subscribeFlagChanges,
  unsubscribeFlagChanges,
  _clearCacheForTest,
} from './switchboard';

describe('switchboard feature flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearCacheForTest();
  });

  describe('getFlag', () => {
    it('returns server value when RPC succeeds', async () => {
      mockRpc.mockResolvedValue({ data: true, error: null });
      const result = await getFlag('ENABLE_PROD_NETWORK_ANCHORING');
      expect(result).toBe(true);
    });

    it('returns default value on error', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'fail' } });
      const result = await getFlag('ENABLE_PROD_NETWORK_ANCHORING');
      expect(result).toBe(FLAGS.ENABLE_PROD_NETWORK_ANCHORING);
    });

    it('returns default value on exception', async () => {
      mockRpc.mockRejectedValue(new Error('network'));
      const result = await getFlag('MAINTENANCE_MODE');
      expect(result).toBe(FLAGS.MAINTENANCE_MODE);
    });
  });

  describe('getAllFlags', () => {
    it('returns flags from database', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn(() => ({
          data: [
            { flag_key: 'ENABLE_PROD_NETWORK_ANCHORING', enabled: true },
            { flag_key: 'MAINTENANCE_MODE', enabled: true },
          ],
          error: null,
        })),
      });

      const flags = await getAllFlags();
      expect(flags.ENABLE_PROD_NETWORK_ANCHORING).toBe(true);
      expect(flags.MAINTENANCE_MODE).toBe(true);
      expect(flags.ENABLE_NEW_CHECKOUTS).toBe(true); // default
    });

    it('returns defaults on error', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn(() => ({
          data: null,
          error: { message: 'fail' },
        })),
      });

      const flags = await getAllFlags();
      expect(flags).toEqual({ ...FLAGS });
    });
  });

  describe('DH-01: subscribeFlagChanges (realtime)', () => {
    it('sets up realtime subscription on switchboard_flags table', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);

      expect(mockChannel.on).toHaveBeenCalledWith(
        'postgres_changes',
        expect.objectContaining({
          event: '*',
          schema: 'public',
          table: 'switchboard_flags',
        }),
        expect.any(Function),
      );
      expect(mockChannel.subscribe).toHaveBeenCalled();
    });

    it('calls callback with flag id and new value on UPDATE', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);

      // Get the callback function passed to .on()
      const onCallback = mockChannel.on.mock.calls[0][2];

      // Simulate a realtime UPDATE event
      onCallback({
        eventType: 'UPDATE',
        new: { flag_key: 'MAINTENANCE_MODE', enabled: true },
      });

      expect(callback).toHaveBeenCalledWith('MAINTENANCE_MODE', true);
    });

    it('calls callback on INSERT event', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);

      const onCallback = mockChannel.on.mock.calls[0][2];
      onCallback({
        eventType: 'INSERT',
        new: { flag_key: 'ENABLE_REPORTS', enabled: false },
      });

      expect(callback).toHaveBeenCalledWith('ENABLE_REPORTS', false);
    });

    it('ignores events with unknown flag ids', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);

      const onCallback = mockChannel.on.mock.calls[0][2];
      onCallback({
        eventType: 'UPDATE',
        new: { flag_key: 'UNKNOWN_FLAG', enabled: true },
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('ignores events without flag_key field', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);

      const onCallback = mockChannel.on.mock.calls[0][2];
      onCallback({
        eventType: 'UPDATE',
        new: { enabled: true },
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('unsubscribeFlagChanges removes the channel', () => {
      const callback = vi.fn();
      subscribeFlagChanges(callback);
      unsubscribeFlagChanges();

      expect(mockRemoveChannel).toHaveBeenCalledWith(mockChannel);
    });
  });
});
