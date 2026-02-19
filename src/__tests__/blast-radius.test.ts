import { describe, it, expect } from 'vitest';
import { BlastRadiusAnalyzer } from '../blast-radius';
import { ServiceGraph } from '../service-graph';

function buildGraph(): ServiceGraph {
  // Hub: gateway depends on svc1, svc2, svc3
  // svc1 depends on db
  // svc2 depends on cache, queue
  // svc3 is a leaf
  const graph = new ServiceGraph();
  graph.addService({ id: 'gateway', name: 'Gateway', type: 'service', tier: 'critical', tags: [], metadata: {} });
  graph.addService({ id: 'svc1', name: 'Service 1', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'svc2', name: 'Service 2', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'svc3', name: 'Service 3', type: 'service', tags: [], metadata: {} });
  graph.addService({ id: 'db', name: 'Database', type: 'database', tier: 'critical', tags: [], metadata: {} });
  graph.addService({ id: 'cache', name: 'Cache', type: 'cache', tags: [], metadata: {} });
  graph.addService({ id: 'queue', name: 'Queue', type: 'queue', tags: [], metadata: {} });

  graph.addDependency({ source: 'gateway', target: 'svc1', type: 'sync', criticality: 'critical', metadata: {} });
  graph.addDependency({ source: 'gateway', target: 'svc2', type: 'sync', criticality: 'degraded', metadata: {} });
  graph.addDependency({ source: 'gateway', target: 'svc3', type: 'async', criticality: 'optional', metadata: {} });
  graph.addDependency({ source: 'svc1', target: 'db', type: 'database', criticality: 'critical', metadata: {} });
  graph.addDependency({ source: 'svc2', target: 'cache', type: 'cache', criticality: 'degraded', metadata: {} });
  graph.addDependency({ source: 'svc2', target: 'queue', type: 'queue', criticality: 'optional', metadata: {} });

  return graph;
}

describe('BlastRadiusAnalyzer', () => {
  describe('leaf change (small radius)', () => {
    it('predicts low risk for leaf service', () => {
      const graph = buildGraph();
      const analyzer = new BlastRadiusAnalyzer(graph);

      const result = analyzer.predict(['svc3']);
      // svc3 has no dependents (nobody depends on it via incoming edges)
      // Actually, gateway depends on svc3, so gateway is a direct dependent
      expect(result.directServices).toContain('gateway');
      expect(result.riskLevel).toBe('low');
    });
  });

  describe('hub change (large radius)', () => {
    it('predicts high risk for database change', () => {
      const graph = buildGraph();
      const analyzer = new BlastRadiusAnalyzer(graph);

      // db is depended on by svc1, which is depended on by gateway
      const result = analyzer.predict(['db']);
      expect(result.directServices).toContain('svc1');
      expect(result.downstreamServices).toContain('gateway');
      expect(result.criticalPathAffected).toBe(true);
      expect(result.riskLevel).toBe('critical');
    });
  });

  describe('critical path detection', () => {
    it('detects critical path through svc1 to db', () => {
      const graph = buildGraph();
      const analyzer = new BlastRadiusAnalyzer(graph);

      const result = analyzer.predict(['svc1']);
      // gateway depends on svc1 via critical edge
      expect(result.criticalPathAffected).toBe(true);
      expect(result.directServices).toContain('gateway');
    });
  });

  describe('disconnected service', () => {
    it('returns empty radius for unknown service', () => {
      const graph = buildGraph();
      const analyzer = new BlastRadiusAnalyzer(graph);

      const result = analyzer.predict(['unknown-service']);
      expect(result.directServices).toEqual([]);
      expect(result.downstreamServices).toEqual([]);
      expect(result.criticalPathAffected).toBe(false);
      expect(result.riskLevel).toBe('low');
    });
  });

  describe('risk level computation', () => {
    it('returns medium for service with 2 direct dependents', () => {
      const graph = new ServiceGraph();
      graph.addService({ id: 'core', name: 'Core', type: 'service', tags: [], metadata: {} });
      graph.addService({ id: 'a', name: 'A', type: 'service', tags: [], metadata: {} });
      graph.addService({ id: 'b', name: 'B', type: 'service', tags: [], metadata: {} });
      graph.addDependency({ source: 'a', target: 'core', type: 'sync', criticality: 'degraded', metadata: {} });
      graph.addDependency({ source: 'b', target: 'core', type: 'sync', criticality: 'degraded', metadata: {} });

      const analyzer = new BlastRadiusAnalyzer(graph);
      const result = analyzer.predict(['core']);
      expect(result.directServices.length).toBe(2);
      expect(result.riskLevel).toBe('medium');
    });

    it('returns high for service with >3 direct dependents', () => {
      const graph = new ServiceGraph();
      graph.addService({ id: 'core', name: 'Core', type: 'service', tags: [], metadata: {} });
      for (let i = 0; i < 5; i++) {
        const id = `svc-${i}`;
        graph.addService({ id, name: id, type: 'service', tags: [], metadata: {} });
        graph.addDependency({ source: id, target: 'core', type: 'sync', criticality: 'degraded', metadata: {} });
      }

      const analyzer = new BlastRadiusAnalyzer(graph);
      const result = analyzer.predict(['core']);
      expect(result.directServices.length).toBe(5);
      expect(result.riskLevel).toBe('high');
    });
  });

  describe('rationale', () => {
    it('includes human-readable rationale', () => {
      const graph = buildGraph();
      const analyzer = new BlastRadiusAnalyzer(graph);

      const result = analyzer.predict(['svc1'], 'deployment');
      expect(result.rationale.length).toBeGreaterThan(0);
      expect(result.rationale.some(r => r.includes('svc1'))).toBe(true);
      expect(result.rationale.some(r => r.includes('deployment'))).toBe(true);
    });
  });
});
