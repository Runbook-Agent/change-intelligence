/**
 * Blast Radius Route — Predict impact of changes
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';

const BlastRadiusSchema = z.object({
  services: z.array(z.string()).min(1),
  change_type: z.string().optional(),
  max_depth: z.number().optional(),
});

export async function blastRadiusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/blast-radius', async (request, reply) => {
    const parsed = BlastRadiusSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const { services, change_type, max_depth } = parsed.data;

    const prediction = fastify.blastRadiusAnalyzer.predict(
      services,
      change_type,
      { maxDepth: max_depth }
    );

    return reply.send(prediction);
  });
}
