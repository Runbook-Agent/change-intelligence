/**
 * Change Set Route — Groups related events into deployment/release units.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';
import { groupEventsIntoChangeSets } from '../change-sets';

const ChangeSetsQuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  services: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  bucket_minutes: z.coerce.number().int().min(1).max(120).optional(),
});

export async function changeSetRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/change-sets', async (request, reply) => {
    const parsed = ChangeSetsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const services = parsed.data.services?.split(',').map(v => v.trim()).filter(Boolean);
    const events = fastify.store.query({
      services,
      since: parsed.data.since,
      until: parsed.data.until,
      limit: parsed.data.limit || 200,
    });

    const changeSets = groupEventsIntoChangeSets(events, fastify.serviceGraph, {
      bucketMinutes: parsed.data.bucket_minutes,
    });

    return reply.send({
      changeSets,
      query: {
        since: parsed.data.since,
        until: parsed.data.until,
        services: services || [],
        limit: parsed.data.limit || 200,
        bucketMinutes: parsed.data.bucket_minutes || 15,
      },
    });
  });
}
