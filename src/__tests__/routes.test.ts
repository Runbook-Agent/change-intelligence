import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-routes-${randomUUID()}.db`);
}

describe('Routes', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({
      dbPath,
      graphData: {
        services: [
          { id: 'api', name: 'API', type: 'service', tier: 'critical', tags: [] },
          { id: 'db', name: 'Database', type: 'database', tags: [] },
        ],
        dependencies: [
          { source: 'api', target: 'db', type: 'database', criticality: 'critical' },
        ],
      },
    });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('Health', () => {
    it('GET /api/v1/health returns healthy', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('healthy');
      expect(body.graph.services).toBe(2);
    });
  });

  describe('Events CRUD', () => {
    it('POST creates an event', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: {
          service: 'api',
          changeType: 'deployment',
          summary: 'Deploy v1.0',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.service).toBe('api');
      // Blast radius should be auto-computed since graph is available
      expect(body.blastRadius).toBeDefined();
    });

    it('GET retrieves an event by ID', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'test' },
      });
      const { id } = createRes.json();

      const res = await server.inject({ method: 'GET', url: `/api/v1/events/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    it('GET returns 404 for non-existent event', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/events/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('PATCH updates an event', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'test', status: 'in_progress' },
      });
      const { id } = createRes.json();

      const res = await server.inject({
        method: 'PATCH',
        url: `/api/v1/events/${id}`,
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('completed');
    });

    it('DELETE removes an event', async () => {
      const createRes = await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'test' },
      });
      const { id } = createRes.json();

      const res = await server.inject({ method: 'DELETE', url: `/api/v1/events/${id}` });
      expect(res.statusCode).toBe(204);

      const getRes = await server.inject({ method: 'GET', url: `/api/v1/events/${id}` });
      expect(getRes.statusCode).toBe(404);
    });
  });

  describe('Events Query', () => {
    beforeEach(async () => {
      await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'api deploy', environment: 'production' },
      });
      await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'db', changeType: 'db_migration', summary: 'db migration', environment: 'staging' },
      });
    });

    it('filters by service', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/events?services=api' });
      expect(res.statusCode).toBe(200);
      const events = res.json();
      expect(events.length).toBe(1);
      expect(events[0].service).toBe('api');
    });

    it('filters by environment', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/events?environment=staging' });
      const events = res.json();
      expect(events.length).toBe(1);
      expect(events[0].environment).toBe('staging');
    });
  });

  describe('Correlate', () => {
    it('POST /api/v1/correlate returns correlations', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'deploy' },
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/correlate',
        payload: { affected_services: ['api'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.correlations).toBeDefined();
      expect(body.correlations.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 for invalid payload', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/correlate',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Blast Radius', () => {
    it('POST /api/v1/blast-radius returns prediction', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/blast-radius',
        payload: { services: ['db'] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.directServices).toContain('api');
      expect(body.criticalPathAffected).toBe(true);
    });
  });

  describe('Velocity', () => {
    it('GET /api/v1/velocity/:service returns metrics', async () => {
      await server.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { service: 'api', changeType: 'deployment', summary: 'deploy' },
      });

      const res = await server.inject({ method: 'GET', url: '/api/v1/velocity/api?window_minutes=60' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.service).toBe('api');
      expect(body.changeCount).toBe(1);
    });

    it('GET /api/v1/velocity/:service with periods returns trend', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/velocity/api?window_minutes=60&periods=3' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trend).toBeDefined();
      expect(body.trend.length).toBe(3);
    });
  });

  describe('Graph', () => {
    it('GET /api/v1/graph/services lists services', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/graph/services' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.services.length).toBe(2);
    });

    it('GET /api/v1/graph/dependencies/:service returns deps', async () => {
      const res = await server.inject({ method: 'GET', url: '/api/v1/graph/dependencies/api' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.dependencies).toContain('db');
    });

    it('POST /api/v1/graph/import adds services', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/graph/import',
        payload: {
          services: [{ id: 'cache', name: 'Cache', type: 'cache', tags: [] }],
          dependencies: [],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().stats.nodeCount).toBe(3);
    });

    it('POST /api/v1/graph/discover returns 501', async () => {
      const res = await server.inject({ method: 'POST', url: '/api/v1/graph/discover' });
      expect(res.statusCode).toBe(501);
    });
  });
});
