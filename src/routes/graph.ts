/**
 * Graph Routes — Service graph management
 */

import type { FastifyInstance } from 'fastify';
import { loadGraphFromJson, mergeGraph } from '../graph-loader';
import { BackstageImportRequestSchema, BackstageApiError, importFromBackstage } from '../backstage-client';
import { validationError, notFoundError, badGatewayError, internalError, notImplementedError } from '../errors';

export async function graphRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/graph/import — Import service graph (JSON or config format)
  fastify.post('/api/v1/graph/import', async (request, reply) => {
    try {
      const incoming = loadGraphFromJson(request.body);
      mergeGraph(fastify.serviceGraph, incoming, 'import');
      const stats = fastify.serviceGraph.getStats();
      return reply.send({
        message: 'Graph imported successfully',
        stats,
      });
    } catch (error) {
      return validationError(reply, error instanceof Error ? error.message : String(error));
    }
  });

  // POST /api/v1/graph/import/backstage — Import from Backstage catalog
  fastify.post('/api/v1/graph/import/backstage', async (request, reply) => {
    const parsed = BackstageImportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    try {
      const { config, stats } = await importFromBackstage(parsed.data);
      const incoming = loadGraphFromJson(config);
      mergeGraph(fastify.serviceGraph, incoming, 'backstage');
      const graphStats = fastify.serviceGraph.getStats();

      return reply.send({
        message: 'Backstage catalog imported successfully',
        import_stats: stats,
        graph_stats: graphStats,
      });
    } catch (error) {
      if (error instanceof BackstageApiError) {
        return badGatewayError(reply, 'Backstage', error.message);
      }
      return internalError(reply, error instanceof Error ? error.message : String(error));
    }
  });

  // GET /api/v1/graph/services — List services in graph
  fastify.get('/api/v1/graph/services', async (_request, reply) => {
    const services = fastify.serviceGraph.getAllServices().map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      tier: s.tier,
      team: s.team,
      tags: s.tags,
    }));
    return reply.send({ services });
  });

  // GET /api/v1/graph/dependencies/:service — Get deps + dependents
  fastify.get('/api/v1/graph/dependencies/:service', async (request, reply) => {
    const { service } = request.params as { service: string };
    const node = fastify.serviceGraph.getService(service);
    if (!node) {
      return notFoundError(reply, 'Service', service);
    }

    const dependencies = fastify.serviceGraph.getDependencies(service).map(s => s.id);
    const dependents = fastify.serviceGraph.getDependents(service).map(s => s.id);
    const dependencyDetails = fastify.serviceGraph.getOutgoingEdges(service).map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      criticality: edge.criticality,
      edgeSource: edge.edgeSource,
      confidence: edge.confidence,
      lastSeen: edge.lastSeen,
    }));
    const dependentDetails = fastify.serviceGraph.getIncomingEdges(service).map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      criticality: edge.criticality,
      edgeSource: edge.edgeSource,
      confidence: edge.confidence,
      lastSeen: edge.lastSeen,
    }));

    return reply.send({
      service: { id: node.id, name: node.name, type: node.type, tier: node.tier },
      dependencies,
      dependents,
      dependencyDetails,
      dependentDetails,
    });
  });

  // POST /api/v1/graph/discover — Auto-discovery stub
  fastify.post('/api/v1/graph/discover', async (_request, reply) => {
    return notImplementedError(reply, 'Auto-discovery', 'Use POST /api/v1/graph/import to load a graph manually.');
  });

  // GET /api/v1/graph/suggestions — Inferred relationship suggestions stub
  fastify.get('/api/v1/graph/suggestions', async (_request, reply) => {
    return reply.send({
      suggestions: [],
      message: 'Inferred relationship suggestions are not yet implemented.',
    });
  });
}
