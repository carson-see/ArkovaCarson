import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmailConfirmationRouter, type ConfirmationDependencies } from './email-confirmation.js';

const userId = 'd4887cc0-c28d-41f7-9ed6-048d23ddf614';
const email = 'fixture@example.test';
const token = 'provider-issued-email-token-not-a-real-secret';
const session = { access_token: 'verified-access', refresh_token: 'verified-refresh' };
const manage = vi.fn();
const generate = vi.fn();
const prove = vi.fn();
const refresh = vi.fn();
const deliver = vi.fn();
const identify = vi.fn();
const dependencies: ConfirmationDependencies = { manage, generate, prove, refresh, deliver, identify };
const app = express().use(express.json()).use(createEmailConfirmationRouter(dependencies));

describe('OAuth mailbox confirmation boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    identify.mockResolvedValue(userId);
    generate.mockResolvedValue({ tokenHash: token, userId, email });
    prove.mockResolvedValue({ userId, email, refreshToken: 'pending-refresh' });
    refresh.mockResolvedValue(session);
    deliver.mockResolvedValue(true);
    manage.mockImplementation(async (action: string) => ({
      claim: { required: true, email, attemptId: 'attempt', retryAfterSeconds: 90 },
      register: { required: true }, sent: { required: true, sent: true, retryAfterSeconds: 90 },
      lookup: { userId, email }, complete: { required: false },
      status: { required: true, email, sent: false, retryAfterSeconds: 0 },
    }[action]));
  });
  it('exposes actionable status to a pending identity', async () => {
    expect((await request(app).get('/')).body).toMatchObject({ required: true, sent: false });
  });
  it('does not disclose status or send to an unauthenticated caller', async () => {
    identify.mockResolvedValue(null);
    expect((await request(app).post('/send')).status).toBe(401);
    expect(manage).not.toHaveBeenCalled();
  });
  it('sends only to server-owned email and never returns the bearer link', async () => {
    const result = await request(app).post('/send').send({ email: 'attacker@example.test' });
    expect(result.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(email);
    expect(deliver).toHaveBeenCalledWith(email, token, userId);
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(manage.mock.calls.map(([action]) => action)).toEqual(['claim', 'register', 'sent']);
  });
  it('honors atomic cooldown before generating another provider token', async () => {
    manage.mockResolvedValue({ error: 'cooldown', retryAfterSeconds: 42 });
    const result = await request(app).post('/send');
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('42');
    expect(generate).not.toHaveBeenCalled();
  });
  it('fails closed if provider-generated identity differs', async () => {
    generate.mockResolvedValue({ tokenHash: token, userId: 'other-user', email });
    expect((await request(app).post('/send')).status).toBe(503);
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not report sent when delivery fails or was skipped', async () => {
    deliver.mockResolvedValue(false);
    expect((await request(app).post('/send')).status).toBe(503);
    expect(manage.mock.calls.map(([action]) => action)).toEqual(['claim', 'register']);
  });
  it('checks registered challenge before provider redemption', async () => {
    manage.mockResolvedValue({ error: 'invalid_link' });
    expect((await request(app).post('/complete').send({ token })).status).toBe(400);
    expect(prove).not.toHaveBeenCalled();
  });
  it.each([{ userId: 'other-user', email }, { userId, email: 'changed@example.test' }])(
    'rejects mismatched mailbox proof %j', async (identity) => {
      prove.mockResolvedValue({ ...identity, refreshToken: 'pending-refresh' });
      expect((await request(app).post('/complete').send({ token })).status).toBe(400);
      expect(manage.mock.calls.map(([action]) => action)).toEqual(['lookup']);
      expect(refresh).not.toHaveBeenCalled();
    });
  it('binds completion to proof identity across devices, then refreshes', async () => {
    identify.mockResolvedValue('different-existing-browser-user');
    const result = await request(app).post('/complete').send({ token, userId: 'attacker' });
    expect(result.body).toEqual({ complete: true, session });
    expect(identify).not.toHaveBeenCalled();
    expect(manage).toHaveBeenLastCalledWith('complete', expect.objectContaining({ p_user_id: userId, p_email: email }));
    expect(JSON.stringify(manage.mock.calls)).not.toContain(token);
  });
  it('does not refresh if atomic SQL completion rejects changed email or replay', async () => {
    manage.mockImplementation(async (action) => action === 'lookup' ? { userId, email } : { error: 'invalid_link' });
    expect((await request(app).post('/complete').send({ token })).status).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('offers fresh-link recovery if provider proof was consumed but SQL failed', async () => {
    manage.mockImplementation(async (action) => {
      if (action === 'lookup') return { userId, email };
      throw new Error('private backend detail');
    });
    const result = await request(app).post('/complete').send({ token });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('confirmation_retry_required');
    expect(JSON.stringify(result.body)).not.toContain('private backend');
  });
  it('retains completion if the final refresh response is lost', async () => {
    refresh.mockRejectedValue(new Error('transport'));
    const result = await request(app).post('/complete').send({ token });
    expect(result.body).toEqual({ complete: true, session: null });
  });
});
