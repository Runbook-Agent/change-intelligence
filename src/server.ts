/**
 * Change Intelligence Service — Fastify Server
 *
 * Entry point for the service. Initializes store, graph, correlator,
 * analyzer, and registers all routes.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'fs';
import { join } from 'path';

import { ChangeEventStore } from './store';
import { ServiceGraph, createServiceGraph } from './service-graph';
import { ChangeCorrelator } from './correlator';
import { BlastRadiusAnalyzer } from './blast-radius';
import { loadGraphFromYaml, loadGraphFromJson } from './graph-loader';
import { WebhookRegistrationStore } from './webhook-store';
import { WebhookDispatcher } from './webhook-dispatcher';

import { eventsRoutes } from './routes/events';
import { batchRoutes } from './routes/batch';
import { correlateRoutes } from './routes/correlate';
import { blastRadiusRoutes } from './routes/blast-radius';
import { velocityRoutes } from './routes/velocity';
import { graphRoutes } from './routes/graph';
import { githubWebhookRoutes } from './routes/webhooks/github';
import { awsWebhookRoutes } from './routes/webhooks/aws';
import { agentWebhookRoutes } from './routes/webhooks/agent';
import { gitlabWebhookRoutes } from './routes/webhooks/gitlab';
import { terraformWebhookRoutes } from './routes/webhooks/terraform';
import { kubernetesWebhookRoutes } from './routes/webhooks/kubernetes';
import { webhookRegistrationRoutes } from './routes/webhook-registrations';
import { openapiRoutes } from './routes/openapi';

// Extend Fastify with our service decorations
declare module 'fastify' {
  interface FastifyInstance {
    store: ChangeEventStore;
    serviceGraph: ServiceGraph;
    correlator: ChangeCorrelator;
    blastRadiusAnalyzer: BlastRadiusAnalyzer;
    webhookRegistrationStore: WebhookRegistrationStore;
    webhookDispatcher: WebhookDispatcher;
  }
}

export interface ServerOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  graphPath?: string;
  graphData?: object;
}

export async function createServer(options?: ServerOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Initialize store
  const dbPath = options?.dbPath || process.env.CHANGE_INTEL_DB_PATH || 'changes.db';
  const store = new ChangeEventStore(dbPath);

  // Initialize service graph
  let graph: ServiceGraph;
  const graphPath = options?.graphPath || process.env.CHANGE_INTEL_GRAPH_PATH;

  if (graphPath && existsSync(graphPath)) {
    fastify.log.info({ graphPath }, 'Loading service graph from file');
    graph = loadGraphFromYaml(graphPath);
  } else if (options?.graphData) {
    graph = loadGraphFromJson(options.graphData);
  } else {
    graph = createServiceGraph();
  }

  // Initialize correlator + analyzer
  const correlator = new ChangeCorrelator(store, graph);
  const analyzer = new BlastRadiusAnalyzer(graph);

  // Initialize webhook registration store + dispatcher
  const webhookRegistrationStore = new WebhookRegistrationStore(store.getDb());
  const webhookDispatcher = new WebhookDispatcher(webhookRegistrationStore);

  // Decorate Fastify instance
  fastify.decorate('store', store);
  fastify.decorate('serviceGraph', graph);
  fastify.decorate('correlator', correlator);
  fastify.decorate('blastRadiusAnalyzer', analyzer);
  fastify.decorate('webhookRegistrationStore', webhookRegistrationStore);
  fastify.decorate('webhookDispatcher', webhookDispatcher);

  // CORS
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (request.method === 'OPTIONS') {
      return reply.status(204).send();
    }
  });

  // Health check
  fastify.get('/api/v1/health', async (_request, reply) => {
    const stats = store.getStats();
    const graphStats = graph.getStats();
    return reply.send({
      status: 'healthy',
      version: '0.1.0',
      store: { totalEvents: stats.total },
      graph: { services: graphStats.nodeCount, edges: graphStats.edgeCount },
    });
  });

  // Register routes
  await fastify.register(eventsRoutes);
  await fastify.register(batchRoutes);
  await fastify.register(correlateRoutes);
  await fastify.register(blastRadiusRoutes);
  await fastify.register(velocityRoutes);
  await fastify.register(graphRoutes);
  await fastify.register(githubWebhookRoutes);
  await fastify.register(awsWebhookRoutes);
  await fastify.register(agentWebhookRoutes);
  await fastify.register(gitlabWebhookRoutes);
  await fastify.register(terraformWebhookRoutes);
  await fastify.register(kubernetesWebhookRoutes);
  await fastify.register(webhookRegistrationRoutes);
  await fastify.register(openapiRoutes);

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    store.close();
  });

  return fastify;
}

// CLI entry point
async function main() {
  const host = process.env.HOST || '0.0.0.0';
  const port = parseInt(process.env.PORT || '3001', 10);

  const server = await createServer({ host, port });

  try {
    await server.listen({ host, port });
    server.log.info(`Change Intelligence Service running on http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Run if invoked directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
