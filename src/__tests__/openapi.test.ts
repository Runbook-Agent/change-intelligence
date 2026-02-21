import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-openapi-${randomUUID()}.db`);
}

describe('OpenAPI Endpoint', () => {
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

  it('GET /api/v1/openapi.json returns 200 with correct content type', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('has openapi version 3.1.0', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
  });

  it('has all expected paths', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const spec = res.json();
    const paths = Object.keys(spec.paths);

    const expectedPaths = [
      '/api/v1/health',
      '/api/v1/events',
      '/api/v1/events/{id}',
      '/api/v1/events/batch',
      '/api/v1/change-sets',
      '/api/v1/correlate',
      '/api/v1/blast-radius',
      '/api/v1/triage',
      '/api/v1/velocity/{service}',
      '/api/v1/graph/import',
      '/api/v1/graph/import/backstage',
      '/api/v1/graph/services',
      '/api/v1/graph/dependencies/{service}',
      '/api/v1/graph/discover',
      '/api/v1/graph/suggestions',
      '/api/v1/webhooks/github',
      '/api/v1/webhooks/gitlab',
      '/api/v1/webhooks/agent',
      '/api/v1/webhooks/aws',
      '/api/v1/webhooks/terraform',
      '/api/v1/webhooks/kubernetes',
      '/api/v1/webhooks/register',
      '/api/v1/webhooks/registrations',
      '/api/v1/webhooks/registrations/{id}',
      '/api/v1/openapi.json',
    ];

    for (const path of expectedPaths) {
      expect(paths).toContain(path);
    }
  });

  it('all paths have operationIds', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const spec = res.json();

    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods as Record<string, any>)) {
        expect((operation as any).operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeDefined();
      }
    }
  });

  it('component schemas include key types', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const spec = res.json();
    const schemas = Object.keys(spec.components.schemas);

    expect(schemas).toContain('ChangeEvent');
    expect(schemas).toContain('CreateEventRequest');
    expect(schemas).toContain('BatchEventsRequest');
    expect(schemas).toContain('BlastRadiusPrediction');
    expect(schemas).toContain('CorrelateRequest');
    expect(schemas).toContain('GraphImportRequest');
    expect(schemas).toContain('WebhookRegistration');
    expect(schemas).toContain('StructuredError');
    expect(schemas).toContain('HealthResponse');
  });
});
