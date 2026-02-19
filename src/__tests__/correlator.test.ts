import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeCorrelator } from '../correlator';
import { ChangeEventStore } from '../store';
import { ServiceGraph } from '../service-graph';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-correlator-${randomUUID()}.db`);
}

function buildChainGraph(): ServiceGraph {
  // A → B → C (A depends on B, B depends on C)
  const graph = new ServiceGraph();
  graph.addService({ id: 'A', name: 'Service A', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'B', name: 'Service B', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'C', name: 'Service C', type: 'database', tags: [], metadata: {} });
  graph.addDependency({ source: 'A', target: 'B', type: 'sync', criticality: 'critical', metadata: {} });
  graph.addDependency({ source: 'B', target: 'C', type: 'database', criticality: 'critical', metadata: {} });
  return graph;
}

function buildHubGraph(): ServiceGraph {
  // Hub-and-spoke: api-gateway → svc1, svc2, svc3
  const graph = new ServiceGraph();
  graph.addService({ id: 'api-gateway', name: 'API Gateway', type: 'service', tier: 'critical', tags: [], metadata: {} });
  graph.addService({ id: 'svc1', name: 'Service 1', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'svc2', name: 'Service 2', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'svc3', name: 'Service 3', type: 'service', tags: [], metadata: {} });
  graph.addDependency({ source: 'api-gateway', target: 'svc1', type: 'sync', criticality: 'critical', metadata: {} });
  graph.addDependency({ source: 'api-gateway', target: 'svc2', type: 'sync', criticality: 'degraded', metadata: {} });
  graph.addDependency({ source: 'api-gateway', target: 'svc3', type: 'async', criticality: 'optional', metadata: {} });
  return graph;
}

describe('ChangeCorrelator', () => {
  let store: ChangeEventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new ChangeEventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('time proximity scoring', () => {
    it('ranks more recent changes higher', () => {
      const graph = new ServiceGraph();
      graph.addService({ id: 'api', name: 'API', type: 'service', tags: [], metadata: {} });
      const correlator = new ChangeCorrelator(store, graph);

      const now = Date.now();
      // Change 5 minutes ago
      store.insert({
        service: 'api',
        changeType: 'deployment',
        summary: 'recent deploy',
        timestamp: new Date(now - 5 * 60_000).toISOString(),
      });
      // Change 90 minutes ago
      store.insert({
        service: 'api',
        changeType: 'deployment',
        summary: 'old deploy',
        timestamp: new Date(now - 90 * 60_000).toISOString(),
      });

      const results = correlator.correlateWithIncident(
        ['api'],
        new Date(now).toISOString(),
        { windowMinutes: 120 }
      );

      expect(results.length).toBe(2);
      expect(results[0].changeEvent.summary).toBe('recent deploy');
      expect(results[0].correlationScore).toBeGreaterThan(results[1].correlationScore);
    });
  });

  describe('service overlap scoring', () => {
    it('scores direct service match highest', () => {
      const graph = buildChainGraph();
      const correlator = new ChangeCorrelator(store, graph);
      const now = new Date().toISOString();

      // Direct match on 'A'
      store.insert({ service: 'A', changeType: 'deployment', summary: 'direct change', timestamp: now });
      // 1-hop neighbor 'B'
      store.insert({ service: 'B', changeType: 'deployment', summary: 'neighbor change', timestamp: now });

      const results = correlator.correlateWithIncident(['A'], now);
      expect(results.length).toBe(2);

      const directResult = results.find(r => r.changeEvent.service === 'A')!;
      const neighborResult = results.find(r => r.changeEvent.service === 'B')!;
      expect(directResult.correlationScore).toBeGreaterThan(neighborResult.correlationScore);
    });
  });

  describe('graph expansion', () => {
    it('finds changes on graph neighbors', () => {
      const graph = buildChainGraph();
      const correlator = new ChangeCorrelator(store, graph);
      const now = new Date().toISOString();

      // Only 'C' changed — C is 2 hops from A
      store.insert({ service: 'C', changeType: 'db_migration', summary: 'DB migration on C', timestamp: now });

      const results = correlator.correlateWithIncident(['A'], now, { windowMinutes: 60 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].changeEvent.service).toBe('C');
    });
  });

  describe('multiple changes ranked correctly', () => {
    it('ranks deployment higher than config change at same time', () => {
      const graph = new ServiceGraph();
      graph.addService({ id: 'api', name: 'API', type: 'service', tags: [], metadata: {} });
      const correlator = new ChangeCorrelator(store, graph);
      const now = new Date().toISOString();

      store.insert({ service: 'api', changeType: 'deployment', summary: 'deploy', timestamp: now });
      store.insert({ service: 'api', changeType: 'scaling', summary: 'scale', timestamp: now });

      const results = correlator.correlateWithIncident(['api'], now);
      expect(results.length).toBe(2);
      // deployment has higher type score than scaling
      expect(results[0].changeEvent.changeType).toBe('deployment');
    });
  });

  describe('empty results', () => {
    it('returns empty when no changes exist', () => {
      const graph = new ServiceGraph();
      const correlator = new ChangeCorrelator(store, graph);

      const results = correlator.correlateWithIncident(['api'], new Date().toISOString());
      expect(results).toEqual([]);
    });
  });

  describe('hub-and-spoke graph', () => {
    it('correlates spoke changes with gateway incident', () => {
      const graph = buildHubGraph();
      const correlator = new ChangeCorrelator(store, graph);
      const now = new Date().toISOString();

      store.insert({ service: 'svc1', changeType: 'deployment', summary: 'svc1 deploy', timestamp: now });
      store.insert({ service: 'svc2', changeType: 'config_change', summary: 'svc2 config', timestamp: now });

      // Incident on api-gateway — svc1 and svc2 are downstream deps
      const results = correlator.correlateWithIncident(['api-gateway'], now);
      expect(results.length).toBe(2);
    });
  });
});
