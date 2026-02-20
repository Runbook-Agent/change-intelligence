import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-batch-${randomUUID()}.db`);
}

describe('Batch Event Endpoint', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({
      dbPath,
      graphData: {
        services: [
          { id: 'api', name: 'API', type: 'service', tier: 'critical', tags: [] },
        ],
        dependencies: [],
      },
    });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('creates a batch of 3 events and returns 201', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Deploy v1' },
          { service: 'api', changeType: 'config_change', summary: 'Update config' },
          { service: 'api', changeType: 'deployment', summary: 'Deploy v2' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.stats.total).toBe(3);
    expect(body.stats.created).toBe(3);
    expect(body.stats.duplicates).toBe(0);
    expect(body.results).toHaveLength(3);
    expect(body.results[0].status).toBe('created');
    expect(body.results[0].index).toBe(0);
  });

  it('returns all duplicates with 200 when all idempotency keys match', async () => {
    // First batch
    await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Deploy v1', idempotencyKey: 'batch-key-1' },
          { service: 'api', changeType: 'deployment', summary: 'Deploy v2', idempotencyKey: 'batch-key-2' },
        ],
      },
    });

    // Same batch again
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Deploy v1', idempotencyKey: 'batch-key-1' },
          { service: 'api', changeType: 'deployment', summary: 'Deploy v2', idempotencyKey: 'batch-key-2' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats.created).toBe(0);
    expect(body.stats.duplicates).toBe(2);
  });

  it('returns 201 with mixed new and duplicate events', async () => {
    // Create one event first
    await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Existing', idempotencyKey: 'existing-key' },
        ],
      },
    });

    // Batch with one duplicate and one new
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Existing', idempotencyKey: 'existing-key' },
          { service: 'api', changeType: 'deployment', summary: 'New event', idempotencyKey: 'new-key' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.stats.created).toBe(1);
    expect(body.stats.duplicates).toBe(1);
    expect(body.results[0].status).toBe('duplicate');
    expect(body.results[1].status).toBe('created');
  });

  it('returns 400 for empty events array', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: { events: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 for invalid event in array', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: {
        events: [
          { service: 'api', changeType: 'deployment', summary: 'Valid' },
          { service: '', changeType: 'deployment', summary: 'Invalid - empty service' },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 for batch exceeding 1000 events', async () => {
    const events = Array.from({ length: 1001 }, (_, i) => ({
      service: 'api',
      changeType: 'deployment',
      summary: `Event ${i}`,
    }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events/batch',
      payload: { events },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});
