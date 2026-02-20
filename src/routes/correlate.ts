/**
 * Correlation Route — Correlate changes with incidents
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';

const CorrelateSchema = z.object({
  affected_services: z.array(z.string()).min(1),
  incident_time: z.string().optional(),
  window_minutes: z.number().optional(),
  max_results: z.number().optional(),
  min_score: z.number().optional(),
});

export async function correlateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/correlate', async (request, reply) => {
    const parsed = CorrelateSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const { affected_services, incident_time, window_minutes, max_results, min_score } = parsed.data;

    const correlations = fastify.correlator.correlateWithIncident(
      affected_services,
      incident_time || new Date().toISOString(),
      {
        windowMinutes: window_minutes,
        maxResults: max_results,
        minScore: min_score,
      }
    );

    return reply.send({
      correlations,
      query: {
        affectedServices: affected_services,
        incidentTime: incident_time || new Date().toISOString(),
        windowMinutes: window_minutes || 120,
      },
    });
  });
}
