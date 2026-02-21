/**
 * Service Dependency Graph — Self-contained copy for the Change Intelligence Service
 *
 * Extracted from CLI's src/knowledge/store/graph-store.ts.
 * Same interfaces and graph operations, standalone (no shared imports).
 */

export interface ServiceNode {
  id: string;
  name: string;
  type: 'service' | 'database' | 'cache' | 'queue' | 'external' | 'infrastructure';
  team?: string;
  owner?: string;
  tier?: 'critical' | 'high' | 'medium' | 'low';
  repository?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type EdgeSource =
  | 'config'
  | 'manual'
  | 'backstage'
  | 'otel'
  | 'kube-labels'
  | 'inferred'
  | 'discovered'
  | 'import'
  | 'mcp-import';

export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  type: 'sync' | 'async' | 'database' | 'cache' | 'queue' | 'external';
  protocol?: string;
  criticality: 'critical' | 'degraded' | 'optional';
  edgeSource?: EdgeSource;
  confidence?: number;
  lastSeen?: string;
  description?: string;
  metadata: Record<string, unknown>;
}

export interface ImpactPath {
  source: string;
  affected: string;
  path: string[];
  hops: number;
  criticality: 'critical' | 'degraded' | 'optional';
  confidence: number;
  edgeSources: EdgeSource[];
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  servicesByType: Record<string, number>;
  servicesByTeam: Record<string, number>;
  avgDependencies: number;
  criticalServices: number;
}

export class ServiceGraph {
  private nodes: Map<string, ServiceNode> = new Map();
  private edges: Map<string, DependencyEdge> = new Map();
  private outgoing: Map<string, Set<string>> = new Map();
  private incoming: Map<string, Set<string>> = new Map();

  addService(service: Omit<ServiceNode, 'createdAt' | 'updatedAt'>): ServiceNode {
    const now = new Date();
    const node: ServiceNode = { ...service, createdAt: now, updatedAt: now };
    this.nodes.set(service.id, node);
    if (!this.outgoing.has(service.id)) this.outgoing.set(service.id, new Set());
    if (!this.incoming.has(service.id)) this.incoming.set(service.id, new Set());
    return node;
  }

  getService(id: string): ServiceNode | undefined {
    return this.nodes.get(id);
  }

  removeService(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    for (const edgeId of this.outgoing.get(id) || new Set()) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        this.incoming.get(edge.target)?.delete(edgeId);
        this.edges.delete(edgeId);
      }
    }
    for (const edgeId of this.incoming.get(id) || new Set()) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        this.outgoing.get(edge.source)?.delete(edgeId);
        this.edges.delete(edgeId);
      }
    }
    this.outgoing.delete(id);
    this.incoming.delete(id);
    this.nodes.delete(id);
    return true;
  }

  addDependency(edge: Omit<DependencyEdge, 'id'>): DependencyEdge {
    const id = `${edge.source}->${edge.target}`;
    const fullEdge: DependencyEdge = {
      ...edge,
      id,
      edgeSource: edge.edgeSource || this.inferEdgeSource(edge.metadata),
      confidence: this.normalizeConfidence(edge.confidence),
      lastSeen: edge.lastSeen || new Date().toISOString(),
    };
    this.edges.set(id, fullEdge);
    if (!this.outgoing.has(edge.source)) this.outgoing.set(edge.source, new Set());
    this.outgoing.get(edge.source)!.add(id);
    if (!this.incoming.has(edge.target)) this.incoming.set(edge.target, new Set());
    this.incoming.get(edge.target)!.add(id);
    return fullEdge;
  }

  getDependencies(serviceId: string): ServiceNode[] {
    const edgeIds = this.outgoing.get(serviceId) || new Set();
    const deps: ServiceNode[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const target = this.nodes.get(edge.target);
        if (target) deps.push(target);
      }
    }
    return deps;
  }

  getDependents(serviceId: string): ServiceNode[] {
    const edgeIds = this.incoming.get(serviceId) || new Set();
    const deps: ServiceNode[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) {
        const source = this.nodes.get(edge.source);
        if (source) deps.push(source);
      }
    }
    return deps;
  }

  getAllServices(): ServiceNode[] {
    return Array.from(this.nodes.values());
  }

  getAllEdges(): DependencyEdge[] {
    return Array.from(this.edges.values());
  }

  getOutgoingEdges(serviceId: string): DependencyEdge[] {
    const edgeIds = this.outgoing.get(serviceId) || new Set<string>();
    const edges: DependencyEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  getIncomingEdges(serviceId: string): DependencyEdge[] {
    const edgeIds = this.incoming.get(serviceId) || new Set<string>();
    const edges: DependencyEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) edges.push(edge);
    }
    return edges;
  }

  searchServices(query: string): ServiceNode[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.nodes.values()).filter(
      node =>
        node.name.toLowerCase().includes(lowerQuery) ||
        node.id.toLowerCase().includes(lowerQuery) ||
        node.tags.some(t => t.toLowerCase().includes(lowerQuery)) ||
        node.team?.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get upstream impact — services that depend on the target (consumers).
   * If the target breaks, these are affected.
   */
  getUpstreamImpact(serviceId: string, maxDepth: number = 5): ImpactPath[] {
    const paths: ImpactPath[] = [];
    const visited = new Set<string>();

    const traverse = (
      current: string,
      path: string[],
      depth: number,
      criticality: 'critical' | 'degraded' | 'optional',
      confidence: number,
      edgeSources: EdgeSource[]
    ) => {
      if (depth > maxDepth || visited.has(current)) return;
      visited.add(current);

      const edgeIds = this.incoming.get(current) || new Set();
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) continue;
        const newPath = [...path, edge.source];
        const newCriticality = this.mergeCriticality(criticality, edge.criticality);
        const newConfidence = Math.min(confidence, this.normalizeConfidence(edge.confidence));
        const newEdgeSources = Array.from(new Set([
          ...edgeSources,
          edge.edgeSource || this.inferEdgeSource(edge.metadata),
        ]));
        paths.push({
          source: serviceId,
          affected: edge.source,
          path: newPath,
          hops: newPath.length,
          criticality: newCriticality,
          confidence: newConfidence,
          edgeSources: newEdgeSources,
        });
        traverse(edge.source, newPath, depth + 1, newCriticality, newConfidence, newEdgeSources);
      }
    };

    traverse(serviceId, [serviceId], 0, 'critical', 1, []);
    return paths.sort((a, b) => a.hops - b.hops);
  }

  /**
   * Get downstream impact — services the target depends on (providers).
   */
  getDownstreamImpact(serviceId: string, maxDepth: number = 5): ImpactPath[] {
    const paths: ImpactPath[] = [];
    const visited = new Set<string>();

    const traverse = (
      current: string,
      path: string[],
      depth: number,
      criticality: 'critical' | 'degraded' | 'optional',
      confidence: number,
      edgeSources: EdgeSource[]
    ) => {
      if (depth > maxDepth || visited.has(current)) return;
      visited.add(current);

      const edgeIds = this.outgoing.get(current) || new Set();
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) continue;
        const newPath = [...path, edge.target];
        const newCriticality = this.mergeCriticality(criticality, edge.criticality);
        const newConfidence = Math.min(confidence, this.normalizeConfidence(edge.confidence));
        const newEdgeSources = Array.from(new Set([
          ...edgeSources,
          edge.edgeSource || this.inferEdgeSource(edge.metadata),
        ]));
        paths.push({
          source: serviceId,
          affected: edge.target,
          path: newPath,
          hops: newPath.length,
          criticality: newCriticality,
          confidence: newConfidence,
          edgeSources: newEdgeSources,
        });
        traverse(edge.target, newPath, depth + 1, newCriticality, newConfidence, newEdgeSources);
      }
    };

    traverse(serviceId, [serviceId], 0, 'critical', 1, []);
    return paths.sort((a, b) => a.hops - b.hops);
  }

  findPath(from: string, to: string): string[] | null {
    if (from === to) return [from];
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null;

    const visited = new Set<string>();
    const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;
      if (visited.has(node)) continue;
      visited.add(node);

      const edgeIds = this.outgoing.get(node) || new Set();
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) continue;
        const newPath = [...path, edge.target];
        if (edge.target === to) return newPath;
        if (!visited.has(edge.target)) {
          queue.push({ node: edge.target, path: newPath });
        }
      }
    }
    return null;
  }

  getStats(): GraphStats {
    const servicesByType: Record<string, number> = {};
    const servicesByTeam: Record<string, number> = {};
    let totalDependencies = 0;
    let criticalCount = 0;

    for (const node of this.nodes.values()) {
      servicesByType[node.type] = (servicesByType[node.type] || 0) + 1;
      if (node.team) servicesByTeam[node.team] = (servicesByTeam[node.team] || 0) + 1;
      if (node.tier === 'critical') criticalCount++;
      totalDependencies += this.outgoing.get(node.id)?.size || 0;
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      servicesByType,
      servicesByTeam,
      avgDependencies: this.nodes.size > 0 ? totalDependencies / this.nodes.size : 0,
      criticalServices: criticalCount,
    };
  }

  toJSON(): string {
    return JSON.stringify({
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    }, null, 2);
  }

  static fromJSON(json: string): ServiceGraph {
    const data = JSON.parse(json);
    const graph = new ServiceGraph();
    for (const node of data.nodes) {
      graph.addService({
        ...node,
        createdAt: new Date(node.createdAt),
        updatedAt: new Date(node.updatedAt),
      });
    }
    for (const edge of data.edges) {
      graph.addDependency(edge);
    }
    return graph;
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
  }

  private mergeCriticality(
    a: 'critical' | 'degraded' | 'optional',
    b: 'critical' | 'degraded' | 'optional'
  ): 'critical' | 'degraded' | 'optional' {
    // Weakest-link: path criticality is the least critical edge along it
    const order = { critical: 0, degraded: 1, optional: 2 };
    return order[a] >= order[b] ? a : b;
  }

  private normalizeConfidence(confidence: number | undefined): number {
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 1;
    return Math.max(0, Math.min(1, confidence));
  }

  private inferEdgeSource(metadata: Record<string, unknown>): EdgeSource {
    const source = metadata?.source;
    if (
      source === 'config' ||
      source === 'manual' ||
      source === 'backstage' ||
      source === 'otel' ||
      source === 'kube-labels' ||
      source === 'inferred' ||
      source === 'discovered' ||
      source === 'import' ||
      source === 'mcp-import'
    ) {
      return source;
    }
    return 'manual';
  }
}

export function createServiceGraph(): ServiceGraph {
  return new ServiceGraph();
}
