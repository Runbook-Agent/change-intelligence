/**
 * Velocity Route — Change velocity tracking
 */

import type { FastifyInstance } from 'fastify';

export async function velocityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/velocity/:service', async (request, reply) => {
    const { service } = request.params as { service: string };
    const query = request.query as Record<string, string | undefined>;

    const windowMinutes = query.window_minutes ? parseInt(query.window_minutes, 10) : 60;
    const periods = query.periods ? parseInt(query.periods, 10) : 0;

    if (periods > 0) {
      const trend = fastify.store.getVelocityTrend(service, windowMinutes, periods);
      return reply.send({ trend });
    }

    const velocity = fastify.store.getVelocity(service, windowMinutes);
    return reply.send(velocity);
  });
}
