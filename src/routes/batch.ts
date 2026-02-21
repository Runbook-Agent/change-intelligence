/**
 * Batch Event Route — Ingest multiple change events atomically
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';

const CreateEventSchema = z.object({
  service: z.string().min(1),
  changeType: z.enum([
    'deployment',
    'config_change',
    'infra_modification',
    'feature_flag',
    'db_migration',
    'code_change',
    'rollback',
    'scaling',
    'security_patch',
  ]).default('deployment'),
  summary: z.string().min(1),
  additionalServices: z.array(z.string()).optional(),
  source: z.enum([
    'github',
    'gitlab',
    'aws_codepipeline',
    'aws_ecs',
    'aws_lambda',
    'kubernetes',
    'claude_hook',
    'agent_hook',
    'manual',
    'terraform',
  ]).optional(),
  initiator: z.enum(['human', 'agent', 'automation', 'unknown']).optional(),
  initiatorIdentity: z.string().optional(),
  status: z.enum(['in_progress', 'completed', 'failed', 'rolled_back']).optional(),
  environment: z.string().optional(),
  commitSha: z.string().optional(),
  prNumber: z.string().optional(),
  prUrl: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  diff: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  configKeys: z.array(z.string()).optional(),
  authorType: z.enum(['human', 'ai_assisted', 'autonomous_agent']).optional(),
  reviewModel: z.string().optional(),
  humanReviewCount: z.number().int().min(0).optional(),
  testSignal: z.enum(['passed', 'failed', 'partial', 'unknown']).optional(),
  changeSetId: z.string().optional(),
  canonicalUrl: z.string().url().optional(),
  previousVersion: z.string().optional(),
  newVersion: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

const BatchSchema = z.object({
  events: z.array(CreateEventSchema).min(1).max(1000),
});

export async function batchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/events/batch', async (request, reply) => {
    const parsed = BatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const store = fastify.store;
    const results: { index: number; id: string; status: 'created' | 'duplicate'; event: unknown }[] = [];
    let created = 0;
    let duplicates = 0;

    store.transaction(() => {
      for (let i = 0; i < parsed.data.events.length; i++) {
        const eventData = parsed.data.events[i];

        // Check idempotency
        if (eventData.idempotencyKey) {
          const existing = store.getByIdempotencyKey(eventData.idempotencyKey);
          if (existing) {
            results.push({ index: i, id: existing.id, status: 'duplicate', event: existing });
            duplicates++;
            continue;
          }
        }

        const event = store.insert(eventData);

        // Auto-compute blast radius
        if (fastify.blastRadiusAnalyzer) {
          const services = [event.service, ...(event.additionalServices || [])];
          const prediction = fastify.blastRadiusAnalyzer.predict(services, event.changeType);
          store.update(event.id, { blastRadius: prediction });
          event.blastRadius = prediction;
        }

        // Dispatch to registered webhooks
        fastify.webhookDispatcher.dispatch(event, fastify.log);

        results.push({ index: i, id: event.id, status: 'created', event });
        created++;
      }
    });

    const statusCode = created > 0 ? 201 : 200;
    return reply.status(statusCode).send({
      results,
      stats: { total: parsed.data.events.length, created, duplicates },
    });
  });
}
