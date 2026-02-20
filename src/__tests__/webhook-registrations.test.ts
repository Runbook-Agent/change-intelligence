import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID, createHmac } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-webhook-reg-${randomUUID()}.db`);
}

describe('Webhook Registration Endpoint', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({ dbPath });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('POST /api/v1/webhooks/register returns 201 with valid body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: {
        url: 'https://example.com/webhook',
        services: ['api'],
        changeTypes: ['deployment'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.url).toBe('https://example.com/webhook');
    expect(body.services).toEqual(['api']);
    expect(body.active).toBe(true);
  });

  it('GET /api/v1/webhooks/registrations lists registrations', async () => {
    await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: { url: 'https://example.com/hook1' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: { url: 'https://example.com/hook2' },
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/webhooks/registrations',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().registrations).toHaveLength(2);
  });

  it('DELETE /api/v1/webhooks/registrations/:id returns 204', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: { url: 'https://example.com/hook' },
    });
    const { id } = createRes.json();

    const deleteRes = await server.inject({
      method: 'DELETE',
      url: `/api/v1/webhooks/registrations/${id}`,
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify deleted
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/v1/webhooks/registrations',
    });
    expect(listRes.json().registrations).toHaveLength(0);
  });

  it('DELETE non-existent registration returns 404', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/v1/webhooks/registrations/nonexistent-id',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('POST with invalid URL returns 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('dispatches webhook after event creation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    // Register a webhook
    await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: { url: 'https://example.com/hook' },
    });

    // Create an event
    await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { service: 'api', changeType: 'deployment', summary: 'Deploy v1' },
    });

    // Wait for setImmediate to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it('includes HMAC signature when secret is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(new Response('OK', { status: 200 }));

    // Register a webhook with secret
    await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/register',
      payload: {
        url: 'https://example.com/secure-hook',
        secret: 'my-secret',
      },
    });

    // Create an event
    await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { service: 'api', changeType: 'deployment', summary: 'Deploy v1' },
    });

    // Wait for setImmediate to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    const requestInit = callArgs[1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['X-Webhook-Signature']).toBeDefined();
    expect(headers['X-Webhook-Signature']).toMatch(/^sha256=/);

    // Verify the HMAC is correct
    const body = requestInit.body as string;
    const expectedSig = 'sha256=' + createHmac('sha256', 'my-secret').update(body).digest('hex');
    expect(headers['X-Webhook-Signature']).toBe(expectedSig);

    fetchSpy.mockRestore();
  });
});
