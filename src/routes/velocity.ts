/**
 * Velocity Route — Change velocity tracking
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';

const VelocityQuerySchema = z.object({
  window_minutes: z.coerce.number().int().min(1).max(10_080).optional(),
  periods: z.coerce.number().int().min(0).max(100).optional(),
});

export async function velocityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/velocity/:service', async (request, reply) => {
    const { service } = request.params as { service: string };
    const parsed = VelocityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const windowMinutes = parsed.data.window_minutes ?? 60;
    const periods = parsed.data.periods ?? 0;

    if (periods > 0) {
      const trend = fastify.store.getVelocityTrend(service, windowMinutes, periods);
      return reply.send({ trend });
    }

    const velocity = fastify.store.getVelocity(service, windowMinutes);
    return reply.send(velocity);
  });
}
