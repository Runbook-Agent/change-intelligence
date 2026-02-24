import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-admin-auth-${randomUUID()}.db`);
}

describe('Admin auth boundary', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({
      dbPath,
      adminToken: 'admin-token',
      graphData: {
        services: [{ id: 'api', name: 'API', type: 'service', tags: [] }],
        dependencies: [],
      },
    });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('rejects protected mutation without admin token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { service: 'api', changeType: 'deployment', summary: 'deploy' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('allows protected mutation with valid admin token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      headers: { authorization: 'Bearer admin-token' },
      payload: { service: 'api', changeType: 'deployment', summary: 'deploy' },
    });

    expect(res.statusCode).toBe(201);
  });

  it('allows non-protected read endpoints without admin token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/events',
    });

    expect(res.statusCode).toBe(200);
  });

  it('protects webhook registration list endpoint', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/webhooks/registrations',
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('does not require admin token for provider webhook ingestion', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/webhooks/agent',
      payload: {
        agent: 'claude-code',
        action: 'commit',
        service: 'api',
        summary: 'agent change',
      },
    });

    expect(res.statusCode).toBe(201);
  });
});
