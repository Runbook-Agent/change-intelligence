import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { ChangeEventStore } from '../store';
import { ServiceGraph, createServiceGraph } from '../service-graph';
import { ChangeCorrelator } from '../correlator';
import { BlastRadiusAnalyzer } from '../blast-radius';
import { loadGraphFromJson, mergeGraph } from '../graph-loader';

function tmpDb() {
  return join(tmpdir(), `test-mcp-${randomUUID()}.db`);
}

/**
 * Creates an MCP server with the same tools as src/mcp-server.ts but
 * wired to a test-specific store/graph for isolation.
 */
function createTestMcpServer(store: ChangeEventStore, graph: ServiceGraph) {
  const correlator = new ChangeCorrelator(store, graph);
  const analyzer = new BlastRadiusAnalyzer(graph);

  const server = new McpServer({
    name: 'change-intelligence-test',
    version: '0.1.0',
  });

  server.tool(
    'query_change_events',
    'Query change events',
    {
      services: z.string().optional(),
      changeTypes: z.string().optional(),
      environment: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      initiator: z.string().optional(),
      status: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      if (args.q) {
        const results = store.search(args.q, args.limit || 20);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      }
      const results = store.query({
        services: args.services?.split(',').filter(Boolean),
        changeTypes: args.changeTypes?.split(',').filter(Boolean) as any,
        environment: args.environment,
        since: args.since,
        until: args.until,
        initiator: args.initiator as any,
        status: args.status as any,
        limit: args.limit,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    },
  );

  server.tool(
    'correlate_changes',
    'Correlate changes with an incident',
    {
      affected_services: z.string(),
      incident_time: z.string().optional(),
      window_minutes: z.number().optional(),
      max_results: z.number().optional(),
      min_score: z.number().optional(),
    },
    async (args) => {
      const services = args.affected_services.split(',').filter(Boolean);
      const correlations = correlator.correlateWithIncident(
        services,
        args.incident_time || new Date().toISOString(),
        { windowMinutes: args.window_minutes, maxResults: args.max_results, minScore: args.min_score },
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(correlations, null, 2) }] };
    },
  );

  server.tool(
    'predict_blast_radius',
    'Predict blast radius',
    {
      services: z.string(),
      change_type: z.string().optional(),
      max_depth: z.number().optional(),
    },
    async (args) => {
      const services = args.services.split(',').filter(Boolean);
      const prediction = analyzer.predict(services, args.change_type, { maxDepth: args.max_depth });
      return { content: [{ type: 'text' as const, text: JSON.stringify(prediction, null, 2) }] };
    },
  );

  server.tool(
    'get_change_velocity',
    'Get change velocity',
    {
      service: z.string(),
      window_minutes: z.number().optional(),
      periods: z.number().optional(),
    },
    async (args) => {
      const windowMinutes = args.window_minutes || 60;
      const periods = args.periods || 0;
      if (periods > 0) {
        const trend = store.getVelocityTrend(args.service, windowMinutes, periods);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ trend }, null, 2) }] };
      }
      const velocity = store.getVelocity(args.service, windowMinutes);
      return { content: [{ type: 'text' as const, text: JSON.stringify(velocity, null, 2) }] };
    },
  );

  server.tool(
    'import_graph',
    'Import service graph',
    { config: z.string() },
    async (args) => {
      const config = JSON.parse(args.config);
      const incoming = loadGraphFromJson(config);
      mergeGraph(graph, incoming, 'mcp-import');
      const stats = graph.getStats();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Graph imported', stats }, null, 2) }] };
    },
  );

  server.tool(
    'list_services',
    'List all services',
    {},
    async () => {
      const services = graph.getAllServices().map(s => ({ id: s.id, name: s.name, type: s.type, tier: s.tier }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ services }, null, 2) }] };
    },
  );

  return server;
}

describe('MCP Server', () => {
  let store: ChangeEventStore;
  let graph: ServiceGraph;
  let mcpServer: McpServer;
  let client: Client;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    store = new ChangeEventStore(dbPath);
    graph = createServiceGraph();

    mcpServer = createTestMcpServer(store, graph);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    store.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('lists 6 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'correlate_changes',
      'get_change_velocity',
      'import_graph',
      'list_services',
      'predict_blast_radius',
      'query_change_events',
    ]);
  });

  it('query_change_events returns events', async () => {
    store.insert({ service: 'api', changeType: 'deployment', summary: 'Deploy v1' });
    store.insert({ service: 'db', changeType: 'db_migration', summary: 'Migrate schema' });

    const result = await client.callTool({ name: 'query_change_events', arguments: {} });
    const text = (result.content as any)[0].text;
    const events = JSON.parse(text);
    expect(events).toHaveLength(2);
  });

  it('correlate_changes returns correlations', async () => {
    // Add a service to graph first
    const incoming = loadGraphFromJson({
      services: [{ id: 'api', name: 'API', type: 'service', tags: [] }],
      dependencies: [],
    });
    mergeGraph(graph, incoming, 'test');

    store.insert({ service: 'api', changeType: 'deployment', summary: 'Deploy v1' });

    const result = await client.callTool({
      name: 'correlate_changes',
      arguments: { affected_services: 'api' },
    });
    const text = (result.content as any)[0].text;
    const correlations = JSON.parse(text);
    expect(Array.isArray(correlations)).toBe(true);
  });

  it('predict_blast_radius returns prediction', async () => {
    const incoming = loadGraphFromJson({
      services: [
        { id: 'api', name: 'API', type: 'service', tags: [] },
        { id: 'db', name: 'DB', type: 'database', tags: [] },
      ],
      dependencies: [{ source: 'api', target: 'db', type: 'database', criticality: 'critical' }],
    });
    mergeGraph(graph, incoming, 'test');

    const result = await client.callTool({
      name: 'predict_blast_radius',
      arguments: { services: 'db' },
    });
    const text = (result.content as any)[0].text;
    const prediction = JSON.parse(text);
    expect(prediction.riskLevel).toBeDefined();
    expect(prediction.directServices).toBeDefined();
  });

  it('import_graph adds services to graph', async () => {
    const config = JSON.stringify({
      services: [
        { id: 'svc-a', name: 'Service A', type: 'service', tags: [] },
        { id: 'svc-b', name: 'Service B', type: 'service', tags: [] },
      ],
      dependencies: [],
    });

    const result = await client.callTool({
      name: 'import_graph',
      arguments: { config },
    });
    const text = (result.content as any)[0].text;
    const response = JSON.parse(text);
    expect(response.stats.nodeCount).toBe(2);
  });

  it('list_services returns services from graph', async () => {
    const incoming = loadGraphFromJson({
      services: [
        { id: 'api', name: 'API', type: 'service', tags: [] },
        { id: 'db', name: 'DB', type: 'database', tags: [] },
      ],
      dependencies: [],
    });
    mergeGraph(graph, incoming, 'test');

    const result = await client.callTool({ name: 'list_services', arguments: {} });
    const text = (result.content as any)[0].text;
    const response = JSON.parse(text);
    expect(response.services).toHaveLength(2);
    expect(response.services.map((s: any) => s.id).sort()).toEqual(['api', 'db']);
  });
});
