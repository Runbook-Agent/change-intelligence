import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseEntityRef,
  convertEntitiesToGraphConfig,
  BackstageApiError,
} from '../backstage-client';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-backstage-${randomUUID()}.db`);
}

// ── Helper: build a Backstage entity ──

function makeComponent(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: (overrides.name as string) || 'my-service',
      namespace: (overrides.namespace as string) || 'default',
      description: (overrides.description as string) || 'A service',
      tags: (overrides.metadataTags as string[]) || [],
    },
    spec: {
      type: (overrides.type as string) || 'service',
      lifecycle: 'lifecycle' in overrides ? (overrides.lifecycle as string | undefined) : 'production',
      owner: (overrides.owner as string) || 'team-a',
      system: (overrides.system as string) || undefined,
      dependsOn: (overrides.dependsOn as string[]) || [],
      consumesApis: (overrides.consumesApis as string[]) || [],
      providesApis: (overrides.providesApis as string[]) || [],
    },
  };
}

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: {
      name: (overrides.name as string) || 'my-db',
      namespace: (overrides.namespace as string) || 'default',
      description: (overrides.description as string) || 'A database',
      tags: (overrides.metadataTags as string[]) || [],
    },
    spec: {
      type: (overrides.type as string) || 'database',
      lifecycle: (overrides.lifecycle as string) || 'production',
      owner: (overrides.owner as string) || 'team-a',
      system: (overrides.system as string) || undefined,
      dependsOn: (overrides.dependsOn as string[]) || [],
    },
  };
}

// ──────────────────────────────────────────────────────
// Unit tests: parseEntityRef
// ──────────────────────────────────────────────────────

describe('parseEntityRef', () => {
  it('parses full ref kind:namespace/name', () => {
    const ref = parseEntityRef('component:default/my-service');
    expect(ref).toEqual({ kind: 'component', namespace: 'default', name: 'my-service' });
  });

  it('parses kind:name (no namespace defaults to "default")', () => {
    const ref = parseEntityRef('resource:my-db');
    expect(ref).toEqual({ kind: 'resource', namespace: 'default', name: 'my-db' });
  });

  it('parses bare name', () => {
    const ref = parseEntityRef('my-service');
    expect(ref).toEqual({ kind: 'component', namespace: 'default', name: 'my-service' });
  });

  it('handles non-default namespace', () => {
    const ref = parseEntityRef('component:team-b/payment-api');
    expect(ref).toEqual({ kind: 'component', namespace: 'team-b', name: 'payment-api' });
  });

  it('lowercases the kind', () => {
    const ref = parseEntityRef('Component:default/svc');
    expect(ref.kind).toBe('component');
  });
});

// ──────────────────────────────────────────────────────
// Unit tests: convertEntitiesToGraphConfig
// ──────────────────────────────────────────────────────

describe('convertEntitiesToGraphConfig', () => {
  it('converts a component to a service node', () => {
    const components = [makeComponent({ name: 'api-gateway', type: 'service' })];
    const { config, stats } = convertEntitiesToGraphConfig(components, []);

    expect(stats.componentsFound).toBe(1);
    expect(stats.servicesCreated).toBe(1);
    expect(config.services).toHaveLength(1);
    expect(config.services[0]).toMatchObject({
      id: 'api-gateway',
      name: 'api-gateway',
      type: 'service',
    });
  });

  it('converts a resource to a database node', () => {
    const resources = [makeResource({ name: 'users-db', type: 'database' })];
    const { config, stats } = convertEntitiesToGraphConfig([], resources);

    expect(stats.resourcesFound).toBe(1);
    expect(config.services[0]).toMatchObject({
      id: 'users-db',
      type: 'database',
    });
  });

  it('maps resource types correctly', () => {
    const resources = [
      makeResource({ name: 'r1', type: 'redis' }),
      makeResource({ name: 'r2', type: 'sqs' }),
      makeResource({ name: 'r3', type: 's3-bucket' }),
      makeResource({ name: 'r4', type: 'unknown-thing' }),
    ];
    const { config } = convertEntitiesToGraphConfig([], resources);

    expect(config.services.find(s => s.id === 'r1')!.type).toBe('cache');
    expect(config.services.find(s => s.id === 'r2')!.type).toBe('queue');
    expect(config.services.find(s => s.id === 'r3')!.type).toBe('infrastructure');
    expect(config.services.find(s => s.id === 'r4')!.type).toBe('infrastructure');
  });

  it('maps component types correctly', () => {
    const components = [
      makeComponent({ name: 'c1', type: 'website' }),
      makeComponent({ name: 'c2', type: 'library' }),
      makeComponent({ name: 'c3', type: 'api' }),
      makeComponent({ name: 'c4', type: 'something-custom' }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);

    for (const svc of config.services) {
      expect(svc.type).toBe('service');
    }
  });

  it('maps lifecycle to tier', () => {
    const components = [
      makeComponent({ name: 'prod', lifecycle: 'production' }),
      makeComponent({ name: 'exp', lifecycle: 'experimental' }),
      makeComponent({ name: 'dep', lifecycle: 'deprecated' }),
      makeComponent({ name: 'none', lifecycle: undefined }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);

    expect(config.services.find(s => s.id === 'prod')!.tier).toBe('high');
    expect(config.services.find(s => s.id === 'exp')!.tier).toBe('low');
    expect(config.services.find(s => s.id === 'dep')!.tier).toBe('low');
    expect(config.services.find(s => s.id === 'none')!.tier).toBeUndefined();
  });

  it('creates dependsOn edges', () => {
    const components = [
      makeComponent({ name: 'frontend', dependsOn: ['component:default/backend'] }),
      makeComponent({ name: 'backend' }),
    ];
    const { config, stats } = convertEntitiesToGraphConfig(components, []);

    expect(stats.dependenciesCreated).toBe(1);
    expect(config.dependencies[0]).toMatchObject({
      source: 'frontend',
      target: 'backend',
      type: 'sync',
      criticality: 'degraded',
    });
  });

  it('creates dependsOn edges to resources with correct type inference', () => {
    const components = [
      makeComponent({ name: 'api', dependsOn: ['resource:default/my-database'] }),
    ];
    const resources = [makeResource({ name: 'my-database', type: 'database' })];
    const { config } = convertEntitiesToGraphConfig(components, resources);

    expect(config.dependencies[0]).toMatchObject({
      source: 'api',
      target: 'my-database',
      type: 'database',
    });
  });

  it('creates edges via consumesApis/providesApis cross-reference', () => {
    const components = [
      makeComponent({ name: 'frontend', consumesApis: ['api:default/user-api'] }),
      makeComponent({ name: 'user-service', providesApis: ['api:default/user-api'] }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);

    expect(config.dependencies).toHaveLength(1);
    expect(config.dependencies[0]).toMatchObject({
      source: 'frontend',
      target: 'user-service',
      type: 'sync',
    });
  });

  it('skips unknown dependsOn targets', () => {
    const components = [
      makeComponent({ name: 'api', dependsOn: ['component:default/nonexistent'] }),
    ];
    const { config, stats } = convertEntitiesToGraphConfig(components, []);

    expect(config.dependencies).toHaveLength(0);
    expect(stats.skippedEntities).toBe(1);
  });

  it('uses namespace--name ID for non-default namespace', () => {
    const components = [
      makeComponent({ name: 'payment-api', namespace: 'team-b' }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);

    expect(config.services[0].id).toBe('team-b--payment-api');
  });

  it('preserves backstage metadata', () => {
    const components = [
      makeComponent({ name: 'svc', lifecycle: 'production', type: 'service', description: 'My svc' }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);
    const meta = config.services[0].metadata!;

    expect(meta.backstage_namespace).toBe('default');
    expect(meta.backstage_kind).toBe('component');
    expect(meta.backstage_type).toBe('service');
    expect(meta.backstage_lifecycle).toBe('production');
    expect(meta.backstage_description).toBe('My svc');
  });

  it('generates correct auto-tags', () => {
    const components = [
      makeComponent({ name: 'svc', lifecycle: 'production', type: 'service' }),
    ];
    const { config } = convertEntitiesToGraphConfig(components, []);
    const tags = config.services[0].tags!;

    expect(tags).toContain('backstage-kind:component');
    expect(tags).toContain('lifecycle:production');
    expect(tags).toContain('backstage-type:service');
  });

  it('produces accurate stats', () => {
    const components = [
      makeComponent({ name: 'a', dependsOn: ['component:default/b'] }),
      makeComponent({ name: 'b' }),
    ];
    const resources = [makeResource({ name: 'db1' })];
    const { stats } = convertEntitiesToGraphConfig(components, resources);

    expect(stats.componentsFound).toBe(2);
    expect(stats.resourcesFound).toBe(1);
    expect(stats.servicesCreated).toBe(3);
    expect(stats.dependenciesCreated).toBe(1);
    expect(stats.skippedEntities).toBe(0);
  });
});

// ──────────────────────────────────────────────────────
// Integration tests: route with mocked fetch
// ──────────────────────────────────────────────────────

describe('POST /api/v1/graph/import/backstage', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({ dbPath });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    vi.restoreAllMocks();
  });

  function mockFetch(responses: Record<string, unknown>) {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const decoded = decodeURIComponent(url);

      for (const [pattern, data] of Object.entries(responses)) {
        if (decoded.includes(pattern)) {
          return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    });
    return spy;
  }

  it('imports components and resources from Backstage', async () => {
    mockFetch({
      'kind=component': {
        items: [
          makeComponent({ name: 'api', dependsOn: ['component:default/worker'] }),
          makeComponent({ name: 'worker' }),
        ],
      },
      'kind=resource': {
        items: [makeResource({ name: 'main-db', type: 'database' })],
      },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: {
        base_url: 'https://backstage.example.com',
        api_token: 'test-token',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe('Backstage catalog imported successfully');
    expect(body.import_stats.componentsFound).toBe(2);
    expect(body.import_stats.resourcesFound).toBe(1);
    expect(body.import_stats.servicesCreated).toBe(3);
    expect(body.import_stats.dependenciesCreated).toBe(1);
    expect(body.graph_stats.nodeCount).toBe(3);
  });

  it('returns 400 for missing base_url', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 for invalid base_url', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: { base_url: 'not-a-url' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when Backstage API fails', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockImplementation(async () => {
      return new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      });
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: {
        base_url: 'https://backstage.example.com',
      },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('bad_gateway');
  });

  it('handles pagination across multiple pages', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    let componentCallCount = 0;
    let resourceCallCount = 0;

    spy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const decoded = decodeURIComponent(url);

      if (decoded.includes('kind=component')) {
        componentCallCount++;
        if (!decoded.includes('cursor=')) {
          // First page
          return new Response(JSON.stringify({
            items: [makeComponent({ name: 'svc-1' })],
            pageInfo: { nextCursor: 'page2' },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else {
          // Second page (no nextCursor → stop)
          return new Response(JSON.stringify({
            items: [makeComponent({ name: 'svc-2' })],
            pageInfo: {},
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (decoded.includes('kind=resource')) {
        resourceCallCount++;
        return new Response(JSON.stringify({
          items: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response('Not Found', { status: 404 });
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: {
        base_url: 'https://backstage.example.com',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.import_stats.componentsFound).toBe(2);
    expect(componentCallCount).toBe(2);
    expect(body.graph_stats.nodeCount).toBe(2);
  });

  it('merges with existing graph without overwriting', async () => {
    // Pre-populate graph with a service
    await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import',
      payload: {
        services: [{ id: 'existing-svc', name: 'Existing', type: 'service', tags: [], metadata: { custom: true } }],
        dependencies: [],
      },
    });

    mockFetch({
      'kind=component': {
        items: [
          makeComponent({ name: 'existing-svc' }), // Duplicate — should not overwrite
          makeComponent({ name: 'new-svc' }),
        ],
      },
      'kind=resource': { items: [] },
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/graph/import/backstage',
      payload: {
        base_url: 'https://backstage.example.com',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 1 existing + 1 new (duplicate skipped by mergeGraph)
    expect(body.graph_stats.nodeCount).toBe(2);

    // Verify the existing node's metadata was preserved (not overwritten)
    const svcRes = await server.inject({ method: 'GET', url: '/api/v1/graph/services' });
    const services = svcRes.json().services;
    expect(services.find((s: { id: string }) => s.id === 'existing-svc')).toBeDefined();
    expect(services.find((s: { id: string }) => s.id === 'new-svc')).toBeDefined();
  });
});
