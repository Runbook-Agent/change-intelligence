/**
 * Backstage Catalog Client — Fetches entities from a Backstage instance
 * and converts them to our ServiceNode/DependencyEdge model.
 */

import { z } from 'zod';
import type { GraphConfig } from './graph-loader';

// ── Zod schema for the import request ──

const BackstageOptionsSchema = z.object({
  namespaces: z.array(z.string()).optional(),
  lifecycles: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  systems: z.array(z.string()).optional(),
});

export const BackstageImportRequestSchema = z.object({
  base_url: z.string().url(),
  api_token: z.string().optional(),
  options: BackstageOptionsSchema.optional(),
});

export type BackstageImportRequest = z.infer<typeof BackstageImportRequestSchema>;
type BackstageOptions = z.infer<typeof BackstageOptionsSchema>;

// ── Backstage entity types (subset we care about) ──

interface BackstageEntity {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    description?: string;
    tags?: string[];
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
  spec?: {
    type?: string;
    lifecycle?: string;
    owner?: string;
    system?: string;
    dependsOn?: string[];
    consumesApis?: string[];
    providesApis?: string[];
    [key: string]: unknown;
  };
}

// ── Import stats ──

export interface BackstageImportStats {
  componentsFound: number;
  resourcesFound: number;
  servicesCreated: number;
  dependenciesCreated: number;
  skippedEntities: number;
}

// ── Entity ref parsing ──

export interface ParsedEntityRef {
  kind: string;
  namespace: string;
  name: string;
}

/**
 * Parse a Backstage entity reference string.
 * Formats: "component:default/name", "component:name", "name"
 */
export function parseEntityRef(ref: string): ParsedEntityRef {
  let kind = 'component';
  let namespace = 'default';
  let name = ref;

  // Split kind from the rest
  const colonIdx = ref.indexOf(':');
  if (colonIdx !== -1) {
    kind = ref.slice(0, colonIdx).toLowerCase();
    name = ref.slice(colonIdx + 1);
  }

  // Split namespace from name
  const slashIdx = name.indexOf('/');
  if (slashIdx !== -1) {
    namespace = name.slice(0, slashIdx);
    name = name.slice(slashIdx + 1);
  }

  return { kind, namespace, name };
}

// ── Type mapping ──

const COMPONENT_TYPE_MAP: Record<string, GraphConfig['services'][number]['type']> = {
  service: 'service',
  website: 'service',
  library: 'service',
  api: 'service',
};

const RESOURCE_TYPE_MAP: Record<string, GraphConfig['services'][number]['type']> = {
  database: 'database',
  db: 'database',
  cache: 'cache',
  redis: 'cache',
  memcached: 'cache',
  queue: 'queue',
  sqs: 'queue',
  kafka: 'queue',
  rabbitmq: 'queue',
  's3-bucket': 'infrastructure',
  storage: 'infrastructure',
  cdn: 'infrastructure',
  cluster: 'infrastructure',
};

function mapComponentType(specType?: string): GraphConfig['services'][number]['type'] {
  if (!specType) return 'service';
  return COMPONENT_TYPE_MAP[specType.toLowerCase()] ?? 'service';
}

function mapResourceType(specType?: string): GraphConfig['services'][number]['type'] {
  if (!specType) return 'infrastructure';
  return RESOURCE_TYPE_MAP[specType.toLowerCase()] ?? 'infrastructure';
}

function mapLifecycleToTier(lifecycle?: string): 'critical' | 'high' | 'medium' | 'low' | undefined {
  if (!lifecycle) return undefined;
  switch (lifecycle.toLowerCase()) {
    case 'production': return 'high';
    case 'experimental': return 'low';
    case 'deprecated': return 'low';
    default: return undefined;
  }
}

// ── Node ID generation ──

function makeNodeId(namespace: string | undefined, name: string): string {
  if (!namespace || namespace === 'default') return name;
  return `${namespace}--${name}`;
}

// ── Edge type inference from a target ref ──

function inferEdgeType(targetRef: string): GraphConfig['dependencies'][number]['type'] {
  const parsed = parseEntityRef(targetRef);
  if (parsed.kind === 'resource') {
    const lower = parsed.name.toLowerCase();
    if (lower.includes('db') || lower.includes('database') || lower.includes('postgres') || lower.includes('mysql') || lower.includes('mongo')) return 'database';
    if (lower.includes('cache') || lower.includes('redis') || lower.includes('memcached')) return 'cache';
    if (lower.includes('queue') || lower.includes('sqs') || lower.includes('kafka') || lower.includes('rabbitmq')) return 'queue';
    return 'database'; // default for resources
  }
  return 'sync';
}

// ── Fetch from Backstage API ──

export async function fetchBackstageEntities(
  baseUrl: string,
  apiToken: string | undefined,
  kind: string,
  options?: BackstageOptions,
): Promise<BackstageEntity[]> {
  const entities: BackstageEntity[] = [];
  let cursor: string | undefined;

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (apiToken) {
    headers['Authorization'] = `Bearer ${apiToken}`;
  }

  do {
    const url = new URL(`${baseUrl}/api/catalog/entities/by-query`);
    url.searchParams.set('filter', `kind=${kind}`);
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url.toString(), { headers });

    if (!response.ok) {
      throw new BackstageApiError(
        `Backstage API returned ${response.status}: ${response.statusText}`,
        response.status,
      );
    }

    const data = await response.json() as {
      items: BackstageEntity[];
      pageInfo?: { nextCursor?: string };
    };

    entities.push(...(data.items || []));
    cursor = data.pageInfo?.nextCursor ?? undefined;
  } while (cursor);

  // Apply client-side filters
  return applyFilters(entities, options);
}

function applyFilters(entities: BackstageEntity[], options?: BackstageOptions): BackstageEntity[] {
  if (!options) return entities;

  return entities.filter(entity => {
    if (options.namespaces && options.namespaces.length > 0) {
      const ns = entity.metadata.namespace || 'default';
      if (!options.namespaces.includes(ns)) return false;
    }
    if (options.lifecycles && options.lifecycles.length > 0) {
      const lc = entity.spec?.lifecycle;
      if (!lc || !options.lifecycles.includes(lc)) return false;
    }
    if (options.types && options.types.length > 0) {
      const t = entity.spec?.type;
      if (!t || !options.types.includes(t)) return false;
    }
    if (options.systems && options.systems.length > 0) {
      const sys = entity.spec?.system;
      if (!sys || !options.systems.includes(sys)) return false;
    }
    return true;
  });
}

// ── Convert Backstage entities to GraphConfig ──

export function convertEntitiesToGraphConfig(
  components: BackstageEntity[],
  resources: BackstageEntity[],
): { config: GraphConfig; stats: BackstageImportStats } {
  const services: GraphConfig['services'] = [];
  const dependencies: GraphConfig['dependencies'] = [];
  const nodeIds = new Set<string>();
  let skippedEntities = 0;

  // Build an index of API ref → provider node ID for consumesApis/providesApis cross-referencing
  const apiProviderIndex = new Map<string, string>();

  // First pass: register all component nodes and their provided APIs
  for (const entity of components) {
    const name = entity.metadata.name;
    const namespace = entity.metadata.namespace || 'default';
    const nodeId = makeNodeId(namespace, name);

    services.push({
      id: nodeId,
      name,
      type: mapComponentType(entity.spec?.type),
      tier: mapLifecycleToTier(entity.spec?.lifecycle),
      owner: entity.spec?.owner,
      tags: buildTags(entity, 'component'),
      metadata: buildMetadata(entity),
    });
    nodeIds.add(nodeId);

    // Index provided APIs
    for (const apiRef of entity.spec?.providesApis || []) {
      apiProviderIndex.set(apiRef.toLowerCase(), nodeId);
    }
  }

  // Register resource nodes
  for (const entity of resources) {
    const name = entity.metadata.name;
    const namespace = entity.metadata.namespace || 'default';
    const nodeId = makeNodeId(namespace, name);

    services.push({
      id: nodeId,
      name,
      type: mapResourceType(entity.spec?.type),
      tier: mapLifecycleToTier(entity.spec?.lifecycle),
      owner: entity.spec?.owner,
      tags: buildTags(entity, 'resource'),
      metadata: buildMetadata(entity),
    });
    nodeIds.add(nodeId);
  }

  // Second pass: extract dependencies from dependsOn
  for (const entity of [...components, ...resources]) {
    const sourceNs = entity.metadata.namespace || 'default';
    const sourceId = makeNodeId(sourceNs, entity.metadata.name);

    for (const ref of entity.spec?.dependsOn || []) {
      const parsed = parseEntityRef(ref);
      const targetId = makeNodeId(parsed.namespace, parsed.name);

      if (!nodeIds.has(targetId)) {
        skippedEntities++;
        continue;
      }

      dependencies.push({
        source: sourceId,
        target: targetId,
        type: inferEdgeType(ref),
        criticality: 'degraded',
        metadata: { backstage_ref: ref },
      });
    }
  }

  // Third pass: consumesApis → find provider via index → create edges
  for (const entity of components) {
    const sourceNs = entity.metadata.namespace || 'default';
    const sourceId = makeNodeId(sourceNs, entity.metadata.name);

    for (const apiRef of entity.spec?.consumesApis || []) {
      const providerId = apiProviderIndex.get(apiRef.toLowerCase());
      if (!providerId || providerId === sourceId) continue;

      // Avoid duplicate edges
      const exists = dependencies.some(d => d.source === sourceId && d.target === providerId);
      if (exists) continue;

      dependencies.push({
        source: sourceId,
        target: providerId,
        type: 'sync',
        criticality: 'degraded',
        metadata: { backstage_api_ref: apiRef },
      });
    }
  }

  return {
    config: { services, dependencies },
    stats: {
      componentsFound: components.length,
      resourcesFound: resources.length,
      servicesCreated: services.length,
      dependenciesCreated: dependencies.length,
      skippedEntities,
    },
  };
}

function buildTags(entity: BackstageEntity, kind: string): string[] {
  const tags: string[] = [];
  tags.push(`backstage-kind:${kind}`);
  if (entity.spec?.lifecycle) tags.push(`lifecycle:${entity.spec.lifecycle}`);
  if (entity.spec?.type) tags.push(`backstage-type:${entity.spec.type}`);
  if (entity.metadata.tags) tags.push(...entity.metadata.tags);
  return tags;
}

function buildMetadata(entity: BackstageEntity): Record<string, unknown> {
  return {
    backstage_namespace: entity.metadata.namespace || 'default',
    backstage_kind: entity.kind?.toLowerCase(),
    backstage_type: entity.spec?.type,
    backstage_lifecycle: entity.spec?.lifecycle,
    backstage_system: entity.spec?.system,
    backstage_description: entity.metadata.description,
  };
}

// ── Top-level orchestrator ──

export async function importFromBackstage(
  request: BackstageImportRequest,
): Promise<{ config: GraphConfig; stats: BackstageImportStats }> {
  const { base_url, api_token, options } = request;

  const [components, resources] = await Promise.all([
    fetchBackstageEntities(base_url, api_token, 'component', options),
    fetchBackstageEntities(base_url, api_token, 'resource', options),
  ]);

  return convertEntitiesToGraphConfig(components, resources);
}

// ── Custom error for upstream failures ──

export class BackstageApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'BackstageApiError';
  }
}
