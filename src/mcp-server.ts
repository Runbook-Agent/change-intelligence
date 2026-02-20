/**
 * MCP Server — Model Context Protocol interface for AI agents
 *
 * Exposes Change Intelligence capabilities as MCP tools via stdio transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ChangeEventStore } from './store';
import { ServiceGraph, createServiceGraph } from './service-graph';
import { ChangeCorrelator } from './correlator';
import { BlastRadiusAnalyzer } from './blast-radius';

export async function startMcpServer(): Promise<void> {
  const dbPath = process.env.CHANGE_INTEL_DB_PATH || 'changes.db';
  const store = new ChangeEventStore(dbPath);
  const graph = createServiceGraph();
  const correlator = new ChangeCorrelator(store, graph);
  const analyzer = new BlastRadiusAnalyzer(graph);

  const server = new McpServer({
    name: 'change-intelligence',
    version: '0.1.0',
  });

  // Tool: query_change_events
  server.tool(
    'query_change_events',
    'Query change events with filters (services, changeTypes, environment, since, until, etc.)',
    {
      services: z.string().optional().describe('Comma-separated service names'),
      changeTypes: z.string().optional().describe('Comma-separated change types'),
      environment: z.string().optional(),
      since: z.string().optional().describe('ISO 8601 datetime'),
      until: z.string().optional().describe('ISO 8601 datetime'),
      initiator: z.string().optional(),
      status: z.string().optional(),
      q: z.string().optional().describe('Full-text search query'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async (args) => {
      if (args.q) {
        const results = store.search(args.q, args.limit || 20);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
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

      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  // Tool: correlate_changes
  server.tool(
    'correlate_changes',
    'Correlate changes with an incident. Given affected services and a time, find the most likely causal changes.',
    {
      affected_services: z.string().describe('Comma-separated list of affected service names'),
      incident_time: z.string().optional().describe('ISO 8601 datetime (default: now)'),
      window_minutes: z.number().optional().describe('Time window in minutes (default: 120)'),
      max_results: z.number().optional().describe('Max correlations to return (default: 20)'),
      min_score: z.number().optional().describe('Minimum correlation score (default: 0.1)'),
    },
    async (args) => {
      const services = args.affected_services.split(',').filter(Boolean);
      const correlations = correlator.correlateWithIncident(
        services,
        args.incident_time || new Date().toISOString(),
        {
          windowMinutes: args.window_minutes,
          maxResults: args.max_results,
          minScore: args.min_score,
        },
      );

      return { content: [{ type: 'text', text: JSON.stringify(correlations, null, 2) }] };
    },
  );

  // Tool: predict_blast_radius
  server.tool(
    'predict_blast_radius',
    'Predict the blast radius (impact) of a change to given services using the service dependency graph.',
    {
      services: z.string().describe('Comma-separated list of service names being changed'),
      change_type: z.string().optional().describe('Type of change (deployment, config_change, etc.)'),
      max_depth: z.number().optional().describe('Max graph traversal depth'),
    },
    async (args) => {
      const services = args.services.split(',').filter(Boolean);
      const prediction = analyzer.predict(services, args.change_type, {
        maxDepth: args.max_depth,
      });

      return { content: [{ type: 'text', text: JSON.stringify(prediction, null, 2) }] };
    },
  );

  // Tool: get_change_velocity
  server.tool(
    'get_change_velocity',
    'Get change velocity metrics for a service: count, types breakdown, and average interval.',
    {
      service: z.string().describe('Service name'),
      window_minutes: z.number().optional().describe('Time window in minutes (default: 60)'),
      periods: z.number().optional().describe('Number of periods for trend (0 = single window)'),
    },
    async (args) => {
      const windowMinutes = args.window_minutes || 60;
      const periods = args.periods || 0;

      if (periods > 0) {
        const trend = store.getVelocityTrend(args.service, windowMinutes, periods);
        return { content: [{ type: 'text', text: JSON.stringify({ trend }, null, 2) }] };
      }

      const velocity = store.getVelocity(args.service, windowMinutes);
      return { content: [{ type: 'text', text: JSON.stringify(velocity, null, 2) }] };
    },
  );

  // Tool: import_graph
  server.tool(
    'import_graph',
    'Import a service dependency graph from a JSON config with services and dependencies arrays.',
    {
      config: z.string().describe('JSON string with { services: [...], dependencies: [...] }'),
    },
    async (args) => {
      const { loadGraphFromJson, mergeGraph } = await import('./graph-loader');
      const config = JSON.parse(args.config);
      const incoming = loadGraphFromJson(config);
      mergeGraph(graph, incoming, 'mcp-import');
      const stats = graph.getStats();

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Graph imported', stats }, null, 2) }] };
    },
  );

  // Tool: list_services
  server.tool(
    'list_services',
    'List all services currently loaded in the service dependency graph.',
    {},
    async () => {
      const services = graph.getAllServices().map(s => ({
        id: s.id,
        name: s.name,
        type: s.type,
        tier: s.tier,
        team: s.team,
        tags: s.tags,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({ services }, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
