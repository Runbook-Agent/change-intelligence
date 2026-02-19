/**
 * Graph Routes — Service graph management
 */

import type { FastifyInstance } from 'fastify';
import { loadGraphFromJson, mergeGraph } from '../graph-loader';
import { BackstageImportRequestSchema, BackstageApiError, importFromBackstage } from '../backstage-client';

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
      return reply.status(400).send({
        error: 'Failed to import graph',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/v1/graph/import/backstage — Import from Backstage catalog
  fastify.post('/api/v1/graph/import/backstage', async (request, reply) => {
    const parsed = BackstageImportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues,
      });
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
        return reply.status(502).send({
          error: 'Backstage API error',
          details: error.message,
        });
      }
      return reply.status(500).send({
        error: 'Internal error during Backstage import',
        details: error instanceof Error ? error.message : String(error),
      });
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
      return reply.status(404).send({ error: `Service '${service}' not found in graph` });
    }

    const dependencies = fastify.serviceGraph.getDependencies(service).map(s => s.id);
    const dependents = fastify.serviceGraph.getDependents(service).map(s => s.id);

    return reply.send({
      service: { id: node.id, name: node.name, type: node.type, tier: node.tier },
      dependencies,
      dependents,
    });
  });

  // POST /api/v1/graph/discover — Auto-discovery stub
  fastify.post('/api/v1/graph/discover', async (_request, reply) => {
    return reply.status(501).send({
      message: 'Auto-discovery is not yet implemented. Use POST /api/v1/graph/import to load a graph manually.',
    });
  });

  // GET /api/v1/graph/suggestions — Inferred relationship suggestions stub
  fastify.get('/api/v1/graph/suggestions', async (_request, reply) => {
    return reply.send({
      suggestions: [],
      message: 'Inferred relationship suggestions are not yet implemented.',
    });
  });
}
