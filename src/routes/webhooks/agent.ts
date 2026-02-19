/**
 * Coding Agent Webhook — Receives events from Claude Code, Copilot, Cursor, etc.
 *
 * Bearer token auth via Authorization header, verified against AGENT_WEBHOOK_SECRET.
 */

import type { FastifyInstance } from 'fastify';
import type { ChangeType } from '../../types';
import { z } from 'zod';

const AgentPayloadSchema = z.object({
  agent: z.string().min(1),
  action: z.string().min(1),
  service: z.string().min(1),
  summary: z.string().min(1),
  session_id: z.string().optional(),
  parent_event_id: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  commit_sha: z.string().optional(),
  environment: z.string().optional(),
  files_changed: z.array(z.string()).optional(),
  tool_calls: z.array(z.unknown()).optional(),
  reasoning: z.string().optional(),
  diff: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  change_type: z.string().optional(),
  additional_services: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function agentWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/agent', async (request, reply) => {
    const secret = process.env.AGENT_WEBHOOK_SECRET;

    // Verify bearer token if secret is configured
    if (secret) {
      const authHeader = request.headers.authorization as string | undefined;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
      }
      const token = authHeader.slice(7);
      if (token !== secret) {
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }

    const parsed = AgentPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const data = parsed.data;

    try {
      // Determine source based on agent name
      const source = data.agent.toLowerCase() === 'claude-code' ? 'claude_hook' : 'agent_hook';

      // Map action to change type
      const changeType = (data.change_type || mapActionToChangeType(data.action)) as ChangeType;

      // Build metadata
      const metadata: Record<string, unknown> = {
        ...data.metadata,
        agent: data.agent,
        action: data.action,
      };
      if (data.session_id) metadata.session_id = data.session_id;
      if (data.parent_event_id) metadata.parent_event_id = data.parent_event_id;
      if (data.tool_calls) metadata.tool_calls = data.tool_calls;
      if (data.reasoning) metadata.reasoning = data.reasoning;
      if (data.confidence !== undefined) metadata.confidence = data.confidence;

      // Build tags with auto-tags
      const tags = [...(data.tags || []), 'agent', data.agent.toLowerCase()];

      const event = fastify.store.insert({
        service: data.service,
        additionalServices: data.additional_services,
        changeType,
        source,
        initiator: 'agent',
        initiatorIdentity: data.agent,
        status: 'completed',
        environment: data.environment || 'development',
        commitSha: data.commit_sha,
        repository: data.repository,
        branch: data.branch,
        summary: data.summary,
        diff: data.diff,
        filesChanged: data.files_changed,
        tags,
        metadata,
      });

      // Auto-compute blast radius
      if (fastify.blastRadiusAnalyzer) {
        const services = [event.service, ...(event.additionalServices || [])];
        const prediction = fastify.blastRadiusAnalyzer.predict(services, event.changeType);
        fastify.store.update(event.id, { blastRadius: prediction });
        event.blastRadius = prediction;
      }

      return reply.status(201).send({ id: event.id, message: 'Event ingested' });
    } catch (error) {
      fastify.log.error(error, 'Failed to process agent webhook');
      return reply.status(500).send({ error: 'Failed to process webhook' });
    }
  });
}

function mapActionToChangeType(action: string): string {
  switch (action.toLowerCase()) {
    case 'commit':
    case 'file_edit':
    case 'refactor':
      return 'code_change';
    case 'deployment':
    case 'deploy':
      return 'deployment';
    case 'config_change':
      return 'config_change';
    default:
      return 'code_change';
  }
}
