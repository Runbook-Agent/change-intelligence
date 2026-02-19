/**
 * Graph Loader — Load service graph from YAML or JSON config
 *
 * Supports config-driven graph definition (Layer 1) and JSON import.
 */

import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ServiceGraph } from './service-graph';
import type { DependencyEdge, ServiceNode } from './service-graph';

const ServiceDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['service', 'database', 'cache', 'queue', 'external', 'infrastructure']).default('service'),
  tier: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  team: z.string().optional(),
  owner: z.string().optional(),
  repository: z.string().optional(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.unknown()).default({}),
});

const DependencyDefSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['sync', 'async', 'database', 'cache', 'queue', 'external']).default('sync'),
  protocol: z.string().optional(),
  criticality: z.enum(['critical', 'degraded', 'optional']).default('degraded'),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const GraphConfigSchema = z.object({
  services: z.array(ServiceDefSchema).default([]),
  dependencies: z.array(DependencyDefSchema).default([]),
});

export type GraphConfig = z.infer<typeof GraphConfigSchema>;

export function loadGraphFromYaml(filePath: string): ServiceGraph {
  const content = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(content);
  const config = GraphConfigSchema.parse(raw);
  return buildGraph(config);
}

export function loadGraphFromJson(data: unknown): ServiceGraph {
  // Handle full graph JSON export (nodes + edges) format
  if (isGraphExport(data)) {
    return ServiceGraph.fromJSON(JSON.stringify(data));
  }
  // Handle config format (services + dependencies)
  const config = GraphConfigSchema.parse(data);
  return buildGraph(config);
}

function isGraphExport(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.nodes) && Array.isArray(obj.edges);
}

function buildGraph(config: GraphConfig): ServiceGraph {
  const graph = new ServiceGraph();

  for (const svc of config.services) {
    graph.addService({
      id: svc.id,
      name: svc.name,
      type: svc.type as ServiceNode['type'],
      tier: svc.tier as ServiceNode['tier'],
      team: svc.team,
      owner: svc.owner,
      repository: svc.repository,
      tags: svc.tags,
      metadata: { ...svc.metadata, source: 'config' },
    });
  }

  for (const dep of config.dependencies) {
    graph.addDependency({
      source: dep.source,
      target: dep.target,
      type: dep.type as DependencyEdge['type'],
      protocol: dep.protocol,
      criticality: dep.criticality as DependencyEdge['criticality'],
      description: dep.description,
      metadata: { ...dep.metadata, source: 'config' },
    });
  }

  return graph;
}

/**
 * Merge a discovered or imported graph into an existing one.
 * Config-defined nodes/edges take precedence.
 */
export function mergeGraph(base: ServiceGraph, incoming: ServiceGraph, source: string = 'discovered'): void {
  for (const node of incoming.getAllServices()) {
    if (!base.getService(node.id)) {
      base.addService({
        ...node,
        metadata: { ...node.metadata, source },
      });
    }
  }

  for (const edge of incoming.getAllEdges()) {
    const existingEdges = base.getAllEdges();
    const exists = existingEdges.some(e => e.source === edge.source && e.target === edge.target);
    if (!exists) {
      base.addDependency({
        source: edge.source,
        target: edge.target,
        type: edge.type,
        protocol: edge.protocol,
        criticality: edge.criticality,
        description: edge.description,
        metadata: { ...edge.metadata, source },
      });
    }
  }
}
