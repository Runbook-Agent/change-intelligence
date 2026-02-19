/**
 * Events Routes — CRUD + query for change events
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const CreateEventSchema = z.object({
  service: z.string().min(1),
  changeType: z.string().default('deployment'),
  summary: z.string().min(1),
  additionalServices: z.array(z.string()).optional(),
  source: z.string().optional(),
  initiator: z.string().optional(),
  initiatorIdentity: z.string().optional(),
  status: z.string().optional(),
  environment: z.string().optional(),
  commitSha: z.string().optional(),
  prNumber: z.string().optional(),
  prUrl: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  diff: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  configKeys: z.array(z.string()).optional(),
  previousVersion: z.string().optional(),
  newVersion: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().optional(),
});

const UpdateEventSchema = z.object({
  status: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  blastRadius: z.unknown().optional(),
}).passthrough();

export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/events — Create event
  fastify.post('/api/v1/events', async (request, reply) => {
    const parsed = CreateEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const store = fastify.store;
    const event = store.insert(parsed.data);

    // Optionally compute blast radius if graph is available
    if (fastify.blastRadiusAnalyzer) {
      const services = [event.service, ...(event.additionalServices || [])];
      const prediction = fastify.blastRadiusAnalyzer.predict(services, event.changeType);
      store.update(event.id, { blastRadius: prediction });
      event.blastRadius = prediction;
    }

    return reply.status(201).send(event);
  });

  // GET /api/v1/events — Query events
  fastify.get('/api/v1/events', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;

    const options = {
      services: query.services?.split(',').filter(Boolean),
      changeTypes: query.change_types?.split(',').filter(Boolean) as import('../types').ChangeType[] | undefined,
      sources: query.sources?.split(',').filter(Boolean) as import('../types').ChangeSource[] | undefined,
      environment: query.environment,
      since: query.since,
      until: query.until,
      initiator: query.initiator as import('../types').ChangeInitiator | undefined,
      status: query.status as import('../types').ChangeStatus | undefined,
      query: query.q,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    };

    if (options.query) {
      const results = fastify.store.search(options.query, options.limit || 20);
      return reply.send(results);
    }

    const results = fastify.store.query(options);
    return reply.send(results);
  });

  // GET /api/v1/events/:id — Get event by ID
  fastify.get('/api/v1/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const event = fastify.store.get(id);
    if (!event) {
      return reply.status(404).send({ error: 'Event not found' });
    }
    return reply.send(event);
  });

  // PATCH /api/v1/events/:id — Update event
  fastify.patch('/api/v1/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues });
    }

    const updated = fastify.store.update(id, parsed.data);
    if (!updated) {
      return reply.status(404).send({ error: 'Event not found' });
    }
    return reply.send(updated);
  });

  // DELETE /api/v1/events/:id — Delete event
  fastify.delete('/api/v1/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = fastify.store.delete(id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Event not found' });
    }
    return reply.status(204).send();
  });
}
